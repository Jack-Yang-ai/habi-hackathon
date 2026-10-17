"""量客户端（WebView 等价环境）真实成本：CPU 节流后的首屏、长任务、一次删除交互。

用法: python3 tools/checks/measure-client.mjs <url> <steps.json>
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

    def start(self, width, height, throttle):
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
        self.ws = websocket.create_connection(target, timeout=120, suppress_origin=True)
        self.send('Page.enable')
        self.send('Runtime.enable')
        self.send('Emulation.setDeviceMetricsOverride', width=width, height=height, deviceScaleFactor=2, mobile=True)
        if throttle > 1:
            self.send('Emulation.setCPUThrottlingRate', rate=throttle)

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
        result = self.send('Runtime.evaluate', expression=f'(async () => {{ {expression} }})()',
                           awaitPromise=True, returnByValue=True)
        if result.get('exceptionDetails'):
            raise SystemExit('evaluate failed: ' + str(result['exceptionDetails'].get('exception', {}).get('description')))
        return result.get('result', {}).get('value')


PROBE = r"""
// 在页面里量：一次 295KB 状态到达后，纯 JS+DOM 要跑多久（不含网络）。
const t = {};
const nav = performance.getEntriesByType('navigation')[0];
t.domContentLoaded = nav ? nav.domContentLoadedEventEnd - nav.startTime : null;
t.loadEvent = nav ? nav.loadEventEnd - nav.startTime : null;
t.resources = performance.getEntriesByType('resource').map(r => ({ n: r.name.split('/').pop(), d: Math.round(r.duration) }));

// 1) 长任务观察：连续 12 秒内所有 >50ms 的长任务
const longTasks = [];
const observer = new PerformanceObserver(list => { for (const e of list.getEntries()) longTasks.push(Math.round(e.duration)); });
try { observer.observe({ entryTypes: ['longtask'] }); } catch (_) {}
await new Promise(r => setTimeout(r, 12000));
observer.disconnect();
t.longTasks = longTasks;

// 2) 直接量 /api/state 的网络时间 + 纯解析成本
const t0 = performance.now();
const res = await fetch('/api/state');
const text = await res.text();
const t1 = performance.now();
const parsed = JSON.parse(text);
const t2 = performance.now();
t.stateBytes = text.length;
t.stateNetworkMs = Math.round(t1 - t0);
t.stateJsonParseMs = Math.round((t2 - t1) * 10) / 10;

// 3) 量 DOM 规模与滚动一帧的成本
t.domNodes = document.getElementsByTagName('*').length;
const scroller = [...document.querySelectorAll('*')].find(el => el.scrollHeight > el.clientHeight + 100);
let frameMs = null;
if (scroller) {
  const f0 = performance.now();
  for (let i = 0; i < 20; i++) { scroller.scrollTop = scroller.scrollHeight - i * 40; await new Promise(r => requestAnimationFrame(r)); }
  frameMs = Math.round((performance.now() - f0) / 20 * 10) / 10;
}
t.scrollFrameMs = frameMs;
t.scrollerHeight = scroller ? scroller.scrollHeight : null;

// 4) 纯 UI 交互（不碰后端）：点开一个弹层再关掉
const btn = [...document.querySelectorAll('button')].find(b => /设备|设置/.test(b.getAttribute('aria-label') || b.textContent));
let uiOpenMs = null;
if (btn) {
  const before = document.body.innerHTML.length;
  const i0 = performance.now();
  btn.click();
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
  uiOpenMs = Math.round((performance.now() - i0) * 10) / 10;
  t.uiAfterClickHtmlDelta = document.body.innerHTML.length - before;
}
t.uiOpenRoundTripMs = uiOpenMs;
return t;
"""

RECALL = r"""
// 量一次「删除」从点击到界面更新完成的全过程，并拆出后端耗时。
const mealRow = [...document.querySelectorAll('button')].find(b => /撤回|删除/.test(b.textContent));
const out = { found: Boolean(mealRow) };
if (mealRow) {
  const t0 = performance.now();
  const wrapped = [];
  const origFetch = window.fetch;
  window.fetch = async (...args) => {
    const s = performance.now();
    const r = await origFetch(...args);
    await r.clone().text();
    wrapped.push({ url: String(args[0]), body: r.headers.get('content-length'), clientMs: Math.round(performance.now() - s) });
    return r;
  };
  mealRow.click();
  await new Promise(r => setTimeout(r, 4000));
  window.fetch = origFetch;
  out.clickToSettledMs = Math.round(performance.now() - t0);
  out.requests = wrapped;
}
return out;
"""


def main():
    faulthandler.dump_traceback_later(300, exit=True)
    url, steps_path = sys.argv[1], sys.argv[2]
    throttle = int(os.environ.get('CPU_THROTTLE', '4'))
    steps = json.load(open(steps_path))
    port = random.randint(9600, 9899)
    profile = f'/tmp/habi-measure-{port}'
    shutil.rmtree(profile, ignore_errors=True)
    session = Session(port, profile)
    session.start(390, 844, throttle)
    session.send('Page.navigate', url=url)
    time.sleep(4)
    report = []
    for step in steps:
        name = step.get('name', 'step')
        expression = step.get('eval') or (open(step['evalFile'], 'rb').read().decode() if step.get('evalFile') else None)
        if not expression:
            continue
        print('measure', name, flush=True)
        value = session.evaluate(expression)
        report.append({'name': name, 'value': value})
        print(json.dumps({'name': name, 'value': value}, ensure_ascii=False), flush=True)
    print(json.dumps({'throttle': throttle, 'url': url, 'steps': report}, ensure_ascii=False, indent=2))
    session.ws.close()


main()
