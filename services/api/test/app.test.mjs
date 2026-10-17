import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { ModelProvider } from '../src/provider.mjs';

// Tiny synthetic image fixture. It never represents a measured meal or real nutrition data.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1EAAAAASUVORK5CYII=', 'base64');
const epoch = new Date('2026-10-15T04:00:00.000Z');

async function setup(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'de-companion-test-'));
  let current = epoch;
  const app = await createApp({ env: {}, dataDir, clock: () => current, ...options });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { app, dataDir, advance(ms) { current = new Date(current.getTime() + ms); } };
}
function metadata(id = 'photo-1', extra = {}) {
  return { schema_version: 1, capture_id: id, device_id: 'sense-test', boot_id: 'boot-test', sequence: 1,
    captured_at: epoch.toISOString(), time_source: 'server', uptime_ms: 100, mime_type: 'image/png', ...extra };
}
async function upload(app, meta = null, route = '/api/capture', headers = {}, image = png) {
  const form = new FormData();
  form.append('image', new Blob([image], { type: 'image/png' }), 'fixture.png');
  if (meta) form.append('metadata', JSON.stringify(meta));
  const request = new Request(`http://localhost${route}`, { method: 'POST', body: form });
  return app.inject({ method: 'POST', url: route,
    headers: { 'content-type': request.headers.get('content-type'), ...headers },
    payload: Buffer.from(await request.arrayBuffer()) });
}
async function post(app, url, payload, headers) { return app.inject({ method: 'POST', url, payload, headers }); }

test('normal state has no invented meal or calorie; local model state is explicit', async t => {
  const { app } = await setup(t);
  const state = (await app.inject('/api/state')).json();
  assert.deepEqual(state.meals, []);
  assert.equal(state.config.analysisConfigured, false);
  assert.equal(state.config.chatMode, 'local-rules');
  assert.equal(state.device.paused, true);
  assert.equal(state.device.phoneConnected, false);
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].kind, 'virtual-life');
  assert.deepEqual(state.posts[0].sourceEventIds, []);
});

test('photo ingestion is durable and duplicate capture IDs never duplicate meals', async t => {
  const { app } = await setup(t);
  const first = await upload(app, metadata(), '/api/device/captures');
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().capture_id, 'photo-1');
  assert.equal(first.json().meal.analysis.calorieRange, null);
  assert.equal(first.json().meal.portionFraction, null);
  const duplicate = await upload(app, metadata(), '/api/device/captures');
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().duplicate, true);
  assert.equal(app.store.list('captures').length, 1);
  assert.equal(app.store.list('meals').length, 1);
  const media = await app.inject(first.json().meal.imageUrl);
  assert.equal(media.statusCode, 200);
  assert.deepEqual(media.rawPayload, png);
});

test('multiple camera frames belong to one candidate meal, and manual uploads stay separate', async t => {
  const { app } = await setup(t);
  for (let i = 0; i < 3; i++) {
    const response = await upload(app, metadata(`frame-${i}`, { sequence: i, session_id: 'meal-session' }), '/api/device/captures');
    assert.equal(response.statusCode, 201, response.body);
  }
  assert.equal(app.store.list('meals').length, 1);
  assert.equal(app.store.list('meals')[0].images.length, 3);
  await upload(app);
  assert.equal(app.store.list('meals').length, 2);
});

test('a new service instance reopens saved photos, portion corrections and posts', async t => {
  const { app, dataDir } = await setup(t);
  const { meal } = (await upload(app)).json();
  await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 0.5 });
  await post(app, `/api/meals/${meal.id}/confirm`, {});
  await app.close();
  const reopened = await createApp({ dataDir, env: {}, clock: () => epoch });
  try {
    const state = (await reopened.inject('/api/state')).json();
    assert.equal(state.meals[0].id, meal.id);
    assert.equal(state.meals[0].portionFraction, 0.5);
    assert.equal(state.meals[0].status, 'confirmed');
    assert.equal(state.posts.filter(post => post.mealId === meal.id).length, 1);
    const photo = await reopened.inject(state.meals[0].imageUrl);
    assert.deepEqual(photo.rawPayload, png);
  } finally { await reopened.close(); }
});

