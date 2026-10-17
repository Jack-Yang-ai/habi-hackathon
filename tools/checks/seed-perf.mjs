// 合成数据播种器：只用于性能压测量，写入一个隔离的 DATA_DIR。
// 不读取、不修改 .data/ 里的真实用户数据。
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const scale = Number(process.argv[3] ?? 1);
if (!dir) { console.error('usage: node seed-perf.mjs <dataDir> [scale]'); process.exit(1); }
rmSync(path.join(dir, 'companion.sqlite'), { force: true });
rmSync(path.join(dir, 'companion.sqlite-wal'), { force: true });
rmSync(path.join(dir, 'companion.sqlite-shm'), { force: true });
mkdirSync(path.join(dir, 'media'), { recursive: true });

const db = new DatabaseSync(path.join(dir, 'companion.sqlite'));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS documents (
    kind TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL,
    payload TEXT NOT NULL, PRIMARY KEY(kind, id)
  );`);
const write = db.prepare(`INSERT INTO documents(kind,id,created_at,payload) VALUES(?,?,?,?)
  ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload`);

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const n = (value) => Math.round(value * scale);
const put = (kind, id, data) => write.run(kind, id, data.createdAt ?? iso(now), JSON.stringify(data));

put('settings', 'app', { id: 'app', createdAt: iso(now - 40 * 86400_000), paused: false, captureIntervalSeconds: 30,
  scene: 'idle', sceneUntil: null, proactivePosts: false, captureMode: 'signals', captureWindow: null, lastTriggerAt: null, reminder: null });
put('profile', 'self', { id: 'self', createdAt: iso(now - 40 * 86400_000), nickname: '测试', gender: 'undisclosed', age: 30,
  heightCm: 170, weightKg: 65, goal: 'balanced', dietaryNotes: '', calorieTarget: null, updatedAt: iso(now - 86400_000) });

const foods = ['米饭', '鸡胸肉', '西兰花', '番茄炒蛋', '清炒时蔬', '红烧鱼', '牛肉面', '豆浆', '全麦面包', '酸奶'];
const mealCount = n(300);
for (let i = 0; i < mealCount; i++) {
  const at = now - i * 3600_000 * 5;
  const id = `meal_${String(i).padStart(5, '0')}`;
  const image = { id: `cap_${i}`, imageUrl: `/media/img_${i}.jpg`, capturedAt: iso(at), receivedAt: iso(at + 400) };
  put('meals', id, { id, version: 2, title: i % 3 === 0 ? '待确认的一餐' : '一餐记录', source: i % 2 ? 'phone' : 'esp32',
    status: i % 3 === 0 ? 'estimated' : 'confirmed', deviceId: 'dev-perf', groupKey: `dev-perf:sess_${i}`,
    createdAt: iso(at), updatedAt: iso(at + 1000), capturedAt: iso(at), confirmedAt: i % 3 ? iso(at + 120000) : null,
    imageUrl: image.imageUrl, images: i % 4 === 0 ? [image, { ...image, id: `cap_${i}_b`, imageUrl: `/media/img_${i}_b.jpg` }] : [image],
    analysis: { status: 'ready', provider: 'model', modelName: 'step-1o-turbo-vision',
      foods: Array.from({ length: 5 }, (_, k) => ({ name: foods[(i + k) % foods.length], portion: '约100g', confidence: 0.7 })),
      calorieRange: { min: 420 + (i % 90), max: 610 + (i % 110) },
      macros: { proteinG: 28 + (i % 9), carbsG: 55 + (i % 20), fatG: 14 + (i % 7) },
      uncertainties: ['份量按常见餐具估算', '烹饪用油无法确认', '调味料未计入'],
      analyzedAt: iso(at + 200000), error: null, captureIds: [image.id] },
    portionFraction: 0.5 + (i % 5) / 10, note: i % 7 === 0 ? '外食，油偏多' : '', corrections: [{ portionFraction: 0.5, note: '', createdAt: iso(at + 60_000) }] });
}

const messageCount = n(2000);
const messages = [];
for (let i = 0; i < messageCount; i++) {
  const at = now - (messageCount - i) * 90_000;
  const id = `msg_${String(i).padStart(6, '0')}`;
  const user = { id, role: i % 2 ? 'assistant' : 'user', content: i % 2 ? '这一餐我先记好了，你觉得份量准吗？需要的话可以再补充说明。' : '今天中午吃了一碗牛肉面，还有一杯豆浆。',
    mealId: i % 5 === 0 ? `meal_${String(i % mealCount).padStart(5, '0')}` : null, createdAt: iso(at), mode: i % 2 ? 'model' : 'user' };
  if (i % 2) user.replyToId = `msg_${String(i - 1).padStart(6, '0')}`;
  messages.push(user);
  put('messages', id, user);
}
for (let i = 0; i < n(200); i++) {
  const at = now - i * 7200_000;
  put('posts', i === 0 ? 'little-room-today' : `meal-confirmed-post-${i}`,
    { id: i === 0 ? 'little-room-today' : `meal-confirmed-post-${i}`, kind: i === 0 ? 'virtual-life' : 'shared-experience',
      body: '这一餐记好了，你确认过的食量也一起收进记录。今天的小相册又添了一页。', createdAt: iso(at), mealId: `meal_${String(i).padStart(5, '0')}`,
      sourceEventIds: [], replies: Array.from({ length: 4 }, (_, k) => ({ id: `rep_${i}_${k}`, role: k % 2 ? 'assistant' : 'user',
        body: '看起来不错，下次少一点油。', createdAt: iso(at + k * 30_000), mode: k % 2 ? 'model' : 'user' })) });
}

const classification = { stage: 'start_soon', reason: 'explicit_local_pattern', hardVeto: false, probability: 0.82, margin: 0.61,
  distribution: { start_soon: 0.82, invited: 0.06, eating_now: 0.05, finished: 0.03, declined: 0.02, unrelated: 0.01, uncertain: 0.01 },
  model: 'decider-0.8b-q4', wallMs: 1420, temperature: 1.03 };
const decision = { model: 'decider-0.8b-q4', modelSha256: '5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a',
  runtime: 'llama.cpp-android-cpu', stage: 'start_soon', probability: 0.82, margin: 0.61,
  distribution: classification.distribution, wallMs: 1420, temperature: 1.03, promptVersion: 'decider-prompt-v3', promptTokens: 512, domainCalibrated: false };
const signalCount = n(5000);
for (let i = 0; i < signalCount; i++) {
  const at = now - (signalCount - i) * 60_000;
  const id = `sig_${String(i).padStart(6, '0')}`;
  put('signals', id, { signalId: id, stage: 'start_soon', action: 'capture_window', reason: 'explicit_local_pattern',
    captureWindowSeconds: 45, captureIntervalSeconds: 15, maxCaptures: 3, classification, dryRun: false,
    receivedAt: iso(at), observedAt: iso(at - 1200), speaker: 'self', sourceContext: 'user-conversation',
    text: '等下准备去吃饭了，看看附近有什么。', note: null, fingerprint: createHash('sha256').update(id).digest('hex').slice(0, 32),
    asrEvidence: { languageTag: 'zh-CN', emotionTag: 'neutral', eventTag: 'speech', windowStartSec: 12.4, windowEndSec: 15.8,
      audioSha256: createHash('sha256').update(id + 'a').digest('hex'), speechVadVerified: true, frames: 252800, sampleRate: 16000,
      timeSource: 'audio_timestamp_boottime', captureId: `cap_${i}`, captureStartedAt: iso(at - 3200), frameOffset: 198400 },
    localDecision: decision, createdAt: iso(at) });
}

const eventCount = n(3000);
for (let i = 0; i < eventCount; i++) {
  const at = now - i * 900_000;
  const id = `event_${String(i).padStart(6, '0')}`;
  put('events', id, { id, type: i % 3 === 0 ? 'meal.confirmed' : i % 3 === 1 ? 'meal.analyzed' : 'capture.received',
    mealId: `meal_${String(i % mealCount).padStart(5, '0')}`, captureId: `cap_${i}`, createdAt: iso(at) });
}
for (let i = 0; i < n(50); i++) {
  put('events', `pref_${i}`, { id: `pref_${i}`, type: 'preference.shared', text: '我不喜欢太油的菜。', messageId: `msg_${i}`, createdAt: iso(now - i * 3600_000) });
}
for (let i = 0; i < n(20); i++) {
  put('captures', `capture_${i}`, { id: `capture_${i}`, capture_id: `capture_${i}`, deviceId: 'dev-perf', imageUrl: `/media/img_${i}.jpg`,
    filename: `img_${i}.jpg`, mimeType: 'image/jpeg', sha256: createHash('sha256').update(String(i)).digest('hex'), source: 'esp32',
    receivedAt: iso(now - i * 60_000), capturedAt: iso(now - i * 60_000), mealId: `meal_${String(i).padStart(5, '0')}`, session_id: `sess_${i}` });
}
for (let i = 0; i < n(30); i++) {
  put('devices', `dev_${i}`, { id: `dev_${i}`, createdAt: iso(now - 86400_000), lastSeenAt: iso(now - (i + 1) * 600_000), camera_ready: i === 0 });
}
put('phones', 'phone_perf', { id: 'phone_perf', createdAt: iso(now - 86400_000), device_id: 'phone_perf', model: 'PZ261A',
  os: 'Android 16', rootAvailable: false, rearDisplay: 'adb-relay', lastSeenAt: iso(now - 5 * 60_000) });
put('diningSettings', 'self', { id: 'self', createdAt: iso(now - 86400_000), proactiveEnabled: false, mealTimeEnabled: false,
  style: 'balanced', radiusMeters: 800, maxCostYuan: 60, excludedKeywords: [], mealTimes: { lunch: '12:00', dinner: '18:30' }, version: 3, updatedAt: iso(now) });
put('diningState', 'self', { id: 'self', generation: 4, cardId: null, lastJobId: null });
for (let i = 0; i < n(400); i++) {
  put('diningJobs', `job_${i}`, { id: `job_${i}`, requestId: `req_${i}`, type: 'recommend', source: 'explicit_request',
    status: 'succeeded', attempts: 1, cardId: null, resultVersion: 1, error: null,
    createdAt: iso(now - i * 300_000), updatedAt: iso(now - i * 300_000), expiresAt: iso(now - i * 300_000 + 900_000), mealKey: 'day', generation: 4 });
}

const total = db.prepare('SELECT kind, COUNT(*) n, SUM(LENGTH(payload)) bytes FROM documents GROUP BY kind ORDER BY bytes DESC').all();
console.log(JSON.stringify({ dir, scale, rows: total }, null, 1));
db.close();
