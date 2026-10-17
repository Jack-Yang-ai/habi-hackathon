#!/usr/bin/env python3
"""Device-only HTTP connector; no camera emulation or microphone in this service."""
import argparse
import glob
import getpass
import hmac
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlencode, urlsplit

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_TOKEN = ROOT / '.tools/esp32/device-token'
ID = re.compile(r'^[A-Za-z0-9_.:-]{1,128}$')
MAX_IMAGE_BODY = 11 * 1024 * 1024
MAX_JSON_BODY = 16 * 1024


def read_token(path=None, env_name='ESP32_CONNECTOR_TOKEN'):
    if path:
        path = Path(path)
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            raise ValueError('token file must be a regular private file (chmod 600)')
        value = path.read_text().strip()
    else:
        value = os.environ.get(env_name, '')
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,256}', value):
        raise ValueError('a 32+ character device token is required; use init-token')
    return value


def private_api_url(value, allow_loopback=False):
    parsed = urlsplit(value)
    if parsed.scheme != 'http' or not parsed.hostname or parsed.username or parsed.password \
            or parsed.path not in ('', '/') or parsed.query or parsed.fragment:
        raise ValueError('use an HTTP origin without credentials, path or query')
    try:
        address = ipaddress.ip_address(parsed.hostname)
    except ValueError as error:
        raise ValueError('use the explicit private IPv4 address of the connector') from error
    if address.version != 4 or not address.is_private or address.is_unspecified \
            or address.is_multicast or address.is_link_local or (address.is_loopback and not allow_loopback):
        raise ValueError('ESP32 needs a reachable private IPv4 address, not loopback or 0.0.0.0')
    if not 1 <= (parsed.port or 80) <= 65535:
        raise ValueError('invalid API port')
    return value.rstrip('/')


def prepare_header(api_base, token, ssid, password, output, replace=False, allow_loopback=False):
    api_base = private_api_url(api_base, allow_loopback)
    if not 1 <= len(ssid.encode()) <= 32 or '\0' in ssid or '\0' in password or len(password.encode()) > 63:
        raise ValueError('invalid Wi-Fi configuration; values are not logged')
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists() and not replace:
        raise ValueError('configuration exists; use --replace only for this intended update')
    content = '#pragma once\n// Local development credentials; excluded from Git.\n'
    for name, value in [('ECHO_WIFI_SSID', ssid), ('ECHO_WIFI_PASSWORD', password),
                        ('ECHO_API_BASE', api_base), ('ECHO_DEVICE_TOKEN', token)]:
        # C++ literals written as data; never interpolated into a shell command.
        content += '#define ' + name + ' ' + json.dumps(value, ensure_ascii=False) + '\n'
    temp = output.with_name(output.name + '.' + secrets.token_hex(6) + '.tmp')
    descriptor = os.open(str(temp), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        if not replace and output.exists():
            raise ValueError('configuration changed while preparing; no overwrite')
        os.replace(str(temp), str(output))
    finally:
        if temp.exists():
            temp.unlink()


class ConnectorServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, address, upstream, device_token, upstream_token=''):
        parsed = urlsplit(upstream)
        if parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1') \
                or parsed.path not in ('', '/') or parsed.query or parsed.fragment or parsed.username:
            raise ValueError('upstream must be a fixed loopback HTTP origin')
        self.upstream_host = parsed.hostname
        self.upstream_port = parsed.port or 80
        self.device_token = device_token
        self.upstream_token = upstream_token
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, ConnectorHandler)


