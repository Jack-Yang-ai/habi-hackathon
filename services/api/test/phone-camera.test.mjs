import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { isPhoneCameraCommand } from '../src/trigger.mjs';

const now = new Date('2026-10-15T12:00:00Z');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1EAAAAASUVORK5CYII=', 'base64');
const estimate = foodDetected => ({ foodDetected, imageQuality: 'clear', title: '合成接口测试',
  foods: foodDetected ? [{ name: '合成夹具', estimatedGrams: null }] : [], calorieRange: null,
  uncertainties: ['合成测试，不代表真实食物或热量'] });
async function setup(t, analyze = async () => estimate(false), env = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'habi-phone-camera-'));
  let calls = 0;
  const app = await createApp({ dataDir, env, clock: () => now, provider: { visionConfigured: true,
    chatConfigured: false, visionModel: 'fixture-only', async analyze(...args) { calls++; return analyze(...args); } } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, calls: () => calls };
}
async function upload(app, extra = {}, headers = {}) {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'synthetic.png');
  form.append('metadata', JSON.stringify({ schema_version: 1, capture_id: 'phone-fixture-1', device_id: 'fixture-phone',
    boot_id: 'fixture-boot', sequence: 1, captured_at: now.toISOString(), time_source: 'phone', uptime_ms: 0,
    mime_type: 'image/png', ...extra }));
  const req = new Request('http://localhost/api/phone/captures', { method: 'POST', body: form });
  return app.inject({ method: 'POST', url: '/api/phone/captures', payload: Buffer.from(await req.arrayBuffer()),
    headers: { 'content-type': req.headers.get('content-type'), ...headers } });
}

test('explicit whole-utterance photo commands use the phone once, independently of meal cooldown', async t => {
  const { app } = await setup(t);
  await app.inject({ method: 'POST', url: '/api/device/pause', payload: { paused: false } });
  app.store.settings({ lastTriggerAt: now.toISOString() });
  for (const [i, text] of ['Habi记录', 'habi 记录', 'HABI，记录！', '哈比记录。', 'happy记录.', 'HAPPY，记录！'].entries()) {
    assert.equal(isPhoneCameraCommand(text), true);
    const r = await app.inject({ method: 'POST', url: '/api/signals/context', payload: {
      signalId: `command-${i}`, text, observedAt: now.toISOString(), speaker: 'unknown', sourceContext: 'unknown', dryRun: false } });
    assert.equal(r.json().signal.action, 'phone_capture', r.body);
    assert.equal(r.json().signal.maxCaptures, 1);
    assert.equal(r.json().signal.classification.ingestionConfirmed, false);
    assert.equal(r.json().signal.classification.evidence, text, 'raw ASR spelling must remain unchanged');
    assert.equal(r.json().state.device.captureWindow, null);
  }
  for (const text of ['拍照', '帮我拍一下', '给我拍张照', 'Habi帮我拍一下', '记录', '不要Habi记录', '别哈比记录', '他说Habi记录', '测试Habi记录', '明天Habi记录', 'Habi记录是什么意思', '我要去吃饭了',
    'happy', 'happy birthday记录', '不要happy记录', '他说happy记录', '明天happy记录', '测试happy记录', 'happy记录是什么意思'])
    assert.equal(isPhoneCameraCommand(text), false, text);
  for (const sourceContext of ['media', 'test-fixture']) {
    const r = await app.inject({ method: 'POST', url: '/api/signals/context', payload: {
      signalId: sourceContext, text: 'Habi记录', observedAt: now.toISOString(), sourceContext, dryRun: false } });
    assert.equal(r.json().signal.action, 'ignore');
  }
  for (const [i, extra] of [
    { speaker: 'other' },
    { observedAt: new Date(now.getTime() - 121000).toISOString() },
    { asrEvidence: { languageTag: 'zh', emotionTag: null, eventTag: 'Speech', windowStartSec: 0,
      windowEndSec: 1, audioSha256: 'a'.repeat(64), speechVadVerified: false } },
  ].entries()) {
    const r = await app.inject({ method: 'POST', url: '/api/signals/context', payload: {
      signalId: `veto-${i}`, text: 'Habi记录', observedAt: now.toISOString(), dryRun: false, ...extra } });
    assert.notEqual(r.json().signal.action, 'phone_capture');
  }
  await app.inject({ method: 'POST', url: '/api/device/pause', payload: { paused: true } });
  const paused = await app.inject({ method: 'POST', url: '/api/signals/context', payload: {
    signalId: 'paused', text: 'Habi记录', observedAt: now.toISOString(), dryRun: false } });
  assert.equal(paused.json().signal.action, 'defer');
});

test('one-shot phone photo gets a durable ACK, non-food creates no meal and ACK retries never reshoot or reanalyze', async t => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const { app, calls } = await setup(t, () => waiting);
  const r = await upload(app);
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(r.json().meal, null);
  assert.equal((await app.inject('/api/phone/captures/phone-fixture-1')).json().review.status, 'checking');
  assert.equal((await app.inject('/api/device/config?device_id=fixture-esp')).json().capture_window, null);
  release(estimate(false)); await app.reviewer.drain();
  assert.equal((await app.inject('/api/phone/captures/phone-fixture-1')).json().review.status, 'no_food');
  assert.equal(app.store.list('meals').length, 0);
  assert.equal((await upload(app)).statusCode, 200);
  await app.reviewer.drain(); assert.equal(calls(), 1);
  assert.equal(app.store.list('captures').length, 1);
});

test('phone food remains unconfirmed, cannot unlock ESP32 follow-ups or attach to its session', async t => {
  const { app } = await setup(t, async () => estimate(true));
  await upload(app); await app.reviewer.drain();
  const result = (await app.inject('/api/phone/captures/phone-fixture-1')).json();
  assert.equal(result.review.status, 'complete');
  assert.equal(result.meal.source, 'phone');
  assert.equal(result.meal.confirmedAt, null);
  assert.equal(result.meal.portionFraction, null);
  assert.equal(result.meal.consumedCalorieRange, null);
  assert.equal((await app.inject('/api/device/config?device_id=fixture-esp')).json().capture_window, null);
  assert.equal((await upload(app, { capture_id: 'invalid-session', session_id: 'some-esp-session' })).statusCode, 400);
});

test('phone upload and result require App authentication; camera device credentials cannot access them', async t => {
  const { app } = await setup(t, undefined, { APP_ACCESS_TOKEN: 'fixture-app-token', DEVICE_ACCESS_TOKEN: 'fixture-device-token' });
  assert.equal((await upload(app)).statusCode, 401);
  assert.equal((await upload(app, {}, { 'x-device-token': 'fixture-device-token' })).statusCode, 401);
  assert.equal((await upload(app, {}, { 'x-app-token': 'fixture-app-token' })).statusCode, 201);
  assert.equal((await app.inject('/api/phone/captures/phone-fixture-1')).statusCode, 401);
});
