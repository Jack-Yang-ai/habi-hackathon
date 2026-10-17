#!/usr/bin/env python3
"""Install the prepared backend on its target Mac. Does not change listening scope."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
LABEL = 'com.withecho.companion.backend.' + hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
DOMAIN = 'gui/' + str(os.getuid())
TARGET = DOMAIN + '/' + LABEL
PLIST = Path.home() / 'Library/LaunchAgents' / (LABEL + '.plist')
LOGS = Path.home() / 'Library/Logs/HabiBackend' / LABEL.rsplit('.', 1)[-1]
SERVER = ROOT / 'services/api/src/server.mjs'


def command(args, check=True):
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=20)


def settings():
    # Never print credentials. Node itself loads the complete private .env.
    values = {'HOST': '127.0.0.1', 'PORT': '8787', 'APP_ACCESS_TOKEN': '', 'DEVICE_ACCESS_TOKEN': ''}
    for line in (ROOT / '.env').read_text().splitlines():
        name, sep, value = line.strip().partition('=')
        if sep and name in values:
            values[name] = value.strip().strip('"\'')
    if values['HOST'] not in ('127.0.0.1', 'localhost', '::1', '0.0.0.0'):
        raise RuntimeError('Use loopback or the explicitly configured LAN binding')
    if values['HOST'] == '0.0.0.0' and (min(len(values['APP_ACCESS_TOKEN']), len(values['DEVICE_ACCESS_TOKEN'])) < 32
            or values['APP_ACCESS_TOKEN'] == values['DEVICE_ACCESS_TOKEN']):
        raise RuntimeError('LAN mode requires different App/device tokens of at least 32 characters')
    port = int(values['PORT'])
    if not 1024 <= port <= 65535:
        raise RuntimeError('Invalid backend port')
    return port, values['HOST']


def loaded():
    return command(['launchctl', 'print', TARGET], check=False).returncode == 0


def listeners(port):
    result = command(['lsof', '-nP', '-iTCP:' + str(port), '-sTCP:LISTEN', '-t'], check=False)
    return set(int(x) for x in result.stdout.split() if x.isdigit())


def stop_manual(port):
    for pid in listeners(port):
        args = command(['ps', '-p', str(pid), '-o', 'args=']).stdout
        cwd = command(['lsof', '-a', '-p', str(pid), '-d', 'cwd', '-Fn']).stdout.splitlines()
        if 'services/api/src/server.mjs' not in args or 'n' + str(ROOT) not in cwd:
            raise RuntimeError('Port belongs to another process; no process stopped')
        os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if not listeners(port):
            return
        time.sleep(0.1)
    raise RuntimeError('Backend still closing; no force kill was sent')


def healthy(port):
    try:
        with urllib.request.urlopen('http://127.0.0.1:' + str(port) + '/health', timeout=2) as response:
            return json.load(response).get('service') == 'de-companion'
    except (OSError, ValueError):
        return False


def verify_owned_plist():
    if not PLIST.exists():
        raise RuntimeError('No service configuration belongs to this checkout')
    value = plistlib.loads(PLIST.read_bytes())
    if value.get('Label') != LABEL or value.get('WorkingDirectory') != str(ROOT) \
            or str(SERVER) not in value.get('ProgramArguments', []):
        raise RuntimeError('Service identity mismatch; no service changed')


def status(port, host):
    detail = command(['launchctl', 'print', TARGET], check=False)
    state, pid = None, None
    for line in detail.stdout.splitlines():
        key, _, value = line.strip().partition(' = ')
        if key == 'state': state = value
        if key == 'pid' and value.isdigit(): pid = int(value)
    return {'label': LABEL, 'loaded': detail.returncode == 0, 'state': state, 'pid': pid,
            'healthy': healthy(port), 'url': 'http://127.0.0.1:' + str(port),
            'scope': 'authenticated-lan' if host == '0.0.0.0' else 'loopback-only',
            'starts_on_user_login': PLIST.is_file(), 'plist': str(PLIST)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('install', 'status', 'start', 'stop', 'uninstall'))
    parser.add_argument('--replace-running', action='store_true', help='Gracefully replace only this checkout\'s manual server')
    args = parser.parse_args()
    if sys.platform != 'darwin': parser.error('Requires macOS launchd')
    if not (ROOT / '.env').is_file(): parser.error('Configure the local .env first')
    port, host = settings()
    if args.action == 'status':
        print(json.dumps(status(port, host))); return
    if args.action == 'uninstall':
        if PLIST.exists():
            verify_owned_plist()
            if loaded(): command(['launchctl', 'bootout', TARGET])
            archive = ROOT / '.tools/backend-service/uninstalled-launchagent.plist'
            archive.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            shutil.copy2(PLIST, archive); PLIST.unlink()
        print(json.dumps(status(port, host))); return
    if args.action == 'install':
        # Background jobs should not depend on access to macOS protected folders.
        # The developer laptop stays manual; extract the release on the target Mac.
        if any(ROOT == protected or protected in ROOT.parents for protected in
               (Path.home() / 'Documents', Path.home() / 'Desktop', Path.home() / 'Downloads')):
            parser.error('Extract the release under ~/Library/Application Support/HabiBackend on the target Mac before installing')
        node = shutil.which('node')
        if not node: parser.error('Node.js 22.16+ is required')
        node = str(Path(node).resolve())
        command([node, '-e', "const [a,b]=process.versions.node.split('.').map(Number);if(a<22||(a===22&&b<16))process.exit(2)"])
        if not (ROOT / 'apps/studio/dist/index.html').is_file(): parser.error('Build the frontend first')
        if loaded():
            verify_owned_plist()
            command(['launchctl', 'bootout', TARGET])
        if listeners(port):
            if not args.replace_running: parser.error('A backend is running; use --replace-running for this checkout')
            stop_manual(port)
        LOGS.mkdir(parents=True, exist_ok=True, mode=0o700)
        for name in ('stdout.log', 'stderr.log'):
            log = LOGS / name
            log.touch(mode=0o600, exist_ok=True); log.chmod(0o600)
        PLIST.parent.mkdir(parents=True, exist_ok=True)
        config = {'Label': LABEL, 'ProgramArguments': [node, '--env-file=' + str(ROOT / '.env'), str(SERVER)],
                  'WorkingDirectory': str(ROOT), 'RunAtLoad': True, 'KeepAlive': True,
                  'ThrottleInterval': 10, 'ExitTimeOut': 150, 'ProcessType': 'Background',
                  'EnvironmentVariables': {'PATH': str(Path(node).parent) + ':/usr/bin:/bin:/usr/sbin:/sbin'},
                  'StandardOutPath': str(LOGS / 'stdout.log'), 'StandardErrorPath': str(LOGS / 'stderr.log')}
        PLIST.write_bytes(plistlib.dumps(config)); PLIST.chmod(0o600)
        command(['plutil', '-lint', str(PLIST)])
        command(['launchctl', 'enable', TARGET])
        command(['launchctl', 'bootstrap', DOMAIN, str(PLIST)])
    elif args.action == 'start':
        verify_owned_plist()
        if not loaded(): command(['launchctl', 'bootstrap', DOMAIN, str(PLIST)])
    else:
        verify_owned_plist()
        if loaded(): command(['launchctl', 'bootout', TARGET])
        print(json.dumps(status(port, host))); return
    for _ in range(30):
        if loaded() and healthy(port):
            print(json.dumps(status(port, host))); return
        time.sleep(0.5)
    if loaded(): command(['launchctl', 'bootout', TARGET], check=False)
    raise RuntimeError('Service health check failed; stopped the new job. Inspect its private logs')


if __name__ == '__main__':
    try: main()
    except (RuntimeError, ValueError, subprocess.SubprocessError) as error:
        # No environment/credential contents or process command lines in errors.
        print('backend service: ' + str(error)[:400], file=sys.stderr)
        sys.exit(1)
