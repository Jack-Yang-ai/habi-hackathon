// 独立复现 viewState() 的成本，不需要起 HTTP 服务。
// 用来区分：SQLite 读取 / JSON 解析 / 对象组装 各占多少。
import { Store, mealView } from '../../services/api/src/store.mjs';
import { DiningService } from '../../services/api/src/dining.mjs';

const directory = process.argv[2] ?? '/tmp/habi-perf';
const store = new Store(directory, () => new Date());
const dining = new DiningService(store, { env: {}, provider: { configured: false }, scheduler: false });

function timed(label, fn, runs = 5) {
  fn();
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  console.log(`${label.padEnd(38)} p50=${samples[Math.floor(runs / 2)].toFixed(1).padStart(7)}ms  max=${samples[runs - 1].toFixed(1).padStart(7)}ms`);
  return samples;
}

// app.mjs 里 viewState() 的逐步拆解
timed('store.list(signals)', () => store.list('signals'));
timed('store.list(events)', () => store.list('events'));
timed('store.list(events) filter memories', () => store.list('events').filter(e => ['meal.confirmed', 'preference.shared'].includes(e.type)));
timed('store.list(meals)', () => store.list('meals'));
timed('store.list(meals).map(mealView)', () => store.list('meals').slice(0, 100).map(mealView));
timed('store.list(messages)', () => store.list('messages'));
timed('store.list(posts)', () => store.list('posts'));
timed('store.list(devices)', () => store.list('devices'));
timed('dining.state()', () => dining.state());
timed('dining.mealStarted()', () => dining.mealStarted('2026-10-16:lunch'));
timed('ensureVirtualPost()', () => store.ensureVirtualPost());

const signals = store.list('signals');
const view = { signals: signals.slice(0, 20) };
timed('JSON.stringify(signals[0..20])', () => JSON.stringify(view));
console.log('signals[0] bytes =', Buffer.byteLength(JSON.stringify(signals[0])));
console.log('meals total =', store.list('meals').length, ' messages =', store.list('messages').length, ' signals =', signals.length, ' events =', store.list('events').length);
dining.close();
store.close();
