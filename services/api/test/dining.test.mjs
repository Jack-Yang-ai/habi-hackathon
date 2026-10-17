import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';
import { AmapProvider, normalizePoi } from '../src/amap.mjs';
import { mealContext, openingState } from '../src/dining.mjs';

// Entirely synthetic POIs and routes. No real restaurant, user position or nutrition measurement.
const epoch = new Date('2026-10-15T03:40:00.000Z');
const key = 'synthetic-server-amap-key-never-return';
const origin = { longitude: 116.397, latitude: 39.908, coordinateSystem: 'gcj02' };
const pois = [
  { id: 'B_FIXTURE_A', name: '测试蒸食店', typecode: '050100', type: '餐饮服务;中餐厅', location: '116.398,39.908', address: '合成地址 A',
    business: { tag: '蒸菜', cost: '38', rating: '4.5', opentime_today: '10:00-22:00' } },
  { id: 'B_FIXTURE_B', name: '测试轻食店', typecode: '050200', type: '餐饮服务;西餐厅', location: '116.400,39.908', address: '合成地址 B',
    business: { tag: '轻食;沙拉', cost: '46', opentime_today: '10:00-22:00' } },
  { id: 'B_FIXTURE_C', name: '测试清汤店', typecode: '050100', type: '餐饮服务;中餐厅', location: '116.403,39.908', address: '合成地址 C',
    business: { tag: '清汤', cost: '32' } },
];
const response = body => new Response(JSON.stringify({ status: '1', infocode: '10000', ...body }), { headers: { 'Content-Type': 'application/json' } });
function fakeAmap(options = {}) {
  const calls = [];
  const fetcher = async (input, init) => {
    const url = new URL(input);
    calls.push({ path: url.pathname, params: Object.fromEntries(url.searchParams) });
    assert.equal(url.origin, 'https://restapi.amap.com');
    assert.equal(url.searchParams.get('key'), key);
    assert.equal(init.redirect, 'error');
    if (options.intercept) {
      const override = await options.intercept(url, init);
      if (override) return override;
    }
    if (url.pathname.endsWith('/convert')) return response({ locations: '116.397000,39.908000' });
    if (url.pathname.endsWith('/around')) return response({ pois: options.pois ?? pois });
    if (url.pathname.endsWith('/detail')) return response({ pois: (options.pois ?? pois).filter(poi => poi.id === url.searchParams.get('id')) });
    if (url.pathname.endsWith('/walking')) return response({ route: { paths: [{ distance: '600', cost: { duration: '480' } }] } });
    throw new Error('Unexpected Amap endpoint');
  };
  return { fetcher, calls };
}
async function setup(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'habi-dining-test-'));
  let now = epoch;
  const upstream = fakeAmap(options.amap);
  const settings = { dataDir: directory, env: { AMAP_WEB_SERVICE_KEY: key, AMAP_SEARCH_KEYWORDS_MAX: '3', ...options.env },
    amapFetcher: upstream.fetcher, clock: () => now, diningScheduler: false, ...options.app };
  let app = await createApp(settings);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { get app() { return app; }, upstream, directory, now: () => now,
    advance(ms) { now = new Date(now.getTime() + ms); },
    async reopen() { await app.close(); app = await createApp(settings); await app.dining.idle(); } };
}
const post = (app, url, payload, headers) => app.inject({ method: 'POST', url, payload, headers });
async function locate(ctx, extra = {}) {
  const result = await post(ctx.app, '/api/dining/location', { ...origin, accuracyMeters: 15, observedAt: ctx.now().toISOString(), ...extra });
  assert.equal(result.statusCode, 200, result.body);
  return result;
}
async function generate(ctx, requestId = 'manual-1') {
  const queued = await post(ctx.app, '/api/dining/recommendations', { requestId });
  assert.equal(queued.statusCode, 202, queued.body);
  await ctx.app.dining.idle();
  return (await ctx.app.inject(`/api/dining/requests/${requestId}`)).json();
}
const signal = (ctx, extra = {}) => ({ signalId: ctx.app.store.id('voice'), text: '我准备去吃午饭', speaker: 'self',
  sourceContext: 'user-conversation', observedAt: ctx.now().toISOString(), dryRun: false, ...extra });

