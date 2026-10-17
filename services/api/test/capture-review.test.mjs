import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';

const epoch = new Date('2026-10-15T09:00:00Z');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1EAAAAASUVORK5CYII=', 'base64');
const estimate = (foodDetected, imageQuality = 'clear') => ({ foodDetected, imageQuality, title: '合成测试夹具',
  foods: foodDetected ? [{ name: '合成测试食物', estimatedGrams: null }] : [], calorieRange: null,
  uncertainties: ['仅用于接口测试，不是真实餐食或热量'] });
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const state = app => app.inject('/api/state').then(r => r.json());
const config = app => app.inject('/api/device/config?device_id=fixture-sense').then(r => r.json());
async function setup(t, analyze) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'de-review-test-'));
  let current = epoch; let calls = 0;
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only',
    async analyze(...args) { calls++; return analyze(...args); } };
  const app = await createApp({ env: {}, dataDir, provider, clock: () => current });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  await post(app, '/api/device/pause', { paused: false });
  await post(app, '/api/signals/context', { signalId: 'fixture-context', text: '你要不要吃？', speaker: 'unknown',
    sourceContext: 'user-conversation', observedAt: epoch.toISOString(), dryRun: false });
  return { app, calls: () => calls, advance(ms) { current = new Date(current.getTime() + ms); } };
}
async function upload(app, window, sequence = 0) {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'synthetic.png');
  form.append('metadata', JSON.stringify({ schema_version: 1, capture_id: `fixture-${sequence}`, device_id: 'fixture-sense',
    boot_id: 'fixture-boot', sequence, captured_at: epoch.toISOString(), time_source: 'server', uptime_ms: sequence * 15000,
    session_id: window.session_id, capture_window_id: window.id, capture_phase: window.phase }));
  const request = new Request('http://localhost/api/device/captures', { method: 'POST', body: form });
  return app.inject({ method: 'POST', url: '/api/device/captures', headers: { 'content-type': request.headers.get('content-type') },
    payload: Buffer.from(await request.arrayBuffer()) });
}

test('durable ACK precedes vision; a non-food first image stops without inventing a meal', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { app, calls } = await setup(t, () => waiting);
  const probe = (await config(app)).capture_window;
  assert.equal(probe.remaining, 1);
  const response = await upload(app, probe);
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().capture_id, 'fixture-0');
  assert.equal(response.json().meal, null);
  assert.equal((await state(app)).device.captureReview.status, 'checking');
  assert.equal((await config(app)).capture_window, null);
  release(estimate(false));
  await app.reviewer.drain();
  const after = await state(app);
  assert.equal(after.device.captureReview.status, 'no_food');
  assert.equal(after.device.captureWindow, null);
  assert.equal(after.meals.length, 0);
  assert.equal(app.store.list('captures').length, 1);
  assert.equal(calls(), 1);
  assert.equal((await upload(app, probe)).statusCode, 200, 'lost ACK retry remains idempotent');
  assert.equal(calls(), 1);
});

test('food unlocks at most two follow-ups in the same candidate, with no assumed intake', async t => {
  const { app, calls } = await setup(t, async () => estimate(true));
  const probe = (await config(app)).capture_window;
  await upload(app, probe);
  await app.reviewer.drain();
  const followup = (await config(app)).capture_window;
  assert.equal(followup.phase, 'followup');
  assert.equal(followup.session_id, probe.session_id);
  assert.notEqual(followup.id, probe.id);
  assert.equal(followup.remaining, 2);
  await upload(app, followup, 1);
  await upload(app, followup, 2);
  assert.equal((await upload(app, followup, 3)).statusCode, 409, 'server also bounds untrusted uploads');
  const after = await state(app);
  assert.equal(after.meals.length, 1);
  assert.equal(after.meals[0].captureCount, 3);
  assert.equal(after.meals[0].portionFraction, null);
  assert.equal(after.meals[0].consumedCalorieRange, null);
  assert.equal(after.meals[0].confirmedAt, null);
  assert.deepEqual(after.meals[0].analysis.captureIds, ['fixture-0']);
  assert.equal(after.device.captureReview.status, 'complete');
  assert.equal(after.device.captureWindow, null);
  assert.equal(calls(), 1, 'follow-up views are preserved, not falsely claimed as analyzed');
});

test('an unclear image can retry only once; finding food on retry leaves only one extra frame', async t => {
  let count = 0;
  const { app } = await setup(t, async () => ++count === 1 ? estimate(false, 'unusable') : estimate(true));
  const probe = (await config(app)).capture_window;
  await upload(app, probe);
  await app.reviewer.drain();
  const retry = (await config(app)).capture_window;
  assert.equal(retry.remaining, 1);
  assert.equal((await state(app)).device.captureReview.status, 'waiting_retry');
  assert.equal((await state(app)).meals.length, 0);
  await upload(app, retry, 1);
  await app.reviewer.drain();
  const last = (await config(app)).capture_window;
  assert.equal(last.remaining, 1);
  assert.notEqual(last.id, retry.id);
  await upload(app, last, 2);
  assert.equal((await config(app)).capture_window, null);
  assert.equal((await state(app)).meals[0].captureCount, 3);
});

