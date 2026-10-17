import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { ContextTrigger } from '../src/trigger.mjs';

const epoch = new Date('2026-10-15T08:00:00.000Z');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1EAAAAASUVORK5CYII=', 'base64');
async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'de-context-test-'));
  let current = epoch;
  const app = await createApp({ env: {}, dataDir, clock: () => current, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, advance(ms) { current = new Date(current.getTime() + ms); } };
}
const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const input = (extra = {}) => ({ signalId: 'voice-1', text: '我要去吃饭了', speaker: 'self',
  sourceContext: 'user-conversation', observedAt: epoch.toISOString(), dryRun: false, ...extra });
const config = app => app.inject('/api/device/config?device_id=public-fixture-camera').then(response => response.json());
// Synthetic distribution tests the transport contract, not real model accuracy.
const nativeDecision = () => ({ model: 'decider-0.8b-q4',
  modelSha256: '5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a',
  runtime: 'llama.cpp-android-cpu', stage: 'eating_now', probability: 0.7, margin: 0.65,
  distribution: { start_soon: 0.05, invited: 0.05, eating_now: 0.7, finished: 0.05, declined: 0.05, unrelated: 0.05, uncertain: 0.05 },
  wallMs: 123, temperature: 1.03 });
async function upload(app, window, sequence) {
  const form = new FormData();
  form.append('image', new Blob([png], { type: 'image/png' }), 'fixture.png');
  form.append('metadata', JSON.stringify({ schema_version: 1, capture_id: `frame-${sequence}`,
    device_id: 'public-fixture-camera', boot_id: 'fixture-boot', sequence,
    captured_at: epoch.toISOString(), time_source: 'server', uptime_ms: sequence * 15000,
    mime_type: 'image/png', session_id: window.session_id, capture_window_id: window.id, capture_phase: window.phase }));
  const request = new Request('http://localhost/api/device/captures', { method: 'POST', body: form });
  return app.inject({ method: 'POST', url: '/api/device/captures',
    headers: { 'content-type': request.headers.get('content-type') }, payload: Buffer.from(await request.arrayBuffer()) });
}

test('phone decision bypasses host inference, retains model provenance and respects ASR/media gates', async t => {
  let hostCalls = 0;
  const trigger = new ContextTrigger({ JEV_URL: 'http://127.0.0.1:8150' }, async () => { hostCalls++; throw new Error('host should not run'); });
  const { app } = await setup(t, { trigger });
  await post(app, '/api/device/pause', { paused: false });
  const local = nativeDecision();
  const body = input({ localDecision: local, speaker: 'unknown', sourceContext: 'unknown' });
  const response = await post(app, '/api/signals/context', body);
  assert.equal(response.statusCode, 200, response.body);
  const saved = response.json().signal;
  assert.equal(saved.action, 'capture_window');
  assert.equal(saved.classification.modelAssessment.execution, 'android-local');
  assert.equal(saved.localDecision.modelSha256, local.modelSha256);
  assert.equal(hostCalls, 0);
  assert.equal((await config(app)).capture_window.remaining, 1);
  assert.equal(app.store.list('meals').length, 0);
  assert.equal((await post(app, '/api/signals/context', body)).json().signal.duplicate, true);
  assert.equal((await post(app, '/api/signals/context', { ...body, localDecision: { ...local, wallMs: 124 } })).statusCode, 409);
  await post(app, '/api/device/pause', { paused: true });
  await post(app, '/api/device/pause', { paused: false });
  app.store.settings({ lastTriggerAt: null });
  for (const override of [{ sourceContext: 'media' }, { sourceContext: 'test-fixture' },
    { asrEvidence: { audioSha256: '0'.repeat(64), windowStartSec: 0, windowEndSec: 1,
      languageTag: null, emotionTag: null, eventTag: null, speechVadVerified: false } }]) {
    const blocked = await post(app, '/api/signals/context', { ...body, signalId: app.store.id('blocked'), ...override });
    assert.equal(blocked.json().signal.action, 'ignore');
    assert.equal((await config(app)).capture_window, null);
  }
  assert.equal(hostCalls, 0);
});

