"""Drive headless Chrome over the DevTools Protocol to inspect and screenshot the studio.

Playwright is not installed in this workspace, so this uses websocket-client plus Chrome's
built-in remote debugging port. Steps come from a JSON file:

    python3 tools/shot.py <url> <outDir> <steps.json>

Each step: {name, goto?, eval?, evalFile?, wait?, height?, focus?, press?, file?}  (wait/settle are milliseconds)
`file` is {selector, path}: it sets a real file on an <input type=file> through the DOM domain.
`evalFile` reads the expression from a file, which keeps long checks readable.
`eval` runs in the page and its value is reported back.
"""
import base64
import json
import os
import random
import shutil
import subprocess
import sys
import time
import urllib.request

import faulthandler
import websocket

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'


class Session:
    def __init__(self, port, profile):
        self.port = port
        self.profile = profile
        self.id = 0
        self.ws = None
        self.events = []

    def start(self, width, height):
        subprocess.Popen([CHROME, '--headless=new', f'--remote-debugging-port={self.port}',
                          f'--user-data-dir={self.profile}', '--no-first-run', '--no-default-browser-check',
                          '--disable-gpu', '--hide-scrollbars', '--remote-allow-origins=*',
                          '--no-sandbox', '--disable-setuid-sandbox', '--disable-crash-reporter',
                          '--disable-dev-shm-usage', f'--window-size={width},{height}', 'about:blank'],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        target = None
        for _ in range(120):
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/json/list', timeout=2) as response:
                    pages = [item for item in json.load(response) if item['type'] == 'page']
                if pages:
                    target = pages[0]['webSocketDebuggerUrl']
                    break
            except Exception:
                pass
            time.sleep(.25)
        if not target:
            raise SystemExit('Chrome DevTools endpoint never opened')
        self.ws = websocket.create_connection(target, timeout=30, suppress_origin=True)
        print('cdp connected', flush=True)
        self.send('Page.enable')
        self.send('Runtime.enable')
        self.send('Log.enable')
        self.send('DOM.enable')
        self.viewport(width, height)
        print('cdp ready', flush=True)

    def send(self, method, **params):
        self.id += 1
        self.ws.send(json.dumps({'id': self.id, 'method': method, 'params': params}))
        while True:
            message = json.loads(self.ws.recv())
            if message.get('id') != self.id:
                self.events.append(message)
                continue
            if 'error' in message:
                raise SystemExit(f'{method} failed: {message["error"]}')
            return message.get('result', {})

    def viewport(self, width, height):
        self.send('Emulation.setDeviceMetricsOverride', width=width, height=height, deviceScaleFactor=2, mobile=True)

    def evaluate(self, expression):
        result = self.send('Runtime.evaluate', expression=f'(async () => {{ {expression} }})()',
                           awaitPromise=True, returnByValue=True)
        if result.get('exceptionDetails'):
            raise SystemExit('evaluate failed: ' + str(result['exceptionDetails'].get('exception', {}).get('description')))
        return result.get('result', {}).get('value')

    def screenshot(self, path):
        print('capture', path, flush=True)
        result = self.send('Page.captureScreenshot', format='png')
        print('captured', len(result.get('data', '')), flush=True)
        data = result['data']
        with open(path, 'wb') as handle:
            handle.write(base64.b64decode(data))


def main():
    faulthandler.dump_traceback_later(300, exit=True)
    url, out_dir, steps_path = sys.argv[1], sys.argv[2], sys.argv[3]
    steps = json.load(open(steps_path))
    os.makedirs(out_dir, exist_ok=True)
    port = random.randint(9600, 9899)
    profile = f'/tmp/habi-shot-{port}'
    shutil.rmtree(profile, ignore_errors=True)
    session = Session(port, profile)
    session.start(390, 844)
    session.send('Page.navigate', url=url)
    time.sleep(2.5)
    print('navigated', url, flush=True)
    report = []
    for step in steps:
        if step.get('height'):
            session.viewport(step.get('width', 390), step['height'])
        if step.get('goto'):
            session.send('Page.navigate', url=step['goto'])
            time.sleep(step.get('settle', 2200) / 1000)
        if step.get('file'):
            document = session.send('DOM.getDocument')
            node = session.send('DOM.querySelector', nodeId=document['root']['nodeId'], selector=step['file']['selector'])
            if not node.get('nodeId'):
                raise SystemExit('file input not found: ' + step['file']['selector'])
            session.send('DOM.setFileInputFiles', files=[step['file']['path']], nodeId=node['nodeId'])
        if step.get('focus'):
            session.evaluate(f'document.querySelector({json.dumps(step["focus"])})?.focus()')
        if step.get('press'):
            session.send('Input.dispatchKeyEvent', type='keyDown', key=step['press'], code=step['press'], windowsVirtualKeyCode=13 if step['press'] == 'Enter' else 0)
            session.send('Input.dispatchKeyEvent', type='keyUp', key=step['press'], code=step['press'])
        expression = step.get('eval') or (open(step['evalFile']).read() if step.get('evalFile') else None)
        if expression:
            label = step.get('name', 'step')
            print('eval', label, flush=True)
            value = session.evaluate(expression)
            report.append({'name': label, 'value': value})
            print(json.dumps({'name': label, 'value': value}, ensure_ascii=False), flush=True)
        if step.get('wait'):
            time.sleep(step['wait'] / 1000)
        if step.get('name'):
            session.screenshot(os.path.join(out_dir, f"{step['name']}.png"))
            print('shot', step['name'], flush=True)
    messages = []
    for event in session.events:
        if event.get('method') == 'Runtime.consoleAPICalled' and event['params'].get('type') in ('error', 'warning'):
            messages.append({'level': event['params']['type'], 'text': ' '.join(str(a.get('value', a.get('description', ''))) for a in event['params'].get('args', []))[:400]})
        if event.get('method') == 'Log.entryAdded' and event['params']['entry'].get('level') in ('error', 'warning'):
            messages.append({'level': event['params']['entry']['level'], 'text': str(event['params']['entry'].get('text'))[:400]})
        if event.get('method') == 'Runtime.exceptionThrown':
            messages.append({'level': 'exception', 'text': str(event['params']['exceptionDetails'].get('exception', {}).get('description'))[:400]})
    print(json.dumps({'steps': report, 'console': messages}, ensure_ascii=False, indent=2))
    session.ws.close()


main()