test('dining is additive, opt-in, app-authorized and never returns the server key or raw position', async t => {
  const ctx = await setup(t, { env: { APP_ACCESS_TOKEN: 'synthetic-app', DEVICE_ACCESS_TOKEN: 'synthetic-device' } });
  for (const url of ['/api/dining', '/api/dining/deliveries', '/api/dining/recommendations/unknown/navigation']) {
    assert.equal((await ctx.app.inject(url)).statusCode, 401);
    assert.equal((await ctx.app.inject({ url, headers: { 'x-device-token': 'synthetic-device' } })).statusCode, 401);
  }
  const headers = { 'x-app-token': 'synthetic-app' };
  const state = await ctx.app.inject({ url: '/api/dining', headers });
  assert.equal(state.statusCode, 200);
  assert.equal(state.json().preferences.proactiveEnabled, false);
  assert.equal(state.json().config.configured, true);
  assert.equal(state.json().card, null);
  assert.equal(state.body.includes(key), false);
  const saved = await post(ctx.app, '/api/dining/location', { ...origin, accuracyMeters: 15, observedAt: epoch.toISOString() }, headers);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.body.includes('longitude'), false);
  for (const payload of [{ key }, { radiusMeters: 100 }, { maxCostYuan: -1 }, { mealTimes: { lunch: '25:00' } }, { mealTimes: { lunch: '08:00' } }])
    assert.equal((await post(ctx.app, '/api/dining/preferences', payload, headers)).statusCode, 400);
});

test('no key, missing/stale/inaccurate location and invalid inputs do not call Amap or invent cards', async t => {
  const ctx = await setup(t, { env: { AMAP_WEB_SERVICE_KEY: '' } });
  assert.equal((await post(ctx.app, '/api/dining/recommendations', { requestId: 'missing-key' })).statusCode, 503);
  assert.equal(ctx.upstream.calls.length, 0);
  const configured = await setup(t);
  assert.equal((await post(configured.app, '/api/dining/recommendations', { requestId: 'missing-position' })).statusCode, 409);
  await locate(configured, { accuracyMeters: 1000 });
  assert.equal((await post(configured.app, '/api/dining/recommendations', { requestId: 'coarse' })).statusCode, 409);
  configured.advance(1);
  await locate(configured);
  configured.advance(300001);
  assert.equal((await post(configured.app, '/api/dining/recommendations', { requestId: 'stale' })).statusCode, 409);
  for (const changed of [{ latitude: 91 }, { longitude: '116.397' }, { coordinateSystem: 'unknown' }, { accuracyMeters: -1 }, { observedAt: 'bad' }])
    assert.equal((await post(configured.app, '/api/dining/location', { ...origin, accuracyMeters: 10, observedAt: configured.now().toISOString(), ...changed })).statusCode, 400);
  assert.equal(configured.upstream.calls.length, 0);
  assert.equal((await configured.app.inject('/api/dining')).json().card, null);
});