test('phone decision rejects changed model identity and inconsistent probabilities', async t => {
  const { app } = await setup(t);
  const local = nativeDecision();
  for (const changed of [{ modelSha256: '0'.repeat(64) }, { probability: 0.99 }, { margin: 0.1 },
    { stage: 'unrelated' }, { runtime: 'mac-cpu' }, { distribution: { ...local.distribution, invited: 0.9 } }]) {
    const response = await post(app, '/api/signals/context', input({ localDecision: { ...local, ...changed } }));
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal(app.store.list('signals').length, 0);
});

test('preparing to eat is sufficient, not-eaten-yet is not refusal, and raw model error cannot claim intake', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const wrongModel = nativeDecision();
  wrongModel.stage = 'declined';
  wrongModel.distribution = { ...wrongModel.distribution, eating_now: 0.05, declined: 0.7 };
  const preparationPhrases = ['我要去吃饭。', '我还没吃饭，准备去吃饭了', '还没有吃，准备去食堂', '我们马上去餐厅', '准备去吃午饭', '我准备吃一点东西'];
  for (const [index, text] of preparationPhrases.entries()) {
    app.store.settings({ lastTriggerAt: null });
    const response = await post(app, '/api/signals/context', input({ signalId: `preparing-${index}`, text,
      speaker: 'unknown', sourceContext: 'unknown', localDecision: wrongModel }));
    assert.equal(response.statusCode, 200, response.body);
    const { signal, state } = response.json();
    assert.equal(signal.classification.stage, 'start_soon', text);
    assert.equal(signal.classification.ingestionConfirmed, false);
    assert.equal(signal.classification.modelAssessment.stage, 'declined', 'Retain raw model error honestly');
    assert.equal(signal.action, 'capture_window', text);
    assert.equal(state.device.captureWindow.remaining, 1);
    assert.equal(state.meals.length, 0);
  }
  for (const [index, text] of ['我不准备去吃饭', '我没有准备去吃饭', '明天准备去吃饭', '他准备去吃饭', '比如准备去吃饭这句话'].entries()) {
    const response = await post(app, '/api/signals/context', input({ signalId: `not-preparing-${index}`, text,
      speaker: 'unknown', sourceContext: 'unknown', localDecision: nativeDecision() }));
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().signal.action, 'ignore', text);
  }
});

test('phone observation time is derived from the recording anchor, and synthetic timing cannot trigger', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const asrEvidence = { languageTag: '<|zh|>', emotionTag: '<|NEUTRAL|>', eventTag: '<|Speech|>',
    windowStartSec: 0, windowEndSec: 10, audioSha256: '0'.repeat(64), speechVadVerified: true,
    captureId: 'contract-fixture-only', captureStartedAt: new Date(epoch.getTime() - 20000).toISOString(),
    frameOffset: 160000, frames: 160000, sampleRate: 16000, timeSource: 'audio_record_start_estimate' };
  const valid = await post(app, '/api/signals/context', input({ asrEvidence, localDecision: nativeDecision(), dryRun: true }));
  assert.equal(valid.statusCode, 200, valid.body);
  assert.equal(valid.json().signal.observedAt, epoch.toISOString());
  assert.equal(valid.json().signal.action, 'capture_window');
  const processingTime = await post(app, '/api/signals/context', input({ asrEvidence,
    observedAt: new Date(epoch.getTime() + 5000).toISOString() }));
  assert.equal(processingTime.statusCode, 400);
  const pastChunkEnd = await post(app, '/api/signals/context', input({ asrEvidence: { ...asrEvidence, frames: 16000 } }));
  assert.equal(pastChunkEnd.statusCode, 400);
  const synthetic = await post(app, '/api/signals/context', input({ asrEvidence: { ...asrEvidence, timeSource: 'synthetic_fixture' } }));
  assert.equal(synthetic.json().signal.action, 'ignore');
  assert.equal((await config(app)).capture_window, null);
});