test('ID collision, invalid clock claims and disguised non-images are rejected', async t => {
  const { app } = await setup(t);
  await upload(app, metadata(), '/api/device/captures');
  const collision = await upload(app, metadata('photo-1', { device_id: 'other-device' }), '/api/device/captures');
  assert.equal(collision.statusCode, 409);
  const clock = await upload(app, metadata('unsynced', { time_source: 'unsynchronized' }), '/api/device/captures');
  assert.equal(clock.statusCode, 400);
  const image = await upload(app, null, '/api/capture', {}, Buffer.from('<svg onload="alert(1)"/>'));
  assert.equal(image.statusCode, 400);
  assert.equal(app.store.list('captures').length, 1);
});

test('a user must explicitly choose intake before confirming; confirmation posts are idempotent', async t => {
  const { app } = await setup(t);
  const { meal } = (await upload(app)).json();
  assert.equal((await post(app, `/api/meals/${meal.id}/confirm`, {})).statusCode, 400);
  const corrected = await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 0.5, expectedVersion: meal.version });
  assert.equal(corrected.statusCode, 200);
  const stale = await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 1, expectedVersion: meal.version });
  assert.equal(stale.statusCode, 409);
  const first = await post(app, `/api/meals/${meal.id}/confirm`, { expectedVersion: corrected.json().meal.version });
  const second = await post(app, `/api/meals/${meal.id}/confirm`, {});
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().duplicate, true);
  assert.equal(app.store.list('posts').filter(item => item.kind === 'shared-experience').length, 1);
  assert.equal(first.json().meal.consumedCalorieRange, null);
});

test('image inference needs explicit per-request consent and a configured model', async t => {
  const { app } = await setup(t);
  const { meal } = (await upload(app)).json();
  assert.equal((await post(app, `/api/meals/${meal.id}/analyze`, {})).statusCode, 400);
  assert.equal((await post(app, `/api/meals/${meal.id}/analyze`, { consentToUpload: true })).statusCode, 503);
  assert.equal(app.store.get('meals', meal.id).analysis.calorieRange, null);
});

test('model range and actual portion stay separate; repeated corrections do not compound', async t => {
  let calls = 0;
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'test-only-fixture',
    async analyze() { calls++; return { title: '测试用餐食', foods: [], calorieRange: { min: 600, max: 800 }, uncertainties: ['仅为测试夹具'] }; } };
  const { app } = await setup(t, { provider });
  const { meal } = (await upload(app)).json();
  assert.equal(calls, 0);
  const analyzed = await post(app, `/api/meals/${meal.id}/analyze`, { consentToUpload: true });
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(analyzed.json().meal.consumedCalorieRange, null);
  const half = await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 0.5 });
  assert.deepEqual(half.json().meal.consumedCalorieRange, { min: 300, max: 400 });
  const whole = await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 1 });
  assert.deepEqual(whole.json().meal.consumedCalorieRange, { min: 600, max: 800 });
  assert.equal(whole.json().meal.consumedMacros, null);
});

test('whole-plate macros scale by the confirmed portion only', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'test-only-fixture',
    async analyze() { return { title: '测试用餐食', foods: [], calorieRange: { min: 600, max: 800 }, macros: { proteinG: 30, carbsG: 81, fatG: 21 }, uncertainties: ['仅为测试夹具'] }; } };
  const { app } = await setup(t, { provider });
  const { meal } = (await upload(app)).json();
  const analyzed = await post(app, `/api/meals/${meal.id}/analyze`, { consentToUpload: true });
  assert.deepEqual(analyzed.json().meal.analysis.macros, { proteinG: 30, carbsG: 81, fatG: 21 });
  assert.equal(analyzed.json().meal.consumedMacros, null);
  const half = await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 0.5 });
  assert.deepEqual(half.json().meal.consumedMacros, { proteinG: 15, carbsG: 41, fatG: 11 });
});

test('a correction during remote analysis is preserved', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'test-only-fixture',
    analyze() { entered(); return new Promise(resolve => { release = resolve; }); } };
  const { app } = await setup(t, { provider });
  const { meal } = (await upload(app)).json();
  const pending = post(app, `/api/meals/${meal.id}/analyze`, { consentToUpload: true });
  await started;
  await post(app, `/api/meals/${meal.id}/correction`, { portionFraction: 0.5 });
  release({ title: '测试用餐食', foods: [], calorieRange: { min: 600, max: 800 }, uncertainties: ['测试数据'] });
  const response = await pending;
  assert.equal(response.json().meal.portionFraction, 0.5);
  assert.deepEqual(response.json().meal.consumedCalorieRange, { min: 300, max: 400 });
});

