"""通过 Chrome DevTools Protocol 连进 Android WebView，驱动页面并读取桥的状态。

用法: python3 tools/checks/drive-webview.py <adb> <socket> <evalFile|eval> [timeout]

WebView 调试必须已开启（debug 构建里 MainActivity 调用了 setWebContentsDebuggingEnabled(true)）。
这个脚本会先做 socket 转发，再找一个 webview_devtools_remote 端点。
"""
import json
import random
import re
import subprocess
import sys
import time
import urllib.request

import websocket


def adb(*args):
    out = subprocess.run(ADB + list(args), capture_output=True, text=True, timeout=30)
    return out.stdout


def find_webview_socket():
    """The WebView daemon socket is owned by the app uid, so it is looked up by name."""
    listing = adb('shell', 'cat', '/proc/net/unix')
    names = []
    for line in listing.splitlines():
        match = re.search(r'(@?webview_devtools_remote\S*)', line)
        if match:
            names.append(match.group(1).lstrip('@'))
    return sorted(set(names))


class WebView:
    def __init__(self, port, socket_name):
        adb('forward', f'tcp:{port}', f'localabstract:{socket_name}')
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/json/list', timeout=10) as response:
            pages = [item for item in json.load(response) if item['type'] == 'page']
        if not pages:
            raise SystemExit('no page in webview devtools list')
        self.url = pages[0]['webSocketDebuggerUrl']
        # The forwarded port is on the host, but the ws URL points at the device's port.
        self.url = re.sub(r'ws://[^/]+', f'ws://127.0.0.1:{port}', self.url)
        self.id = 0
        self.ws = websocket.create_connection(self.url, timeout=60, suppress_origin=True)

    def send(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') != self.id:
                continue
            if 'error' in message:
                raise SystemExit(f'{method} failed: {message["error"]}')
            return message.get('result', {})

    def evaluate(self, expression):
        result = self.send('Runtime.evaluate', expression=expression, awaitPromise=True, returnByValue=True)
        if result.get('exceptionDetails'):
            raise SystemExit('eval failed: ' + str(result['exceptionDetails'].get('exception', {}).get('description')))
        return result.get('result', {}).get('value')


def main():
    global ADB
    adb_path, expression_spec = sys.argv[1], sys.argv[2]
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 60
    ADB = [adb_path]
    sockets = find_webview_socket()
    if not sockets:
        raise SystemExit('no webview devtools socket; is this a debug build with debugging enabled?')
    print('webview sockets:', sockets, flush=True)
    port = random.randint(9300, 9399)
    web = WebView(port, sockets[0])
    print('page url:', web.evaluate('location.href'), flush=True)
    expression = open(expression_spec, 'rb').read().decode() if expression_spec.startswith('/') or expression_spec.endswith('.js') else expression_spec
    deadline = time.time() + timeout
    value = web.evaluate(f'(async () => {{ {expression} }})()')
    print(json.dumps({'value': value}, ensure_ascii=False, indent=2), flush=True)
    assert time.time() < deadline
    web.ws.close()


main()