test('full recommend, durable request replay, never-repeat swap, navigation and selection lifecycle', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  const result = await generate(ctx);
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result));
  let card = result.card;
  assert.equal(card.layout, 'single');
  assert.equal(card.restaurant.id, pois[0].id);
  assert.equal(card.restaurant.walking.durationSeconds, 480);
  assert.equal(card.restaurant.walking.distanceMeters, 600);
  assert.equal(card.recommendation.nutrition, null);
  assert.equal(card.recommendation.reasons[0].field, 'business.tag');
  assert.equal(card.mealKey, '2026-10-15:lunch');
  for (const privateField of ['origin', 'inputLocation', 'candidates', 'seenPoiIds', 'preferences']) assert.equal(privateField in card, false);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.equal(ctx.upstream.calls.filter(call => call.path.endsWith('/around')).length, 3);
  assert.deepEqual(new Set(ctx.upstream.calls.filter(call => call.path.endsWith('/around')).map(call => call.params.keywords)), new Set(['蒸菜', '轻食', '清汤']));
  const calls = ctx.upstream.calls.length;
  const replay = await post(ctx.app, '/api/dining/recommendations', { requestId: 'manual-1' });
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.json().duplicate, true);
  assert.equal(ctx.upstream.calls.length, calls);
  const seen = new Set([card.restaurant.id]);
  for (let index = 0; index < 2; index++) {
    const requestId = `swap-${index}`;
    const url = `/api/dining/recommendations/${card.id}/swap`;
    const payload = { requestId, expectedVersion: card.version };
    assert.equal((await post(ctx.app, url, { ...payload, expectedVersion: 100 })).statusCode, 409);
    assert.equal((await post(ctx.app, url, payload)).statusCode, 202);
    await ctx.app.dining.idle();
    card = (await ctx.app.inject(`/api/dining/requests/${requestId}`)).json().card;
    assert.equal(seen.has(card.restaurant.id), false);
    seen.add(card.restaurant.id);
    assert.equal((await post(ctx.app, url, payload)).json().duplicate, true);
  }
  assert.equal(card.actions.swapAvailable, false);
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/swap`, { requestId: 'no-more', expectedVersion: card.version })).statusCode, 409);
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/swap`, { requestId: 'manual-1', expectedVersion: card.version })).statusCode, 409);
  const navigation = (await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).json();
  const link = new URL(navigation.url);
  assert.equal(link.origin, 'https://uri.amap.com');
  assert.equal(link.searchParams.get('mode'), 'walk');
  assert.equal(link.searchParams.get('callnative'), '1');
  assert.ok(link.searchParams.get('to').includes(card.restaurant.name));
  assert.equal(link.searchParams.has('key'), false);
  const selectBody = { requestId: 'select-1', expectedVersion: card.version };
  const selected = await post(ctx.app, `/api/dining/recommendations/${card.id}/select`, selectBody);
  assert.equal(selected.json().card.status, 'selected');
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/select`, selectBody)).json().duplicate, true);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 200);
  await ctx.reopen();
  assert.equal((await ctx.app.inject('/api/dining')).json().card.status, 'selected');
  assert.equal((await ctx.app.inject('/api/state')).json().meals.length, 0);
});

test('proactive self intent is independent of photo pause; unknown/media/old/dry-run sources cannot recommend', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  await post(ctx.app, '/api/signals/context', signal(ctx));
  assert.equal(ctx.app.store.list('diningJobs').length, 0);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true });
  for (const extra of [{ speaker: 'unknown' }, { sourceContext: 'media' }, { sourceContext: 'test-fixture' }, { dryRun: true },
    { observedAt: new Date(epoch.getTime() - 120001).toISOString() }, { text: '明天去吃饭' }, { text: '他准备去吃饭', speaker: 'other' }]) {
    await post(ctx.app, '/api/signals/context', signal(ctx, extra));
    await ctx.app.dining.idle();
    assert.equal(ctx.app.store.list('diningJobs').length, 0, JSON.stringify(extra));
  }
  const body = signal(ctx);
  const requested = await post(ctx.app, '/api/signals/context', body);
  assert.equal(requested.statusCode, 200, requested.body);
  assert.equal(requested.json().state.device.paused, true);
  assert.equal(requested.json().dining.job.status, 'queued');
  await ctx.app.dining.idle();
  assert.equal((await ctx.app.inject('/api/dining')).json().card.source, 'meal_intent');
  assert.equal((await post(ctx.app, '/api/signals/context', body)).json().dining.action, 'duplicate');
  await post(ctx.app, '/api/signals/context', signal(ctx));
  assert.equal(ctx.app.store.list('diningJobs').length, 1);
  const deliveries = (await ctx.app.inject('/api/dining/deliveries')).json().deliveries;
  assert.equal(deliveries.length, 1);
  assert.equal((await post(ctx.app, `/api/dining/deliveries/${deliveries[0].id}/ack`, {})).json().delivery.status, 'acknowledged');
  assert.equal((await post(ctx.app, `/api/dining/deliveries/${deliveries[0].id}/ack`, {})).json().duplicate, true);
  assert.equal((await ctx.app.inject('/api/dining/deliveries')).json().deliveries.length, 0);
});

test('explicit restaurant chat works without proactive opt-in, never opens camera or invokes a text model', async t => {
  const ctx = await setup(t, { app: { provider: { visionConfigured: false, chatConfigured: true, chat() { throw new Error('Restaurant lookup must not invoke chat inference'); } } } });
  await locate(ctx);
  await post(ctx.app, '/api/device/pause', { paused: false });
  const body = { message: '帮我推荐附近清淡的餐厅', clientMessageId: 'restaurant-chat' };
  const result = await post(ctx.app, '/api/chat', body);
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().signal.action, 'ignore');
  assert.equal(result.json().state.device.captureWindow, null);
  await ctx.app.dining.idle();
  assert.equal((await ctx.app.inject('/api/dining')).json().card.source, 'explicit_request');
  assert.equal((await ctx.app.inject('/api/dining/deliveries')).json().deliveries.length, 0);
  const calls = ctx.upstream.calls.length;
  await post(ctx.app, '/api/chat', body);
  assert.equal(ctx.upstream.calls.length, calls);
});

test('meal-time tick is durable, Shanghai-based and sends at most one proactive delivery per meal', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true, mealTimeEnabled: true });
  ctx.app.dining.tick();
  await ctx.app.dining.idle();
  let state = (await ctx.app.inject('/api/dining')).json();
  assert.equal(state.card.source, 'meal_time');
  assert.equal((await ctx.app.inject('/api/dining/deliveries')).json().deliveries.length, 1);
  ctx.app.dining.tick();
  await ctx.reopen();
  ctx.app.dining.tick();
  await ctx.app.dining.idle();
  assert.equal(ctx.app.store.list('diningJobs').length, 1);
  const card = state.card;
  const body = { requestId: 'dismiss-1', expectedVersion: card.version };
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/dismiss`, body)).json().card.status, 'dismissed');
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/dismiss`, body)).json().duplicate, true);
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
  assert.equal((await ctx.app.inject('/api/dining/deliveries')).json().deliveries.length, 0);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 409);
  await post(ctx.app, '/api/signals/context', signal(ctx));
  assert.equal(ctx.app.store.list('diningJobs').length, 1);
});

test('preference filters remove known conflicts, over-budget/unknown-price, closed and irrelevant places', async t => {
  const fixtures = [...pois,
    { ...pois[0], id: 'B_CLOSED', name: '已关门测试蒸菜店', business: { ...pois[0].business, opentime_today: '18:00-20:00' } },
    { ...pois[0], id: 'B_UNKNOWN', name: '价格未知测试蒸菜店', business: { tag: '蒸菜' } },
    { ...pois[0], id: 'B_NOT_FOOD', typecode: '070000' },
    { ...pois[0], id: 'B_PLAIN', name: '普通测试店', business: { tag: '家常菜', cost: '10' } },
    { ...pois[0], id: 'B_FAR', location: '117.5,39.908' },
  ];
  const ctx = await setup(t, { amap: { pois: fixtures } });
  await locate(ctx);
  await post(ctx.app, '/api/dining/preferences', { maxCostYuan: 40, excludedKeywords: ['蒸食'] });
  const result = await generate(ctx);
  assert.equal(result.job.status, 'succeeded');
  assert.equal(result.card.restaurant.id, pois[2].id);
  assert.equal(result.card.restaurant.openingStatus, 'unknown');
  assert.equal(result.card.restaurant.rating, null);
  assert.equal(result.card.actions.swapAvailable, false, 'Only unseen eligible candidates should control swap availability');
  const swap = await post(ctx.app, `/api/dining/recommendations/${result.card.id}/swap`, { requestId: 'filtered-swap', expectedVersion: 1 });
  assert.equal(swap.statusCode, 409);
  assert.equal((await ctx.app.inject('/api/dining')).json().card.restaurant.id, pois[2].id);
});

test('no matches and upstream failures keep an honest empty/failed result, without exposing upstream secrets', async t => {
  const empty = await setup(t, { amap: { pois: [] } });
  await locate(empty);
  assert.equal((await generate(empty)).job.status, 'skipped');
  assert.equal((await empty.app.inject('/api/dining')).json().card, null);
  const broken = await setup(t, { amap: { intercept: url => response({ status: '0', infocode: '10001', info: `secret ${key} ${url}` }) } });
  await locate(broken);
  const failed = await generate(broken);
  assert.equal(failed.job.status, 'failed');
  assert.equal(failed.job.error.code, 'AMAP_REQUEST_REJECTED');
  assert.equal(JSON.stringify(failed).includes(key), false);
  assert.equal(broken.app.store.list('diningCards').length, 0);
  const noRoute = await setup(t, { amap: { intercept: url => url.pathname.endsWith('/walking') ? response({ route: { paths: [] } }) : null } });
  await locate(noRoute);
  const result = await generate(noRoute);
  assert.equal(result.job.status, 'succeeded');
  assert.deepEqual(result.card.restaurant.walking, { status: 'unavailable', distanceMeters: null, durationSeconds: null, source: null });
  assert.equal((await noRoute.app.inject(`/api/dining/recommendations/${result.card.id}/navigation`)).statusCode, 200);
});

test('WGS84 is converted exactly once and no personal profile or transcript is sent to Amap', async t => {
  const ctx = await setup(t);
  await post(ctx.app, '/api/profile', { nickname: '私有测试称呼', dietaryNotes: '私有测试备注', weightKg: 70 });
  await locate(ctx, { coordinateSystem: 'wgs84', longitude: 116.391 });
  const result = await generate(ctx);
  assert.equal(result.job.status, 'succeeded');
  assert.equal(ctx.upstream.calls.filter(call => call.path.endsWith('/convert')).length, 1);
  assert.ok(ctx.upstream.calls.filter(call => call.path.endsWith('/around')).every(call => call.params.location === '116.397000,39.908000'));
  const sent = JSON.stringify(ctx.upstream.calls);
  assert.equal(sent.includes('私有测试'), false);
  assert.equal(sent.includes('weightKg'), false);
});

test('a stop while Amap is in flight withdraws the job and prevents late card publication', async t => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { started = resolve; });
  const ctx = await setup(t, { amap: { intercept: async (url, init) => {
    if (!url.pathname.endsWith('/around')) return null;
    started();
    await Promise.race([gate, new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true }))]);
    return null;
  } } });
  await locate(ctx);
  const queued = await post(ctx.app, '/api/dining/recommendations', { requestId: 'late-card' });
  assert.equal(queued.statusCode, 202);
  await observed;
  await post(ctx.app, '/api/signals/context', signal(ctx, { text: '我吃完了' }));
  release();
  await ctx.app.dining.idle();
  assert.equal((await ctx.app.inject('/api/dining/requests/late-card')).json().job.status, 'cancelled');
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
});

test('position movement, clear, stale observation and card expiry invalidate navigation and pending notifications', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true, mealTimeEnabled: true });
  ctx.app.dining.tick();
  await ctx.app.dining.idle();
  const card = (await ctx.app.inject('/api/dining')).json().card;
  assert.equal((await locate(ctx)).json().duplicate, true);
  assert.equal((await post(ctx.app, '/api/dining/location', { ...origin, longitude: 116.398, accuracyMeters: 15, observedAt: epoch.toISOString() })).statusCode, 409);
  ctx.advance(1);
  await locate(ctx, { longitude: 116.410 });
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
  assert.equal((await ctx.app.inject('/api/dining/deliveries')).json().deliveries.length, 0);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 409);
  await generate(ctx, 'moved');
  await post(ctx.app, '/api/dining/location/clear', {});
  assert.equal(ctx.app.store.get('diningLocation', 'latest'), null);
  assert.ok(ctx.app.store.list('diningCards').every(item => item.origin === null && item.inputLocation === null));
  assert.ok(ctx.app.store.list('diningJobs').every(item => item.inputLocation === null));
  ctx.advance(1);
  await locate(ctx);
  const fresh = await generate(ctx, 'fresh');
  ctx.advance(1800001);
  await locate(ctx);
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${fresh.card.id}`)).json().card.status, 'expired');
});