test('chat retry is idempotent and neither hypothetical nor explicit chat changes intake', async t => {
  const { app } = await setup(t);
  const { meal } = (await upload(app)).json();
  const body = { message: '我想只吃一半', clientMessageId: 'client-message-1' };
  const first = await post(app, '/api/chat', body);
  const second = await post(app, '/api/chat', body);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.json().message.id, first.json().message.id);
  assert.equal(app.store.get('meals', meal.id).portionFraction, null);
  assert.equal(app.store.list('messages').length, 2);
  const collision = await post(app, '/api/chat', { ...body, message: '不同内容' });
  assert.equal(collision.statusCode, 409);
  const correction = await post(app, '/api/chat', { message: '这餐只吃了一半' });
  assert.equal(correction.statusCode, 200);
  assert.equal(correction.json().message.mealProposal, undefined);
  assert.equal(app.store.get('meals', meal.id).portionFraction, null);
});

test('selected-meal chat persists a draft without changing either of multiple meals', async t => {
  const { app } = await setup(t);
  const first = (await upload(app)).json().meal;
  const second = (await upload(app)).json().meal;
  const body = { message: '一半，汤没喝', mealId: first.id, clientMessageId: 'selected-meal-draft' };
  const response = await post(app, '/api/chat', body);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json().message.mealProposal, {
    mealId: first.id, expectedVersion: first.version, portionFraction: 0.5, note: body.message,
  });
  assert.equal(response.json().message.mode, 'local-rules');
  assert.equal(response.json().message.mealId, first.id);
  for (const meal of [first, second]) {
    assert.equal(app.store.get('meals', meal.id).portionFraction, null);
    assert.equal(app.store.get('meals', meal.id).version, meal.version);
    assert.equal(app.store.get('meals', meal.id).confirmedAt, null);
  }
  const retry = await post(app, '/api/chat', body);
  assert.equal(retry.json().message.id, response.json().message.id);
  assert.deepEqual(retry.json().message.mealProposal, response.json().message.mealProposal);
  assert.equal((await post(app, '/api/chat', { ...body, mealId: second.id })).statusCode, 409);
  const state = (await app.inject('/api/state')).json();
  assert.deepEqual(state.messages.at(-1).mealProposal, response.json().message.mealProposal);
  const unclear = await post(app, '/api/chat', { message: '我没吃一半', mealId: first.id });
  assert.equal(unclear.json().message.mealProposal.portionFraction, null);
  assert.equal(app.store.get('meals', first.id).portionFraction, null);
  assert.equal((await post(app, '/api/chat', { message: '一半', mealId: 'absent-meal' })).statusCode, 404);
});

test('atomic meal confirmation rejects stale drafts and retries without duplicate events', async t => {
  const { app } = await setup(t);
  const meal = (await upload(app)).json().meal;
  const body = { expectedVersion: meal.version, portionFraction: 0.5, note: '一半，汤没喝' };
  assert.equal((await post(app, `/api/meals/${meal.id}/confirm`, { portionFraction: 0.5 })).statusCode, 400);
  await post(app, `/api/meals/${meal.id}/correction`, { expectedVersion: meal.version, portionFraction: 1 });
  assert.equal((await post(app, `/api/meals/${meal.id}/confirm`, body)).statusCode, 409);
  assert.equal(app.store.get('meals', meal.id).portionFraction, 1);
  assert.equal(app.store.get('meals', meal.id).confirmedAt, null);
  const beforeEvents = app.store.list('events').length;
  const current = app.store.get('meals', meal.id);
  const accepted = { ...body, expectedVersion: current.version };
  const first = await post(app, `/api/meals/${meal.id}/confirm`, accepted);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().meal.status, 'confirmed');
  assert.equal(first.json().meal.note, accepted.note);
  assert.equal(first.json().meal.portionFraction, 0.5);
  assert.equal(first.json().meal.corrections.length, 2);
  assert.equal(app.store.list('events').length, beforeEvents + 2);
  const retry = await post(app, `/api/meals/${meal.id}/confirm`, accepted);
  assert.equal(retry.statusCode, 200, retry.body);
  assert.equal(retry.json().duplicate, true);
  assert.equal(app.store.list('events').length, beforeEvents + 2);
  assert.equal((await post(app, `/api/meals/${meal.id}/confirm`, { ...accepted, portionFraction: 1 })).statusCode, 409);
  assert.equal(app.store.get('meals', meal.id).portionFraction, 0.5);
});