test('two unclear images end the attempt; model outage preserves raw evidence and cannot keep shooting', async t => {
  const { app } = await setup(t, async () => estimate(false, 'uncertain'));
  await upload(app, (await config(app)).capture_window);
  await app.reviewer.drain();
  await upload(app, (await config(app)).capture_window, 1);
  await app.reviewer.drain();
  assert.equal((await state(app)).device.captureReview.status, 'uncertain');
  assert.equal((await config(app)).capture_window, null);
  assert.equal((await state(app)).meals.length, 0);
  assert.equal(app.store.list('captures').length, 2);
  const failed = await setup(t, async () => { throw new Error('fixture model outage'); });
  await upload(failed.app, (await config(failed.app)).capture_window);
  await failed.app.reviewer.drain();
  assert.equal((await state(failed.app)).device.captureReview.status, 'failed');
  assert.equal((await config(failed.app)).capture_window, null);
  assert.equal(failed.app.store.list('captures').length, 1);
});

test('late vision or user pause cannot extend the deadline or reopen a camera window', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { app, advance } = await setup(t, () => waiting);
  await upload(app, (await config(app)).capture_window);
  advance(46000);
  release(estimate(true));
  await app.reviewer.drain();
  assert.equal((await config(app)).capture_window, null);
  assert.equal((await state(app)).device.captureReview.status, 'complete');
  const paused = await setup(t, async () => estimate(true));
  await upload(paused.app, (await config(paused.app)).capture_window);
  await post(paused.app, '/api/device/pause', { paused: true });
  await paused.app.reviewer.drain();
  assert.equal((await state(paused.app)).device.captureReview.status, 'cancelled');
  assert.equal((await state(paused.app)).device.captureWindow, null);
  assert.equal((await state(paused.app)).meals.length, 0);
});

test('restart resumes a journalled interrupted review once and keeps the original capture identity', async t => {
  const { app } = await setup(t, async () => { throw new Error('fixture interruption'); });
  await upload(app, (await config(app)).capture_window);
  await app.reviewer.drain();
  const job = app.store.get('reviewJobs', 'fixture-0');
  app.store.put('reviewJobs', job.id, { ...job, state: 'running', attempts: 1 });
  const session = app.store.get('captureSessions', job.sessionId);
  app.store.put('captureSessions', session.id, { ...session, status: 'checking' });
  const dataDir = app.store.directory;
  await app.close();
  let calls = 0;
  const reopened = await createApp({ env: {}, dataDir, clock: () => epoch, provider: { visionConfigured: true,
    chatConfigured: false, visionModel: 'fixture-recovery', async analyze() { calls++; return estimate(true); } } });
  try {
    await reopened.reviewer.drain();
    assert.equal(calls, 1);
    assert.equal(reopened.store.list('captures').length, 1);
    assert.equal(reopened.store.list('meals').length, 1);
    assert.equal(reopened.store.get('reviewJobs', 'fixture-0').attempts, 2);
    assert.deepEqual(reopened.store.list('meals')[0].analysis.captureIds, ['fixture-0']);
    assert.equal((await config(reopened)).capture_window, null, 'recovery never opens a new capture window');
  } finally { await reopened.close(); }
});

test('device upload whose metadata part declares application/json is accepted', async t => {
  // The ESP32 firmware sets Content-Type: application/json on the metadata field, so
  // @fastify/multipart hands the route an already-parsed object instead of the string the
  // phone camera sends. Both shapes must work; the object shape used to fail with 400.
  const { app } = await setup(t, () => estimate(false));
  const window = (await config(app)).capture_window;
  assert.equal(window.remaining, 1);
  const boundary = 'fixtureEchoBoundary';
  const metadata = JSON.stringify({ schema_version: 1, capture_id: 'fixture-json-field', device_id: 'fixture-sense',
    boot_id: 'fixture-boot', sequence: 0, captured_at: null, time_source: 'unsynchronized', uptime_ms: 1000,
    mime_type: 'image/png', session_id: window.session_id, capture_window_id: window.id, capture_phase: window.phase });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="capture.png"\r\nContent-Type: image/png\r\n\r\n`),
    png,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await app.inject({ method: 'POST', url: '/api/device/captures',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().capture_id, 'fixture-json-field');
  assert.equal(app.store.list('captures').length, 1);
});