test('opening hours, optional POI fields and Shanghai meal boundaries never invent availability or zero prices', () => {
  assert.equal(mealContext(new Date('2026-10-15T16:10:00Z')).day, '2026-10-16');
  assert.equal(openingState('10:00-13:00 17:00-22:00', epoch), 'within_hours');
  assert.equal(openingState('18:00-22:00', epoch), 'outside_hours');
  assert.equal(openingState('周一至周五 10:00-22:00', epoch), 'unknown');
  assert.equal(openingState('22:00-02:00', new Date('2026-10-15T17:00:00Z')), 'within_hours');
  const normalized = normalizePoi({ ...pois[0], business: { cost: [], rating: '', tag: [] }, photos: [{ url: 'javascript:alert(1)' }] }, origin, epoch.toISOString());
  assert.equal(normalized.costYuan, null);
  assert.equal(normalized.rating, null);
  assert.equal(normalized.photoUrl, null);
  assert.deepEqual(normalized.tags, []);
});

test('adapter timeout and network errors remain bounded and redact raw upstream errors', async () => {
  const timeout = new AmapProvider({ AMAP_WEB_SERVICE_KEY: key, AMAP_TIMEOUT_MS: '1000' }, async (_, init) => {
    await new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('fixture timeout fallback')), 1200);
      init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error(key)); }, { once: true });
    });
  });
  await assert.rejects(timeout.locate({ ...origin, coordinateSystem: 'wgs84' }), error => error.code === 'AMAP_TIMEOUT' && !error.message.includes(key));
});