test('atomic confirmation rolls back the correction if recording confirmation fails', async t => {
  const { app } = await setup(t);
  const meal = (await upload(app)).json().meal;
  const beforeEvents = app.store.list('events').length;
  const recordEvent = app.store.event.bind(app.store);
  app.store.event = (type, references) => {
    if (type === 'meal.confirmed') throw new Error('synthetic transaction failure');
    return recordEvent(type, references);
  };
  const result = await post(app, `/api/meals/${meal.id}/confirm`, { expectedVersion: meal.version, portionFraction: 0.5, note: '测试补充' });
  assert.equal(result.statusCode, 500);
  assert.equal(app.store.get('meals', meal.id).portionFraction, null);
  assert.equal(app.store.get('meals', meal.id).corrections.length, 0);
  assert.equal(app.store.get('meals', meal.id).confirmedAt, null);
  assert.equal(app.store.get('meals', meal.id).version, meal.version);
  assert.equal(app.store.list('events').length, beforeEvents);
});

test('model history stays inside the selected meal or global conversation and gets no photo pixels', async t => {
  const calls = [];
  const provider = { visionConfigured: false, chatConfigured: true,
    async chat(message, history, context) { calls.push({ message, history, context }); return '尚未保存，等你确认。'; } };
  const { app } = await setup(t, { provider });
  const first = (await upload(app)).json().meal;
  const second = (await upload(app)).json().meal;
  await post(app, '/api/chat', { message: '全局话题' });
  await post(app, '/api/chat', { message: '第一餐话题', mealId: first.id });
  await post(app, '/api/chat', { message: '第二餐话题', mealId: second.id });
  await post(app, '/api/chat', { message: '继续第一餐', mealId: first.id });
  await post(app, '/api/chat', { message: '继续全局' });
  assert.deepEqual(calls[1].history, []);
  assert.deepEqual(calls[2].history, []);
  assert.deepEqual(calls[3].history.map(item => item.content), ['第一餐话题', '尚未保存，等你确认。']);
  assert.deepEqual(calls[4].history.map(item => item.content), ['全局话题', '尚未保存，等你确认。']);
  assert.equal(calls[3].context.selectedMeal.id, first.id);
  assert.equal('imageUrl' in calls[3].context.selectedMeal, false);
  assert.equal(calls[4].context.selectedMeal, null);
});

test('in-flight message retries preserve the selected meal and share one model response', async t => {
  let release;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const provider = { visionConfigured: false, chatConfigured: true,
    chat() { entered(); return new Promise(resolve => { release = resolve; }); } };
  const { app } = await setup(t, { provider });
  const first = (await upload(app)).json().meal;
  const second = (await upload(app)).json().meal;
  const body = { message: '汤没喝', mealId: first.id, clientMessageId: 'pending-scoped-message' };
  const pending = post(app, '/api/chat', body);
  await started;
  const collision = await post(app, '/api/chat', { ...body, mealId: second.id });
  assert.equal(collision.statusCode, 409);
  const retry = post(app, '/api/chat', body);
  release('食量还需要你选择。');
  const [accepted, repeated] = await Promise.all([pending, retry]);
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(repeated.json().message.id, accepted.json().message.id);
  assert.equal(app.store.list('messages').length, 2);
  assert.equal(accepted.json().message.mealProposal.portionFraction, null);
  assert.equal(accepted.json().message.mealProposal.mealId, first.id);
});

test('selected-meal conversation cannot start a fresh capture or silently change a meal via post reply', async t => {
  let classifications = 0;
  const trigger = { async classify() { classifications++; throw new Error('must not classify meal clarification'); } };
  const { app } = await setup(t, { trigger });
  const meal = (await upload(app)).json().meal;
  const result = await post(app, '/api/chat', { message: '准备吃饭', mealId: meal.id });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(classifications, 0);
  assert.equal(result.json().signal, null);
  const state = (await app.inject('/api/state')).json();
  const reply = await post(app, `/api/posts/${state.posts[0].id}/reply`, { message: '这餐只吃了一半' });
  assert.equal(reply.statusCode, 200, reply.body);
  assert.equal(app.store.get('meals', meal.id).portionFraction, null);
});