class ConnectorHandler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'EchoDeviceConnector/1'

    def log_message(self, *_args):
        pass  # Do not log headers, query strings, metadata, credentials or images.

    def setup(self):
        super().setup()
        self.connection.settimeout(12)

    def respond(self, code, payload, content_type='application/json'):
        if isinstance(payload, dict):
            payload = json.dumps(payload, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.proxy()

    def do_POST(self):
        self.proxy()

    def proxy(self):
        if not self.server.slots.acquire(blocking=False):
            self.respond(503, {'error': 'connector_busy'})
            return
        try:
            self._proxy()
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            pass
        finally:
            self.server.slots.release()

    def _proxy(self):
        tokens = self.headers.get_all('X-Device-Token', [])
        if len(tokens) != 1 or not hmac.compare_digest(tokens[0].encode('utf8'), self.server.device_token.encode('utf8')):
            self.respond(401, {'error': 'device_authentication_failed'})
            return
        route = urlsplit(self.path)
        if route.scheme or route.netloc or route.fragment:
            self.respond(400, {'error': 'invalid_request_target'})
            return
        target = route.path
        body = b''
        content_type = self.headers.get('Content-Type', '')
        if self.command == 'GET' and target == '/api/device/config':
            query = parse_qs(route.query, keep_blank_values=True)
            if set(query) != {'device_id'} or len(query['device_id']) != 1 or not ID.fullmatch(query['device_id'][0]):
                self.respond(400, {'error': 'invalid_device_id'})
                return
            if self.headers.get('Transfer-Encoding') or self.headers.get('Content-Length', '0') != '0':
                self.respond(400, {'error': 'unexpected_request_body'})
                return
            target += '?' + urlencode({'device_id': query['device_id'][0]})
        elif self.command == 'POST' and target in ('/api/device/status', '/api/device/captures') and not route.query:
            sizes = self.headers.get_all('Content-Length', [])
            if self.headers.get('Transfer-Encoding') or len(sizes) != 1 or not sizes[0].isdigit():
                self.respond(411, {'error': 'one_content_length_required'})
                return
            size = int(sizes[0])
            limit = MAX_IMAGE_BODY if target.endswith('/captures') else MAX_JSON_BODY
            if size < 1 or size > limit:
                self.respond(413, {'error': 'device_payload_size_invalid'})
                return
            valid_type = content_type.startswith('multipart/form-data;') and 'boundary=' in content_type \
                if target.endswith('/captures') else content_type.split(';')[0].strip() == 'application/json'
            if not valid_type:
                self.respond(415, {'error': 'device_content_type_invalid'})
                return
            body = self.rfile.read(size)
            if len(body) != size:
                self.respond(400, {'error': 'incomplete_device_body'})
                return
        else:
            self.respond(404, {'error': 'device_route_not_exposed'})
            return
        upstream = http.client.HTTPConnection(self.server.upstream_host, self.server.upstream_port, timeout=8)
        headers = {'Content-Type': content_type} if body else {}
        if self.server.upstream_token:
            headers['X-Device-Token'] = self.server.upstream_token
        try:
            # http.client never follows redirects; the destination is fixed above.
            upstream.request(self.command, target, body=body or None, headers=headers)
            response = upstream.getresponse()
            payload = response.read(1024 * 1024 + 1)
            if len(payload) > 1024 * 1024 or 300 <= response.status < 400:
                self.respond(502, {'error': 'invalid_upstream_device_response'})
            else:
                self.respond(response.status, payload, response.getheader('Content-Type', 'application/json'))
        except (OSError, http.client.HTTPException):
            self.respond(502, {'error': 'local_api_unreachable'})
        finally:
            upstream.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('inspect', help='List serial ports and credential presence only')
    init = commands.add_parser('init-token')
    init.add_argument('--token-file', type=Path, default=DEFAULT_TOKEN)
    prepare = commands.add_parser('prepare', help='Write ignored secrets.h from environment, without printing credentials')
    prepare.add_argument('--api-base', required=True)
    prepare.add_argument('--token-file', type=Path, default=DEFAULT_TOKEN)
    prepare.add_argument('--output', type=Path, default=ROOT/'firmware/xiao-sense/include/secrets.h')
    prepare.add_argument('--replace', action='store_true')
    prepare.add_argument('--interactive', action='store_true', help='Ask locally for SSID and a hidden Wi-Fi password')
    serve = commands.add_parser('serve', help='Expose exactly three authenticated device routes')
    serve.add_argument('--host', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=8788)
    serve.add_argument('--upstream', default='http://127.0.0.1:8787')
    serve.add_argument('--token-file', type=Path)
    serve.add_argument('--upstream-token-file', type=Path, help='Optional separate private token file for the loopback API')
    args = parser.parse_args()
    try:
        if args.command == 'inspect':
            configured = ROOT/'firmware/xiao-sense/include/secrets.h'
            flags = {}
            text = configured.read_text() if configured.exists() else ''
            for macro in ('ECHO_WIFI_SSID', 'ECHO_WIFI_PASSWORD', 'ECHO_DEVICE_TOKEN'):
                match = re.search(r'^#define\s+'+macro+r'\s+"(.*)"\s*$', text, re.M)
                flags[macro.lower()+'_present'] = bool(match and match[1])
            print(json.dumps({'serial_ports': sorted(glob.glob('/dev/cu.*')), 'local_configuration': flags,
                              'camera_hardware_verified': False, 'no_secrets_printed': True}))
        elif args.command == 'init-token':
            args.token_file.parent.mkdir(parents=True, exist_ok=True)
            with os.fdopen(os.open(str(args.token_file), os.O_CREAT|os.O_EXCL|os.O_WRONLY, 0o600), 'w') as out:
                out.write(secrets.token_urlsafe(32)+'\n')
            print(json.dumps({'token_file': str(args.token_file), 'mode': '0600', 'token_printed': False}))
        elif args.command == 'prepare':
            token = read_token(args.token_file)
            ssid = input('2.4GHz Wi-Fi name: ') if args.interactive else os.environ.get('ECHO_WIFI_SSID','')
            password = getpass.getpass('Wi-Fi password (hidden): ') if args.interactive else os.environ.get('ECHO_WIFI_PASSWORD','')
            prepare_header(args.api_base, token, ssid, password, args.output, args.replace)
            print(json.dumps({'configuration_written': str(args.output), 'credentials_printed': False,
                              'not_built_or_flashed': True}))
        else:
            token = read_token(args.token_file)
            upstream_token = read_token(args.upstream_token_file) if args.upstream_token_file else os.environ.get('DEVICE_ACCESS_TOKEN','')
            server = ConnectorServer((args.host, args.port), args.upstream, token, upstream_token)
            print(json.dumps({'service': 'esp32-device-connector', 'host': args.host,
                              'port': server.server_address[1], 'device_routes_only': True}), flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
    except (ValueError, OSError) as error:
        # Errors use our fixed messages; never include supplied credential values.
        parser.exit(2, 'connector: '+(str(error) if isinstance(error, ValueError) else error.__class__.__name__)+'\n')


if __name__ == '__main__':
    main()