test('a graceful restart resumes its unfinished request exactly once without publishing a second card', async t => {
  let started;
  let hold = true;
  const observed = new Promise(resolve => { started = resolve; });
  const ctx = await setup(t, { amap: { intercept: async (url, init) => {
    if (!hold || !url.pathname.endsWith('/around')) return null;
    started();
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic shutdown')), { once: true }));
    return null;
  } } });
  await locate(ctx);
  assert.equal((await post(ctx.app, '/api/dining/recommendations', { requestId: 'resume' })).statusCode, 202);
  await observed;
  hold = false;
  await ctx.reopen();
  const result = (await ctx.app.inject('/api/dining/requests/resume')).json();
  assert.equal(result.job.status, 'succeeded', JSON.stringify(result));
  assert.equal(result.job.attempts, 2);
  assert.equal(ctx.app.store.list('diningCards').length, 1);
  assert.equal(ctx.app.store.list('events').filter(event => event.type === 'dining.card-created').length, 1);
});

test('profile-independent preferences revoke an in-flight recommendation and clearing location removes snapshots', async t => {
  let started;
  const observed = new Promise(resolve => { started = resolve; });
  const ctx = await setup(t, { amap: { intercept: async (url, init) => {
    if (!url.pathname.endsWith('/around')) return null;
    started();
    await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('synthetic revoke')), { once: true }));
    return null;
  } } });
  await locate(ctx);
  await post(ctx.app, '/api/dining/recommendations', { requestId: 'preferences-race' });
  await observed;
  await post(ctx.app, '/api/dining/preferences', { excludedKeywords: ['蒸菜'] });
  await ctx.app.dining.idle();
  assert.equal((await ctx.app.inject('/api/dining/requests/preferences-race')).json().job.status, 'cancelled');
  assert.equal(ctx.app.store.list('diningCards').length, 0);
  await post(ctx.app, '/api/dining/location/clear', {});
  assert.ok(ctx.app.store.list('diningJobs').every(job => job.inputLocation === null));
});