test('replying to an IP post persists both sides as a conversation', async t => {
  const { app } = await setup(t);
  const state = (await app.inject('/api/state')).json();
  const response = await post(app, `/api/posts/${state.posts[0].id}/reply`, { message: '你好，小伴' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().post.replies.length, 2);
  assert.equal(response.json().reply.mode, 'local-rules');
});

test('phone and camera status expire and do not falsely prove native rear-screen access', async t => {
  const { app, advance } = await setup(t);
  await app.inject('/api/device/config?device_id=sense-test');
  assert.equal((await app.inject('/api/state')).json().device.cameraConnected, false);
  await post(app, '/api/device/status', { device_id: 'sense-test', camera_ready: true });
  await post(app, '/api/phone/status', { device_id: 'phone-test', model: 'test', rootAvailable: false, rearDisplay: 'adb-relay' });
  const connected = (await app.inject('/api/state')).json().device;
  assert.equal(connected.cameraConnected, true);
  assert.equal(connected.phoneConnected, true);
  assert.equal(connected.rearDisplay, 'adb-relay');
  assert.equal(connected.rootAvailable, false);
  advance(100_000);
  const disconnected = (await app.inject('/api/state')).json().device;
  assert.equal(disconnected.phoneConnected, false);
  assert.equal(disconnected.cameraConnected, false);
  assert.equal(disconnected.rearDisplay, 'unverified');
});

test('pausing capture does not put the companion to sleep indefinitely', async t => {
  const { app, advance } = await setup(t);
  await app.inject('/api/state');
  await post(app, '/api/device/pause', { paused: true });
  await post(app, '/api/chat', { message: '你好，小伴' });
  assert.equal((await app.inject('/api/state')).json().companion.scene, 'listening');
  advance(60_000);
  const state = (await app.inject('/api/state')).json();
  assert.equal(state.device.paused, true);
  assert.equal(state.companion.scene, 'idle');
});

test('LAN hosting requires separate app/device credentials and blocks foreign browser origins', async t => {
  await assert.rejects(createApp({ env: { HOST: '0.0.0.0' } }), /requires/);
  const { app } = await setup(t, { env: { HOST: '0.0.0.0', APP_ACCESS_TOKEN: 'test-app-secret', DEVICE_ACCESS_TOKEN: 'test-device-secret' } });
  assert.equal((await app.inject('/api/state')).statusCode, 401);
  assert.equal((await app.inject('/api%2fstate')).statusCode, 401);
  assert.equal((await app.inject('/media%2fprivate.png')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/state', headers: { 'x-device-token': 'test-device-secret' } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/state', headers: { 'x-app-token': 'test-app-secret' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/device/config?device_id=sense-test', headers: { 'x-device-token': 'test-device-secret' } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/state', headers: { origin: 'https://foreign.invalid', 'x-app-token': 'test-app-secret' } })).statusCode, 403);
  const session = await post(app, '/api/session', { token: 'test-app-secret' });
  assert.equal(session.statusCode, 200);
  const cookie = session.headers['set-cookie'].split(';')[0];
  assert.equal((await app.inject({ url: '/api/state', headers: { cookie } })).statusCode, 200);
});

test('malformed model output is rejected instead of becoming a calorie fact', async () => {
  const provider = new ModelProvider({ FOOD_MODEL_BASE_URL: 'https://model.invalid/v1', FOOD_MODEL_API_KEY: 'test-only', FOOD_MODEL_NAME: 'fixture' },
    async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ foodDetected: true, title: '测试', foods: [], calorieRange: { min: 900, max: 100 }, uncertainties: ['测试'] }) } }] }), { status: 200 }));
  await assert.rejects(provider.analyze(png, 'image/png'), /有效的结构化/);
});

test('what the user said stays said: there is no message recall', async t => {
  const { app, advance } = await setup(t);
  const chat = (await post(app, '/api/chat', { message: '今天中午吃了什么来着' })).json();
  const mine = chat.state.messages.find(item => item.role === 'user');
  const reply = chat.state.messages.find(item => item.role === 'assistant');
  assert.equal(reply.replyToId, mine.id, 'the reply still points back at its question');

  // The route is gone, not merely time-limited: that is the whole point of the change.
  assert.equal((await post(app, `/api/chat/messages/${mine.id}/recall`, {})).statusCode, 404);
  assert.equal((await post(app, `/api/chat/messages/${reply.id}/recall`, {})).statusCode, 404);

  advance(24 * 3600_000);
  assert.equal((await post(app, `/api/chat/messages/${mine.id}/recall`, {})).statusCode, 404,
    'waiting never makes it recallable either');

  const messages = (await app.inject('/api/state')).json().messages;
  assert.equal(messages.some(item => item.id === mine.id), true);
  assert.equal(messages.some(item => item.id === reply.id), true);
  assert.equal(app.store.list('events').some(event => event.type === 'chat.recalled'), false);
});