test('context is dry-run by default; explicit self plan opens bounded capture without inventing a meal', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  assert.equal((await config(app)).paused, true, 'signals mode waits for a real trigger');
  const { dryRun, ...body } = input();
  const preview = (await post(app, '/api/signals/context', body)).json();
  assert.equal(preview.signal.action, 'capture_window');
  assert.equal(preview.signal.dryRun, true);
  assert.equal(app.store.list('signals').length, 0);
  assert.equal((await config(app)).capture_window, null);
  const applied = await post(app, '/api/signals/context', input({ signalId: 'x'.repeat(128) }));
  assert.equal(applied.statusCode, 200, applied.body);
  const state = applied.json().state;
  assert.equal(state.meals.length, 0);
  assert.equal(state.companion.scene, 'collecting');
  assert.equal(Date.parse(state.device.captureWindow.expiresAt) - epoch.getTime(), 45000);
  const camera = await config(app);
  assert.equal(camera.paused, false);
  assert.equal(camera.capture_window.remaining, 1);
  assert.equal(camera.capture_window.phase, 'probe');
  assert.equal(camera.capture_interval_seconds, 15);
  assert.ok(camera.capture_window.id.length <= 128);
  const again = (await post(app, '/api/signals/context', input({ signalId: 'x'.repeat(128) }))).json();
  assert.equal(again.signal.duplicate, true);
  assert.equal(app.store.list('signals').length, 1);
  const conflict = await post(app, '/api/signals/context', input({ signalId: 'x'.repeat(128), text: '我正在吃饭' }));
  assert.equal(conflict.statusCode, 409);
});

test('invitation may probe one frame; recent acceptance is understood without resetting the existing budget', async t => {
  const { app, advance } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const invite = (await post(app, '/api/signals/context', input({ text: '你要不要一起吃午饭？', speaker: 'other' }))).json();
  assert.equal(invite.signal.action, 'capture_window');
  const probe = (await config(app)).capture_window;
  assert.equal(probe.remaining, 1);
  const chatInvite = await post(app, '/api/chat', { message: '要不要一起吃午饭？', clientMessageId: 'invitation' });
  assert.equal(chatInvite.statusCode, 200);
  const accept = (await post(app, '/api/chat', { message: '好啊，走吧', clientMessageId: 'accept' })).json();
  assert.equal(accept.signal.classification.stage, 'start_soon');
  assert.equal(accept.signal.reason, 'capture_cooldown');
  assert.deepEqual((await config(app)).capture_window, probe);
  assert.equal(accept.state.meals.length, 0);
  advance(6 * 60000);
  const old = (await post(app, '/api/chat', { message: '好啊，走吧', clientMessageId: 'unrelated-accept' })).json();
  assert.equal(old.signal.action, 'defer');
  assert.equal(old.state.device.captureWindow, null);
});

test('media, others, hypotheticals and stale speech cannot trigger; unknown speaker may request only a first-photo probe', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const blocked = [
    { sourceContext: 'media' }, { sourceContext: 'test-fixture' }, { speaker: 'other' },
    { text: '明天我要去吃饭了' }, { text: '如果我要去吃饭呢' },
    { text: '他要去吃饭了' }, { text: '我不是要去吃饭' },
    { text: '他说我要去吃饭了' }, { text: '比如我要去吃饭了这句话' }, { text: '我正在吃药' },
    { observedAt: new Date(epoch.getTime() - 121000).toISOString() },
    { observedAt: new Date(epoch.getTime() + 11000).toISOString() },
  ];
  for (let i = 0; i < blocked.length; i++) {
    const response = await post(app, '/api/signals/context', input({ signalId: `blocked-${i}`, ...blocked[i] }));
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(['ignore', 'defer', 'cancel'].includes(response.json().signal.action), response.body);
    assert.equal((await config(app)).capture_window, null);
  }
  const unknown = (await post(app, '/api/signals/context', input({ signalId: 'unknown', speaker: 'unknown', sourceContext: 'unknown' }))).json();
  assert.equal(unknown.signal.action, 'capture_window');
  assert.equal(unknown.state.device.captureWindow.remaining, 1);
  assert.equal(unknown.state.meals.length, 0);
  const repeat = (await post(app, '/api/signals/context', input({ signalId: 'unknown-repeat', speaker: 'unknown', sourceContext: 'unknown' }))).json();
  assert.equal(repeat.signal.reason, 'capture_cooldown');
});