test('selected proactive cards retain navigation until an actual meal record supersedes the recommendation', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true });
  await post(ctx.app, '/api/signals/context', signal(ctx));
  await ctx.app.dining.idle();
  const card = (await ctx.app.inject('/api/dining')).json().card;
  assert.equal((await post(ctx.app, `/api/dining/recommendations/${card.id}/select`, { requestId: 'select-proactive', expectedVersion: card.version })).statusCode, 200);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 200);
  ctx.app.store.put('captureSessions', 'synthetic-food-found', { id: 'synthetic-food-found', foodDetected: true, createdAt: ctx.now().toISOString(), updatedAt: ctx.now().toISOString() });
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 409);
});

test('the cost-saving default uses a single search keyword and queued work cannot outlive its two-minute deadline', async t => {
  const upstream = fakeAmap();
  const provider = new AmapProvider({ AMAP_WEB_SERVICE_KEY: key }, upstream.fetcher);
  await provider.search(origin, { style: 'balanced', radiusMeters: 1500 }, epoch.toISOString());
  assert.equal(upstream.calls.length, 1);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const observed = new Promise(resolve => { started = resolve; });
  const ctx = await setup(t, { amap: { intercept: async url => {
    if (url.pathname.endsWith('/around')) { started(); await gate; }
    return null;
  } } });
  await locate(ctx);
  await post(ctx.app, '/api/dining/recommendations', { requestId: 'expired-while-querying' });
  await observed;
  ctx.advance(120001);
  await locate(ctx);
  release();
  await ctx.app.dining.idle();
  const result = (await ctx.app.inject('/api/dining/requests/expired-while-querying')).json();
  assert.equal(result.job.status, 'cancelled');
  assert.equal(result.job.error.code, 'DINING_REQUEST_EXPIRED');
  assert.equal(ctx.app.store.list('diningCards').length, 0);
});