test('a camera record stays removable with no time limit, and takes its suggestion with it', async t => {
  const { app, dataDir, advance } = await setup(t);
  const capture = (await upload(app, metadata('recall-without-limit'))).json();
  const mealId = capture.meal.id;
  const chat = (await post(app, '/api/chat', { message: '一半', mealId })).json();
  const mine = chat.state.messages.find(item => item.role === 'user');
  assert.equal(chat.state.meals.find(item => item.id === mealId).portionFraction, null);

  // A whole day later the photo record is still the user's to withdraw.
  advance(24 * 3600_000);
  const recalled = await post(app, `/api/meals/${mealId}/recall`, {});
  assert.equal(recalled.statusCode, 200);
  const state = recalled.json().state;
  assert.deepEqual(state.meals, []);
  assert.equal(state.messages.some(item => item.id === mine.id), true, 'the words that were typed stay');
  assert.equal(state.messages.some(item => item.mealProposal), false, 'the suggestion pointing at the photo goes with it');
  await assert.rejects(readFile(path.join(dataDir, 'media', capture.capture.filename)), /ENOENT/);
});

test('a meal can be withdrawn at any time, with its photos and suggestions', async t => {
  const { app, dataDir, advance } = await setup(t, { provider: new ModelProvider({ VISION_API_KEY: 'test-key', VISION_BASE_URL: 'http://127.0.0.1:9', VISION_MODEL: 'fixture' }) });
  const capture = (await upload(app, metadata('recall-meal-photo'))).json();
  const mealId = capture.meal.id;
  const chat = (await post(app, '/api/chat', { message: '吃了一半', mealId })).json();
  assert.equal(chat.state.messages.some(item => item.mealProposal), true);
  await post(app, `/api/meals/${mealId}/confirm`, { portionFraction: 0.5, note: '一半', expectedVersion: capture.meal.version });
  const confirmed = (await app.inject('/api/state')).json();
  assert.equal(confirmed.meals.length, 1);
  assert.equal(confirmed.meals[0].confirmedAt !== null, true);

  const before = await readFile(path.join(dataDir, 'media', capture.capture.filename));
  assert.ok(before.length > 0);

  advance(86_400_000);
  const recalled = await post(app, `/api/meals/${mealId}/recall`, {});
  assert.equal(recalled.statusCode, 200);
  const summary = recalled.json().recalled;
  assert.equal(summary.mealId, mealId);
  assert.equal(summary.confirmed, true);
  assert.equal(summary.portionFraction, 0.5);
  assert.equal(summary.captureCount, 1);
  assert.equal(summary.proposalCount, 1);

  const after = recalled.json().state;
  assert.deepEqual(after.meals, []);
  assert.equal(after.messages.some(item => item.mealProposal), false);
  assert.equal(after.posts.some(item => item.id === `meal-confirmed-${mealId}`), false);
  await assert.rejects(readFile(path.join(dataDir, 'media', capture.capture.filename)), /ENOENT/);

  const again = await post(app, `/api/meals/${mealId}/recall`, {});
  assert.equal(again.statusCode, 404);
  assert.match(again.json().error.message, /已经不在记录里/);
});

test('withdrawing one meal keeps the words the user typed and every other meal', async t => {
  const { app } = await setup(t);
  const first = (await upload(app, metadata('recall-keep-1'))).json();
  const second = (await upload(app, metadata('recall-keep-2'))).json();
  await post(app, '/api/chat', { message: '这餐吃了一半', mealId: first.meal.id });
  await post(app, '/api/chat', { message: '今天心情不错' });

  const recalled = await post(app, `/api/meals/${first.meal.id}/recall`, {}).then(response => response.json());
  assert.deepEqual(recalled.state.meals.map(meal => meal.id), [second.meal.id]);
  const contents = recalled.state.messages.map(item => item.content);
  assert.equal(contents.includes('这餐吃了一半'), true, 'the user keeps their own words');
  assert.equal(contents.includes('今天心情不错'), true);
  assert.equal(recalled.state.messages.some(item => item.mealProposal), false);
});