test('capture budget, expiry, cancellation and pause stop new photos without dropping uploaded evidence', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only', async analyze() {
    return { foodDetected: true, imageQuality: 'clear', title: '合成夹具', foods: [], calorieRange: null, uncertainties: ['合成测试，不是真实餐食'] };
  } };
  const { app, advance } = await setup(t, { provider });
  await post(app, '/api/device/pause', { paused: false });
  await post(app, '/api/signals/context', input());
  const probe = (await config(app)).capture_window;
  assert.equal((await upload(app, probe, 0)).statusCode, 201);
  await app.reviewer.drain();
  const followup = (await config(app)).capture_window;
  assert.equal(followup.phase, 'followup');
  assert.equal(followup.session_id, probe.session_id);
  assert.notEqual(followup.id, probe.id);
  for (let i = 1; i < 3; i++) {
    assert.equal((await upload(app, followup, i)).statusCode, 201);
    assert.equal((await config(app)).capture_window?.remaining ?? 0, 2 - i);
  }
  assert.equal((await config(app)).paused, true);
  assert.equal(app.store.list('meals').length, 1);
  assert.equal(app.store.list('meals')[0].portionFraction, null);
  advance(6 * 60000);
  const next = input({ signalId: 'next', observedAt: new Date(epoch.getTime() + 6 * 60000).toISOString() });
  await post(app, '/api/signals/context', next);
  assert.ok((await config(app)).capture_window);
  const staleCancel = await post(app, '/api/signals/context', input({ signalId: 'old-stop', text: '我不吃了' }));
  assert.equal(staleCancel.json().signal.reason, 'stale_or_future_signal');
  assert.ok((await config(app)).capture_window);
  const cancel = await post(app, '/api/signals/context', { ...next, signalId: 'stop', text: '我不吃了' });
  assert.equal(cancel.json().signal.action, 'cancel');
  assert.equal((await config(app)).capture_window, null);
  advance(6 * 60000);
  await post(app, '/api/signals/context', { ...next, signalId: 'third', observedAt: new Date(epoch.getTime() + 12 * 60000).toISOString() });
  advance(45001);
  assert.equal((await config(app)).capture_window, null);
  assert.equal((await app.inject('/api/state')).json().device.captureWindow, null);
  await post(app, '/api/device/pause', { paused: true });
  assert.equal((await app.inject('/api/state')).json().reminder, null);
  assert.equal(app.store.list('captures').length, 3);
});

test('uncalibrated model remains advisory; possible meal intent can only unlock a first frame', async t => {
  let calls = 0;
  const trigger = new ContextTrigger({ JEV_URL: 'http://127.0.0.1:8149' }, async () => {
    calls++;
    return new Response(JSON.stringify({ model: 'fixture-only', results: [{ answers: [{ id: 'meal_stage',
      value: 'eating_now', top_probability: 0.21, margin: 0.01, distribution: { eating_now: 0.21 } }] }], usage: { wall_ms: 5 } }));
  });
  const { app } = await setup(t, { trigger });
  await post(app, '/api/device/pause', { paused: false });
  const direct = (await post(app, '/api/signals/context', input())).json();
  assert.equal(direct.signal.action, 'capture_window');
  assert.equal(direct.signal.classification.source, 'local-rules');
  assert.equal(direct.signal.classification.modelAssessment.probability, 0.21);
  assert.equal(direct.signal.classification.domainCalibrated, false);
  await post(app, '/api/device/pause', { paused: true });
  await post(app, '/api/device/pause', { paused: false });
  app.store.settings({ lastTriggerAt: null });
  const modelOnly = (await post(app, '/api/signals/context', input({ signalId: 'model-only', text: '有点饿了' }))).json();
  assert.equal(modelOnly.signal.action, 'capture_window');
  assert.equal(modelOnly.state.device.captureWindow.phase, 'probe');
  assert.equal(modelOnly.state.device.captureWindow.remaining, 1);
  const unrelated = await trigger.classify(input({ text: '今天天气不错', recentUtterances: [] }));
  assert.equal(unrelated.reason, 'no_meal_context');
  assert.equal(calls, 2);
});

