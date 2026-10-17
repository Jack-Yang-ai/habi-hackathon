"""Evaluate JavaScript inside the connected phone's WebView over the DevTools socket.

The debug build enables WebView debugging, so the host page can be inspected without touching
the app itself:

    adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof <pkg>)
    python3 tools/phone-eval.py 'window.EchoDevice.getStatus()'

The expression runs inside an async wrapper, so `await` is available.
"""
import json
import sys
import urllib.request

import websocket

PORT = 9222


def target():
    with urllib.request.urlopen(f'http://127.0.0.1:{PORT}/json', timeout=8) as response:
        pages = [item for item in json.load(response) if item['type'] == 'page']
    if not pages:
        raise SystemExit('no WebView page target; is the app in the foreground?')
    return pages[0]


def main():
    expression = sys.argv[1] if len(sys.argv) > 1 else '1'
    page = target()
    socket = websocket.create_connection(page['webSocketDebuggerUrl'], timeout=30, suppress_origin=True)
    counter = [0]

    def send(method, **params):
        counter[0] += 1
        socket.send(json.dumps({'id': counter[0], 'method': method, 'params': params}))
        while True:
            message = json.loads(socket.recv())
            if message.get('id') == counter[0]:
                if 'error' in message:
                    raise SystemExit(f'{method} failed: {message["error"]}')
                return message.get('result', {})

    send('Runtime.enable')
    result = send('Runtime.evaluate', expression=f'(async () => {{ {expression} }})()', awaitPromise=True, returnByValue=True)
    if result.get('exceptionDetails'):
        raise SystemExit('evaluate failed: ' + str(result['exceptionDetails'].get('exception', {}).get('description')))
    value = result.get('result', {}).get('value')
    print(json.dumps(value, ensure_ascii=False, indent=2) if isinstance(value, (dict, list)) else value)
    socket.close()


main()