test('a poll that changes nothing is answered without rebuilding the page state', async t => {
  const { app, advance } = await setup(t);
  // The first read may still be writing the day's virtual post, so the marker is taken once the
  // page is genuinely settled.
  await app.inject('/api/state');
  const settled = await app.inject('/api/state');
  const etag = settled.headers.etag;
  assert.equal(settled.statusCode, 200);
  assert.match(etag, /^W\//);

  // Repeating the poll with the marker the page already holds returns no body at all.
  const unchanged = await app.inject({ url: '/api/state', headers: { 'if-none-match': etag } });
  assert.equal(unchanged.statusCode, 304);
  assert.equal(unchanged.rawPayload.length, 0);
  assert.equal(unchanged.headers.etag, etag);

  // A write has to move the marker, or the page would keep a stale payload forever.
  await post(app, '/api/profile', { nickname: '小禾' });
  const afterWrite = await app.inject({ url: '/api/state', headers: { 'if-none-match': etag } });
  assert.equal(afterWrite.statusCode, 200);
  assert.notEqual(afterWrite.headers.etag, etag);
  assert.equal(afterWrite.json().profile.nickname, '小禾');

  // So does a capture window expiring, which no write records.
  await post(app, '/api/device/pause', { paused: false });
  const opened = await post(app, '/api/signals/context', { signalId: 'poll-signal', text: '我准备去吃饭了', speaker: 'self',
    sourceContext: 'user-conversation', observedAt: epoch.toISOString(), dryRun: false });
  const window = opened.json().state.device.captureWindow;
  assert.equal(Boolean(window), true, 'a real signal opens a capture window');
  const before = await app.inject({ url: '/api/state', headers: { 'if-none-match': afterWrite.headers.etag } });
  assert.equal(before.statusCode, 200, 'opening a window changes the marker');
  advance(60_000);
  const expired = await app.inject({ url: '/api/state', headers: { 'if-none-match': before.headers.etag } });
  assert.equal(expired.statusCode, 200, 'the expiry is visible without a stored write');
  assert.equal(expired.json().device.captureWindow, null);
});

test('the page state carries the fields the page reads and not the evidence behind them', async t => {
  const { app } = await setup(t);
  const state = (await app.inject('/api/state')).json();
  assert.deepEqual(Object.keys(state).sort(),
    ['captures', 'companion', 'config', 'device', 'meals', 'messages', 'notices', 'now', 'posts', 'profile', 'reminder', 'schemaVersion', 'signals'].sort());
  assert.equal('chatMessages' in state, false, 'the conversation is sent once');
  assert.equal('partner' in state, false, 'the companion is sent once');
  assert.equal('dining' in state, false, 'dining has its own routes');

  // Signal frames travel as the decision the page shows, never as the transcript behind it.
  await post(app, '/api/device/pause', { paused: false });
  const opened = await post(app, '/api/signals/context', { signalId: 'pick-signal', text: '我准备去吃饭了', speaker: 'self',
    sourceContext: 'user-conversation', observedAt: epoch.toISOString(), dryRun: false });
  assert.equal(opened.statusCode, 200);
  const signals = (await app.inject('/api/state')).json().signals;
  assert.equal(signals.length, 1);
  assert.deepEqual(Object.keys(signals[0]).sort(), ['action', 'dryRun', 'reason', 'receivedAt', 'signalId', 'stage']);
  // The full record is still on disk: this is a wire format, not a decision to forget the evidence.
  assert.equal(typeof app.store.get('signals', 'pick-signal').localDecision, 'object');
});

test('a photo the review rejected is still the user\'s, so the page can show it', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only',
    async analyze() { return { foodDetected: false, imageQuality: 'clear', title: '合成夹具', foods: [],
      calorieRange: null, uncertainties: ['仅用于接口测试'] } } };
  const { app, dataDir } = await setup(t, { provider });
  // A phone capture is the route the handset uses; only that one is reviewed.
  await upload(app, metadata('kept-frame'), '/api/phone/captures');
  // The ACK cannot know the verdict yet: the review decides after the photo is safely stored.
  await app.reviewer.drain();
  const state = (await app.inject('/api/state')).json();
  assert.equal(state.meals.length, 0, 'a frame with no food never becomes a meal');
  assert.equal(state.captures.length, 1, 'the photo is listed even though no meal was created');
  assert.equal(state.captures[0].id, 'kept-frame');
  assert.equal(state.captures[0].source, 'phone');
  assert.match(state.captures[0].imageUrl, /^\/media\//);
  assert.equal(state.captures[0].review.status, 'no_food');
  assert.equal(state.captures[0].review.mealId, null);

  // The file is really there: this is a photo the user can still look at.
  const bytes = await readFile(path.join(dataDir, 'media', state.captures[0].imageUrl.replace('/media/', '')));
  assert.equal(bytes.length > 0, true);
});