test('speech requires VAD evidence and preserves raw tags, timing and SHA without inventing event scores', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const evidence = { languageTag: 'zh', emotionTag: null, eventTag: 'Speech', windowStartSec: 0.3,
    windowEndSec: 2.5, audioSha256: 'a'.repeat(64), speechVadVerified: false };
  const rejected = (await post(app, '/api/signals/context', input({ asrEvidence: evidence }))).json();
  assert.equal(rejected.signal.action, 'ignore');
  assert.equal(rejected.signal.reason, 'unverified_speech_segment');
  const accepted = (await post(app, '/api/signals/context', input({ signalId: 'vad-ok', asrEvidence: { ...evidence, speechVadVerified: true },
    audioEvents: [], speaker: 'unknown', sourceContext: 'unknown' }))).json();
  assert.equal(accepted.signal.action, 'capture_window');
  assert.deepEqual(accepted.signal.asrEvidence, { ...evidence, speechVadVerified: true });
  assert.equal(accepted.state.device.captureWindow.remaining, 1);
});

test('chat model failure can be retried without changing the original capture signal or observation time', async t => {
  let calls = 0;
  const provider = { visionConfigured: false, chatConfigured: true, async chat() {
    if (++calls === 1) throw Object.assign(new Error('fixture upstream outage'), { statusCode: 502 });
    return '好，我在这里。';
  } };
  const { app, advance } = await setup(t, { provider });
  await post(app, '/api/device/pause', { paused: false });
  const body = { message: '我要去吃饭了', clientMessageId: 'stable-retry' };
  const failure = await post(app, '/api/chat', body);
  assert.equal(failure.statusCode, 502);
  const before = (await config(app)).capture_window;
  advance(10000);
  const retry = await post(app, '/api/chat', body);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().signal.duplicate, true);
  assert.deepEqual((await config(app)).capture_window, before);
  assert.equal(app.store.list('signals').length, 1);
  assert.equal(app.store.list('messages').length, 2);
  const conflict = await post(app, '/api/chat', { ...body, message: '换一段消息' });
  assert.equal(conflict.statusCode, 409);
});

test('the cooldown blocks a second probe by default', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const first = await post(app, '/api/signals/context', input({ signalId: 'cooldown-default-a' }));
  assert.equal(first.json().signal.action, 'capture_window');
  const second = await post(app, '/api/signals/context', input({ signalId: 'cooldown-default-b' }));
  assert.equal(second.json().signal.reason, 'capture_cooldown');
});

test('CAPTURE_COOLDOWN_MS lets a bench session open probes back to back', async t => {
  const { app } = await setup(t, { env: { CAPTURE_COOLDOWN_MS: '0' } });
  await post(app, '/api/device/pause', { paused: false });
  const first = await post(app, '/api/signals/context', input({ signalId: 'cooldown-override-a' }));
  assert.equal(first.json().signal.action, 'capture_window');
  const second = await post(app, '/api/signals/context', input({ signalId: 'cooldown-override-b' }));
  assert.equal(second.json().signal.action, 'capture_window', 'bench override skips the wait');
});

test('哈比看看 opens a bounded board capture window and skips the cooldown', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const first = await post(app, '/api/signals/context', input({ signalId: 'board-cmd-a', text: '哈比看看' }));
  const plan = first.json().signal;
  assert.equal(plan.action, 'capture_window', first.body);
  assert.equal(plan.reason, 'explicit_board_command');
  assert.equal((await config(app)).capture_window.remaining, 1);
  // A second explicit command must not be deferred by the five minute trigger cooldown.
  const second = await post(app, '/api/signals/context', input({ signalId: 'board-cmd-b', text: '哈比看看' }));
  assert.equal(second.json().signal.action, 'capture_window');
  assert.equal(second.json().signal.reason, 'explicit_board_command');
});

test('哈比看看 is a whole-utterance command, not a substring trigger', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  for (const [index, text] of ['他说哈比看看', '明天哈比看看', '哈比不要看看'].entries()) {
    const response = await post(app, '/api/signals/context', input({ signalId: `board-cmd-neg-${index}`, text }));
    assert.notEqual(response.json().signal.reason, 'explicit_board_command', text);
  }
});

test('哈比记录 still asks the phone camera instead of the board', async t => {
  const { app } = await setup(t);
  await post(app, '/api/device/pause', { paused: false });
  const response = await post(app, '/api/signals/context', input({ signalId: 'phone-cmd-a', text: '哈比记录' }));
  assert.equal(response.json().signal.action, 'phone_capture');
  assert.equal((await config(app)).capture_window, null);
});