test('many small position updates still expire a card once the user is over 500m from its search center', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  const { card } = await generate(ctx);
  for (let step = 1; step <= 4; step++) {
    ctx.advance(1000);
    await locate(ctx, { longitude: origin.longitude + step * 0.002 });
  }
  assert.equal((await ctx.app.inject('/api/dining')).json().card, null);
  assert.equal((await ctx.app.inject(`/api/dining/recommendations/${card.id}/navigation`)).statusCode, 409);
});

test('a maximum-length context signal still produces a valid, pollable recommendation request ID', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true });
  const result = await post(ctx.app, '/api/signals/context', signal(ctx, { signalId: 'a'.repeat(128) }));
  const requestId = result.json().dining.job.requestId;
  assert.ok(requestId.length <= 128);
  await ctx.app.dining.idle();
  assert.equal((await ctx.app.inject(`/api/dining/requests/${requestId}`)).json().job.status, 'succeeded');
});

test('replaying an old close signal cannot close a newer explicit card', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  const body = signal(ctx, { text: '我吃完了' });
  await post(ctx.app, '/api/signals/context', body);
  const { card } = await generate(ctx, 'intent-after-close');
  assert.equal(card.status, 'active');
  await post(ctx.app, '/api/signals/context', body);
  assert.equal((await ctx.app.inject('/api/dining')).json().card.id, card.id);
});

test('a saved context signal without its dining job can be retried after enabling proactive recommendations', async t => {
  const ctx = await setup(t);
  await locate(ctx);
  const body = signal(ctx);
  await post(ctx.app, '/api/signals/context', body);
  assert.equal(ctx.app.store.list('diningJobs').length, 0);
  await post(ctx.app, '/api/dining/preferences', { proactiveEnabled: true });
  await post(ctx.app, '/api/signals/context', body);
  await ctx.app.dining.idle();
  assert.equal(ctx.app.store.list('diningJobs').length, 1);
  assert.equal((await ctx.app.inject('/api/dining')).json().card.source, 'meal_intent');
});