test('a capture that belongs to a meal is not listed twice', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only',
    async analyze() { return { foodDetected: true, imageQuality: 'clear', title: '合成夹具',
      foods: [{ name: '合成测试食物', estimatedGrams: null }], calorieRange: { min: 100, max: 200 },
      uncertainties: ['仅用于接口测试'] } } };
  const { app } = await setup(t, { provider });
  await upload(app, metadata('meal-frame'), '/api/phone/captures');
  // The verdict decides whether a meal exists at all, so it is only certain after the review.
  await app.reviewer.drain();
  const state = (await app.inject('/api/state')).json();
  assert.equal(state.meals.length, 1, 'a frame with food does become a meal');
  assert.deepEqual(state.captures, [], 'a photo with its own meal is shown in the timeline, not twice');
});

test('a stored photo can be withdrawn, and takes its meal with it when it was the last one', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only',
    async analyze() { return { foodDetected: false, imageQuality: 'clear', title: '合成夹具', foods: [],
      calorieRange: null, uncertainties: ['仅用于接口测试'] } } };
  const { app, dataDir } = await setup(t, { provider });
  await upload(app, metadata('throwaway-frame'), '/api/phone/captures');
  await app.reviewer.drain();
  const before = (await app.inject('/api/state')).json();
  assert.equal(before.captures.length, 1);
  const filename = before.captures[0].imageUrl.replace('/media/', '');

  const recalled = await post(app, '/api/captures/throwaway-frame/recall', {});
  assert.equal(recalled.statusCode, 200);
  const summary = recalled.json().recalled;
  assert.equal(summary.captureId, 'throwaway-frame');
  assert.equal(summary.hadMeal, false);
  const after = recalled.json().state;
  assert.deepEqual(after.captures, [], 'the photo is gone from the page');
  assert.deepEqual(after.meals, []);
  // Rows first, files after: the photo really left the disk.
  await assert.rejects(readFile(path.join(dataDir, 'media', filename)), /ENOENT/);
  assert.equal(app.store.list('captures').length, 0);

  // Retrying a lost acknowledgement reports plainly instead of deleting something else.
  const again = await post(app, '/api/captures/throwaway-frame/recall', {});
  assert.equal(again.statusCode, 404);
  assert.match(again.json().error.message, /已经不在记录里/);
  assert.equal(app.store.list('events').some(event => event.type === 'capture.recalled'), true);
});

test('withdrawing the only photo of a meal removes the meal instead of leaving it empty', async t => {
  const provider = { visionConfigured: true, chatConfigured: false, visionModel: 'fixture-only',
    async analyze() { return { foodDetected: true, imageQuality: 'clear', title: '合成夹具',
      foods: [{ name: '合成测试食物', estimatedGrams: null }], calorieRange: { min: 100, max: 200 },
      uncertainties: ['仅用于接口测试'] } } };
  const { app } = await setup(t, { provider });
  await upload(app, metadata('only-frame'), '/api/phone/captures');
  await app.reviewer.drain();
  const withMeal = (await app.inject('/api/state')).json();
  assert.equal(withMeal.meals.length, 1);
  assert.equal(withMeal.meals[0].captureCount, 1);

  const recalled = await post(app, '/api/captures/only-frame/recall', {});
  assert.equal(recalled.statusCode, 200);
  assert.equal(recalled.json().recalled.hadMeal, true);
  assert.equal(recalled.json().recalled.mealIdWasLastPhoto, true);
  assert.deepEqual(recalled.json().state.meals, [], 'a meal with no photo left is withdrawn with it');
  assert.deepEqual(recalled.json().state.captures, []);
});
