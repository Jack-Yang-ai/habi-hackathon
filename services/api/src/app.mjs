import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, mealView } from './store.mjs';
import { ModelProvider, localReply } from './provider.mjs';
import { ContextTrigger, applyTrigger } from './trigger.mjs';
import { CaptureReviewer } from './capture-review.mjs';
import { mealDraft } from './meal-draft.mjs';
import { DiningService, diningIntent } from './dining.mjs';
import { registerDiningRoutes } from './dining-routes.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const idSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const profileSchema = z.object({
  nickname: z.string().trim().max(30).default(''),
  gender: z.enum(['undisclosed', 'female', 'male']).default('undisclosed'),
  age: z.number().int().min(1).max(120).nullable().default(null),
  heightCm: z.number().min(50).max(250).nullable().default(null),
  weightKg: z.number().min(10).max(500).nullable().default(null),
  goal: z.enum(['balanced', 'weight-management', 'fitness', 'understand']).nullable().default(null),
  dietaryNotes: z.string().trim().max(500).default(''),
  calorieTarget: z.number().int().min(800).max(6000).nullable().default(null),
}).strict();
const metadataSchema = z.object({
  schema_version: z.literal(1), capture_id: idSchema, device_id: idSchema,
  boot_id: idSchema, sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  captured_at: z.iso.datetime({ offset: true }).nullable(),
  time_source: z.enum(['ntp', 'server', 'phone', 'unsynchronized']),
  uptime_ms: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
  mime_type: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
  width: z.number().int().min(1).max(20000).optional(),
  height: z.number().int().min(1).max(20000).optional(), session_id: idSchema.optional(),
  capture_window_id: idSchema.optional(), capture_phase: z.enum(['probe', 'followup']).optional(),
  firmware_version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).max(32).optional(),
  capture_requested_uptime_ms: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  frame_uptime_ms: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  frame_age_ms: z.number().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  sensor_pid: z.number().int().min(0).max(65535).optional(), autofocus_initialized: z.boolean().optional(),
}).refine(value => value.time_source === 'unsynchronized' ? value.captured_at === null : value.captured_at !== null,
  { message: 'Capture clock source must match captured_at' });

function digest(value) { return createHash('sha256').update(value).digest(); }
function matches(value, expected) {
  return typeof value === 'string' && typeof expected === 'string' && expected.length > 0
    && timingSafeEqual(digest(value), digest(expected));
}
function imageType(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return ['image/jpeg', 'jpg'];
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png'];
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', 'webp'];
  return null;
}
function fail(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw fail('输入格式不正确，请检查后重试');
  return result.data;
}

export async function createApp(options = {}) {
  const env = options.env ?? process.env;
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!env.APP_ACCESS_TOKEN || !env.DEVICE_ACCESS_TOKEN))
    throw new Error('Non-loopback hosting requires APP_ACCESS_TOKEN and DEVICE_ACCESS_TOKEN');
  const directory = path.resolve(options.dataDir ?? env.DATA_DIR ?? path.join(repoRoot, '.data'));
  // Bench override for the trigger cooldown. Unset keeps the real 5 minutes; a bench session can
  // set CAPTURE_COOLDOWN_MS=0 to open probes back to back without waiting between attempts.
  const requestedCooldown = Number(env.CAPTURE_COOLDOWN_MS);
  const captureCooldownMs = env.CAPTURE_COOLDOWN_MS !== undefined && Number.isFinite(requestedCooldown) && requestedCooldown >= 0
    ? requestedCooldown : 5 * 60000;
  const store = options.store ?? new Store(directory, options.clock);
  const provider = options.provider ?? new ModelProvider(env, options.fetcher);
  const trigger = options.trigger ?? new ContextTrigger(env, options.triggerFetcher);
  const mediaDirectory = path.join(directory, 'media');
  await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.decorate('store', store);
  app.decorate('provider', provider);
  const reviewer = new CaptureReviewer(store, provider, mediaDirectory);
  app.decorate('reviewer', reviewer);
  const dining = new DiningService(store, { env, provider: options.amapProvider, fetcher: options.amapFetcher, scheduler: options.diningScheduler });
  app.decorate('dining', dining);
  app.addHook('onClose', async () => { await dining.close(); await reviewer.close(); store.close(); });
  const explicitOrigins = (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').filter(Boolean);
  const sessions = new Map();
  const activeAnalysis = new Set();
  const rateState = new Map();

  app.addHook('onRequest', async (request, reply) => {
    let decodedPath;
    try { decodedPath = decodeURIComponent(request.url.split('?')[0]); }
    catch { throw fail('请求路径不正确'); }
    if (decodedPath.includes('\\') || decodedPath.includes('\0')) throw fail('请求路径不正确');
    const pathname = new URL(decodedPath, 'http://local.invalid').pathname;
    const origin = request.headers.origin;
    const sameOrigin = origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
    if (origin && !sameOrigin && !explicitOrigins.includes(origin)) throw fail('请求来源未被允许', 403);
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Credentials', 'true');
    }
    reply.header('X-Content-Type-Options', 'nosniff').header('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') return reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
      .header('Access-Control-Allow-Headers', 'Content-Type,X-App-Token,X-Device-Token').code(204).send();
    if (pathname === '/health' || pathname === '/api/session') return;
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/media/')) return;
    const isDevice = pathname.startsWith('/api/device/') && pathname !== '/api/device/pause';
    if (isDevice) {
      if (env.DEVICE_ACCESS_TOKEN && !matches(request.headers['x-device-token'], env.DEVICE_ACCESS_TOKEN))
        throw fail('设备认证失败', 401);
      return;
    }
    if (!env.APP_ACCESS_TOKEN) return;
    const cookieValue = /(?:^|;\s*)de_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
    const cookieExpiry = cookieValue ? sessions.get(cookieValue) : 0;
    if (!matches(request.headers['x-app-token'], env.APP_ACCESS_TOKEN) && !(cookieExpiry > Date.now()))
      throw fail('请先连接到你自己的服务', 401);
  });
  app.setErrorHandler((error, request, reply) => {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 500;
    if (status === 500 && process.env.HABI_DEBUG_ERRORS === '1') console.error(error);
    const message = status === 500 ? '服务暂时出错，原始记录已保留' : error.message;
    reply.code(status).send({ error: { code: error.code ?? `HTTP_${status}`, message } });
  });
  app.get('/health', async () => ({ ok: true, service: 'de-companion', schemaVersion: 1 }));
  app.post('/api/session', async (request, reply) => {
    const now = Date.now();
    const rate = rateState.get(request.ip) ?? { since: now, attempts: 0 };
    if (now - rate.since > 60_000) { rate.since = now; rate.attempts = 0; }
    rate.attempts += 1;
    rateState.set(request.ip, rate);
    if (rate.attempts > 10) throw fail('连接尝试过于频繁，请稍后重试', 429);
    if (!env.APP_ACCESS_TOKEN) return { connected: true, localOnly: true };
    const body = parse(z.object({ token: z.string().max(1000) }), request.body);
    if (!matches(body.token, env.APP_ACCESS_TOKEN)) throw fail('连接口令不正确', 401);
    const id = randomBytes(32).toString('hex');
    for (const [key, expiry] of sessions) if (expiry <= now) sessions.delete(key);
    sessions.set(id, now + 8 * 3600_000);
    reply.header('Set-Cookie', `de_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${request.protocol === 'https' ? '; Secure' : ''}`);
    return { connected: true };
  });
  await app.register(multipart, { limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 3, parts: 4, fieldSize: 16384 } });
  await app.register(staticFiles, { root: mediaDirectory, prefix: '/media/', decorateReply: false });

  function viewState() {
    store.ensureVirtualPost();
    const settings = store.settings();
    const devices = store.list('devices', { limit: 20 });
    const phones = store.list('phones', { limit: 20 });
    const fresh = item => item && store.clock().getTime() - Date.parse(item.lastSeenAt) < 90_000;
    const device = devices.find(fresh) ?? devices[0];
    const phone = phones.find(fresh) ?? phones[0];
    const meals = store.list('meals', { limit: 100 }).map(mealView);
    const scene = settings.sceneUntil && Date.parse(settings.sceneUntil) > store.clock().getTime()
      ? settings.scene : 'idle';
    const companion = {
      name: 'Habi', scene, sceneUntil: settings.sceneUntil,
      companionDays: Math.max(1, Math.floor((store.clock().getTime() - Date.parse(settings.createdAt)) / 86400_000) + 1),
      // Every recorded event is a moment spent together, so a count is enough here: reading the rows
      // only to count them was the single most expensive thing this endpoint did.
      memoriesCount: store.count('events'),
      relationshipLabel: meals.some(meal => meal.confirmedAt) ? '慢慢熟悉中' : '初次见面',
    };
    const messages = store.list('messages', { limit: 100 }).reverse();
    return {
      schemaVersion: 1, now: store.now(), profile: profileView(),
      config: { analysisConfigured: provider.visionConfigured, analysisMode: provider.visionConfigured ? 'model' : 'unconfigured',
        chatMode: provider.chatConfigured ? 'model' : 'local-rules', localOnly: ['127.0.0.1', 'localhost', '::1'].includes(host) },
      device: { paused: settings.paused, phoneConnected: Boolean(fresh(phone)), cameraConnected: Boolean(fresh(device) && device.camera_ready),
        deviceId: device?.id ?? null, lastSeenAt: device?.lastSeenAt ?? null,
        captureIntervalSeconds: settings.captureIntervalSeconds,
        rearDisplay: fresh(phone) ? phone.rearDisplay : 'unverified', rootAvailable: fresh(phone) ? phone.rootAvailable : null,
        captureMode: settings.captureMode ?? 'signals', captureWindow: currentCaptureWindow(settings),
        captureReview: settings.lastCaptureSessionId ? reviewView(store.get('captureSessions', settings.lastCaptureSessionId)) : null,
        phoneModel: phone?.model ?? null, pendingUploads: device?.pending_uploads ?? null },
      companion, meals, posts: store.list('posts', { limit: 100 }), messages,
      // A photo the camera took belongs to the user even when the review saw no food in it and no
      // meal was created; without this the page silently drops every such capture.
      captures: store.list('captures', { limit: 20, unlinked: true }).map(capture => ({
        id: capture.id, imageUrl: capture.imageUrl, source: capture.source, receivedAt: capture.receivedAt,
        capturedAt: capture.capturedAt ?? null, mimeType: capture.mimeType ?? null,
        review: reviewView(reviewer.session(capture)),
      })),
      // The page reads six fields per signal and never needs the transcript evidence behind the
      // decision, so those bytes never leave the database.
      signals: store.list('signals', { limit: 20, pick: ['signalId', 'stage', 'action', 'reason', 'dryRun', 'receivedAt'] }),
      reminder: settings.reminder && Date.parse(settings.reminder.expiresAt) > store.clock().getTime() ? settings.reminder : null,
      notices: [
        ...(!provider.visionConfigured ? [{ code: 'VISION_UNCONFIGURED', title: '食物分析尚未配置', detail: '照片可以保存和确认，热量暂不估算。配置服务后，可自行选择是否上传图片分析。' }] : []),
        ...(!provider.chatConfigured ? [{ code: 'LOCAL_CHAT', title: '本地基础对话', detail: '当前使用明确的本地规则回复；尚未连接自由对话模型。' }] : []),
        ...(!fresh(phone) ? [{ code: 'REAR_UNVERIFIED', title: '背屏待连接', detail: '页面中的背屏是状态预览，实际显示需连接手机设备桥。' }] : []),
      ],
    };
  }
  // What can change this payload without a write: the clock crossing a window, scene or reminder
  // boundary. Anything stored is already covered by the store's own change marker.
  function stateMarker() {
    const settings = store.settings();
    return [store.currentRevision(), settings.scene, settings.sceneUntil, settings.paused,
      settings.captureWindow?.id ?? '', settings.reminder?.signalId ?? '',
      settings.lastCaptureSessionId ?? '', currentCaptureWindow(settings)?.remaining ?? 0].join('|');
  }
  app.get('/api/state', async (request, reply) => {
    const etag = `W/"${createHash('sha256').update(stateMarker()).digest('hex').slice(0, 32)}"`;
    reply.header('ETag', etag).header('Cache-Control', 'no-store');
    // A page that polls on a timer should be told "nothing changed" cheaply instead of being sent a
    // payload it already has: unchanged answers skip the whole view rebuild.
    if ((request.headers['if-none-match'] ?? '').split(',').map(value => value.trim()).includes(etag))
      return reply.code(304).send();
    return viewState();
  });
  registerDiningRoutes(app, dining, parse);
  function profileView() { const saved = store.get('profile', 'self'); return saved ? { calorieTarget: null, ...saved } : { ...profileSchema.parse({}), updatedAt: null }; }
  app.get('/api/profile', async () => ({ profile: profileView() }));
  app.post('/api/profile', async request => {
    const body = parse(profileSchema, request.body);
    const profile = { ...body, updatedAt: store.now() };
    store.put('profile', 'self', profile);
    return { profile };
  });
  app.get('/api/memories', async () => ({ memories: store.list('events').filter(item => item.type === 'preference.shared') }));
  function currentCaptureWindow(settings) {
    const window = settings.captureWindow;
    if (!window || settings.paused || Date.parse(window.expiresAt) <= store.clock().getTime()) return null;
    const captures = store.list('captures');
    const totalUsed = captures.filter(item => item.session_id === window.sessionId).length;
    const phaseUsed = captures.filter(item => item.capture_window_id === window.id).length;
    const remaining = Math.max(0, Math.min(window.phaseMaxCaptures - phaseUsed, window.maxCaptures - totalUsed));
    return remaining > 0 ? { ...window, remaining } : null;
  }
  function reviewView(session) {
    if (!session) return null;
    const { sessionId, status, reason, imageUrl, foodDetected, createdAt, updatedAt, expiresAt, mealId } = session;
    return { sessionId, status, reason, imageUrl, foodDetected, createdAt, updatedAt, expiresAt, mealId };
  }
  app.get('/api/device/config', async request => {
    const deviceId = parse(idSchema, request.query.device_id);
    const known = store.get('devices', deviceId) ?? { id: deviceId, createdAt: store.now() };
    store.put('devices', deviceId, { ...known, lastSeenAt: store.now() });
    const settings = store.settings();
    const window = currentCaptureWindow(settings);
    const activeWindow = Boolean(window);
    const signalMode = (settings.captureMode ?? 'signals') === 'signals';
    return { schema_version: 1, device_id: deviceId, paused: settings.paused || (signalMode && !activeWindow),
      capture_mode: settings.captureMode ?? 'signals',
      capture_window: activeWindow ? { id: window.id, phase: window.phase, session_id: window.sessionId,
        expires_at: window.expiresAt, remaining: window.remaining } : null,
      capture_interval_seconds: activeWindow ? window.captureIntervalSeconds : settings.captureIntervalSeconds, upload_enabled: true,
      server_time: store.now(), epoch_ms: store.clock().getTime() };
  });
  app.post('/api/device/status', async request => {
    const body = parse(z.object({ device_id: idSchema, boot_id: idSchema.optional(), camera_ready: z.boolean().optional(),
      sd_ready: z.boolean().optional(), paused: z.boolean().optional(), pending_uploads: z.number().int().min(0).optional(),
      uptime_ms: z.number().min(0).optional(), battery_percent: z.number().min(0).max(100).optional(),
      firmware_version: z.string().max(32).optional(), sensor_pid: z.number().int().min(0).max(65535).optional(),
      autofocus_initialized: z.boolean().optional(), last_error: z.string().max(200).optional(),
      capture_phase: z.enum(['', 'probe', 'followup']).optional(), window_remaining: z.number().int().min(0).max(3).optional(),
      window_active: z.boolean().optional(), successful_uploads: z.number().int().min(0).optional(),
      dropped_captures: z.number().int().min(0).optional() }), request.body);
    const existing = store.get('devices', body.device_id) ?? { id: body.device_id, createdAt: store.now() };
    store.put('devices', body.device_id, { ...existing, ...body, lastSeenAt: store.now() });
    return { ok: true, server_time: store.now() };
  });
  app.post('/api/phone/status', async request => {
    const body = parse(z.object({ device_id: idSchema, model: z.string().max(100), os: z.string().max(100).optional(),
      rootAvailable: z.boolean(), rearDisplay: z.enum(['adb-relay', 'native', 'unverified']) }), request.body);
    const existing = store.get('phones', body.device_id) ?? { id: body.device_id, createdAt: store.now() };
    store.put('phones', body.device_id, { ...existing, ...body, lastSeenAt: store.now() });
    return { ok: true };
  });
  app.post('/api/device/pause', async request => {
    const { paused } = parse(z.object({ paused: z.boolean() }), request.body);
    store.settings({ paused, ...(paused ? { captureWindow: null, reminder: null } : {}) });
    const sessionId = store.settings().lastCaptureSessionId;
    const session = sessionId ? store.get('captureSessions', sessionId) : null;
    if (paused && session) store.put('captureSessions', session.id, { ...session, status: 'cancelled', updatedAt: store.now() });
    store.scene(paused ? 'resting' : 'idle', paused ? 6 : 1);
    store.event(paused ? 'capture.paused' : 'capture.resumed');
    return { paused, state: viewState() };
  });

  const signalSchema = z.object({ signalId: idSchema, text: z.string().trim().min(1).max(3000),
    speaker: z.enum(['self', 'other', 'unknown']).default('unknown'),
    sourceContext: z.enum(['user-conversation', 'media', 'unknown', 'test-fixture']).default('unknown'),
    observedAt: z.iso.datetime({ offset: true }), recentUtterances: z.array(z.string().max(500)).max(8).default([]),
    audioEvents: z.array(z.object({ label: z.string().max(100), score: z.number().min(0).max(1) })).max(10).default([]),
    asrEvidence: z.object({ languageTag: z.string().max(100).nullable(), emotionTag: z.string().max(100).nullable(),
      eventTag: z.string().max(100).nullable(), windowStartSec: z.number().min(0), windowEndSec: z.number().min(0),
      audioSha256: z.string().regex(/^[a-f0-9]{64}$/), speechVadVerified: z.boolean(),
      captureId: idSchema.optional(), captureStartedAt: z.iso.datetime({ offset: true }).optional(),
      frameOffset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      frames: z.number().int().min(1).max(192000).optional(), sampleRate: z.literal(16000).optional(),
      timeSource: z.enum(['audio_timestamp_boottime', 'audio_record_start_estimate', 'synthetic_fixture']).optional() })
      .refine(value => value.windowEndSec > value.windowStartSec
        && (value.frames === undefined || value.windowEndSec <= value.frames / 16000 + 0.001)).optional(),
    localDecision: z.object({
      model: z.literal('decider-0.8b-q4'),
      modelSha256: z.literal('5cb5d042a236add5cde5459f8e8b8f8f80161ad4a1779a49377b70a64eb7b11a'),
      runtime: z.literal('llama.cpp-android-cpu'),
      stage: z.enum(['start_soon', 'invited', 'eating_now', 'finished', 'declined', 'unrelated', 'uncertain']),
      probability: z.number().min(0).max(1), margin: z.number().min(0).max(1),
      distribution: z.object({ start_soon: z.number().min(0).max(1), invited: z.number().min(0).max(1),
        eating_now: z.number().min(0).max(1), finished: z.number().min(0).max(1),
        declined: z.number().min(0).max(1), unrelated: z.number().min(0).max(1), uncertain: z.number().min(0).max(1) }),
      wallMs: z.number().min(0).max(120000), temperature: z.literal(1.03),
      promptVersion: z.string().max(120).optional(), promptTokens: z.number().int().min(1).max(2048).optional(),
      domainCalibrated: z.literal(false).optional(),
    }).refine(value => {
      const ranked = Object.values(value.distribution).sort((a, b) => b - a);
      return Math.abs(ranked.reduce((a, b) => a + b, 0) - 1) < 0.001
        && Math.abs(value.distribution[value.stage] - ranked[0]) < 0.001
        && Math.abs(value.probability - ranked[0]) < 0.001
        && Math.abs(value.margin - (ranked[0] - ranked[1])) < 0.001;
    }).optional(),
    dryRun: z.boolean().default(true) }).refine(input => {
      const evidence = input.asrEvidence;
      if (!evidence?.captureStartedAt || evidence.frameOffset === undefined) return true;
      const derived = Date.parse(evidence.captureStartedAt) + evidence.frameOffset / 16 + evidence.windowEndSec * 1000;
      return Math.abs(Date.parse(input.observedAt) - derived) <= 2;
    });
  app.post('/api/signals/context', async request => {
    const input = parse(signalSchema, request.body);
    const classification = await trigger.classify(input);
    const intent = diningIntent(input, classification, store.clock());
    const signal = applyTrigger(store, intent.explicit ? { ...classification, hardVeto: true, reason: 'restaurant_search_request' } : classification, input, input.dryRun, captureCooldownMs);
    const recommendation = dining.onSignal(input, classification, input.dryRun);
    if (signal.duplicate) recommendation.action = 'duplicate';
    return { signal, dining: recommendation, state: viewState() };
  });

  async function receiveCapture(request, reply) {
    const phoneCamera = request.url.split('?')[0] === '/api/phone/captures';
    if (!request.isMultipart()) throw fail('请以图片文件上传');
    let buffer; let metadataRaw;
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (part.fieldname !== 'image') throw fail('图片字段应为 image');
        buffer = await part.toBuffer();
      } else if (part.fieldname === 'metadata') metadataRaw = part.value;
    }
    if (!buffer?.length) throw fail('请选择一张餐食图片');
    const detectedType = imageType(buffer);
    if (!detectedType) throw fail('只支持 JPEG、PNG、WebP 图片');
    const [mime, extension] = detectedType;
    let metadata;
    if (metadataRaw !== undefined) {
      // @fastify/multipart hands back an already-parsed object when the metadata part declares
      // Content-Type: application/json (the ESP32 firmware does), and a raw string otherwise
      // (the phone camera does). Accept both shapes instead of JSON.parse-ing an object.
      try { metadata = parse(metadataSchema, typeof metadataRaw === 'string' ? JSON.parse(metadataRaw) : metadataRaw); }
      catch { throw fail('照片元信息格式不正确'); }
    } else if (!phoneCamera && !request.url.startsWith('/api/device/')) {
      const id = store.id('phone');
      metadata = { schema_version: 1, capture_id: id, device_id: 'phone-upload', boot_id: 'manual', sequence: 0,
        captured_at: store.now(), time_source: 'phone', uptime_ms: 0 };
    } else throw fail('相机上传必须带 metadata');
    if (phoneCamera && (metadata.session_id || metadata.capture_window_id || metadata.capture_phase))
      throw fail('手机单次拍照不能占用随身相机的采集窗口');
    if (metadata.mime_type && metadata.mime_type !== mime) throw fail('图片类型与元信息不一致');
    const hash = createHash('sha256').update(buffer).digest('hex');
    const previous = store.get('captures', metadata.capture_id);
    if (previous) {
      if (previous.deviceId !== metadata.device_id || previous.sha256 !== hash) throw fail('照片 ID 与已有内容冲突', 409);
      return { capture_id: metadata.capture_id, duplicate: true, capture: previous,
        meal: previous.mealId ? mealView(store.get('meals', previous.mealId)) : null, state: viewState() };
    }
    const source = request.url.startsWith('/api/device/') ? 'esp32' : 'phone';
    if (source === 'phone' && !phoneCamera && metadata.session_id)
      throw fail('手动选图不能占用相机采集会话');
    const filename = `${randomBytes(20).toString('hex')}.${extension}`;
    await writeFile(path.join(mediaDirectory, filename), buffer, { mode: 0o600, flag: 'wx' });
    let result;
    try {
      result = store.transaction(() => {
        const duplicate = store.get('captures', metadata.capture_id);
        if (duplicate) {
          if (duplicate.deviceId !== metadata.device_id || duplicate.sha256 !== hash) throw fail('照片 ID 与已有内容冲突', 409);
          return { duplicate: true, capture: duplicate, meal: store.get('meals', duplicate.mealId) };
        }
        if (phoneCamera) {
          const sessionId = `phone-${createHash('sha256').update(metadata.device_id + ':' + metadata.capture_id).digest('hex').slice(0, 32)}`;
          const windowId = `${sessionId}-p1`;
          metadata = { ...metadata, session_id: sessionId, capture_window_id: windowId, capture_phase: 'probe' };
          store.put('captureSessions', sessionId, { id: sessionId, sessionId, source: 'phone', status: 'waiting_photo',
            reason: null, imageUrl: null, foodDetected: null, deviceId: metadata.device_id, mealId: null,
            createdAt: store.now(), updatedAt: store.now(), expiresAt: store.now(), maxCaptures: 1,
            currentWindowId: windowId, windows: [{ id: windowId, phase: 'probe', maxCaptures: 1 }], reviewAttempts: 0 });
          store.settings({ lastPhoneCaptureSessionId: sessionId });
        }
        const signalSession = source === 'esp32' || phoneCamera ? reviewer.validate(metadata, source) : null;
        const groupKey = metadata.session_id ? `${metadata.device_id}:${metadata.session_id}` : null;
        const time = metadata.captured_at ?? store.now();
        let meal = source === 'esp32' ? store.list('meals').find(item => item.source === source && item.deviceId === metadata.device_id
          && (groupKey ? item.groupKey === groupKey : !item.groupKey && !item.confirmedAt
            && Math.abs(Date.parse(time) - Date.parse(item.capturedAt ?? item.createdAt)) <= 30 * 60_000)) : null;
        const imageUrl = `/media/${filename}`;
        const capture = { ...metadata, source, id: metadata.capture_id, capture_id: metadata.capture_id, deviceId: metadata.device_id,
          imageUrl, filename, mimeType: mime, sha256: hash, receivedAt: store.now(), capturedAt: metadata.captured_at };
        if (!meal && !(signalSession && !signalSession.foodDetected)) {
          meal = { id: store.id('meal'), version: 1, title: '待确认的一餐', source, status: 'pending_analysis', deviceId: metadata.device_id,
            groupKey, createdAt: store.now(), updatedAt: store.now(), capturedAt: metadata.captured_at, imageUrl, images: [],
            analysis: { status: provider.visionConfigured ? 'pending' : 'not_configured', provider: null, modelName: null,
              foods: [], calorieRange: null, uncertainties: ['照片中的食物尚未分析，也尚未确认实际食量'], analyzedAt: null, error: null },
            portionFraction: null, note: '', confirmedAt: null, corrections: [] };
        } else if (meal) { meal.version += 1; meal.updatedAt = store.now(); }
        capture.mealId = meal?.id ?? null;
        if (meal) meal.images.push({ id: capture.id, imageUrl, capturedAt: capture.capturedAt, receivedAt: capture.receivedAt });
        store.put('captures', capture.id, capture);
        if (meal) store.put('meals', meal.id, meal);
        reviewer.register(capture);
        if (source === 'esp32') {
          const existing = store.get('devices', metadata.device_id) ?? { id: metadata.device_id, createdAt: store.now() };
          store.put('devices', metadata.device_id, { ...existing, camera_ready: true, lastSeenAt: store.now() });
        }
        store.event('capture.received', { captureId: capture.id, mealId: meal?.id ?? null });
        store.scene('collecting');
        return { duplicate: false, capture, meal };
      });
    } catch (error) { await unlink(path.join(mediaDirectory, filename)).catch(() => {}); throw error; }
    if (result.duplicate) await unlink(path.join(mediaDirectory, filename)).catch(() => {});
    reviewer.schedule();
    return reply.code(result.duplicate ? 200 : 201).send({ capture_id: metadata.capture_id, duplicate: result.duplicate,
      capture: result.capture, meal: result.meal ? mealView(result.meal) : null, state: viewState() });
  }
  app.post('/api/capture', receiveCapture);
  app.post('/api/phone/captures', receiveCapture);
  app.get('/api/phone/captures/:id', async request => {
    const capture = store.get('captures', parse(idSchema, request.params.id));
    if (!capture || capture.source !== 'phone') throw fail('未找到手机照片', 404);
    return { captureId: capture.id, review: reviewView(reviewer.session(capture)),
      meal: capture.mealId ? mealView(store.get('meals', capture.mealId)) : null };
  });
  app.post('/api/device/captures', receiveCapture);
  app.post('/api/meals/:id/correction', async request => {
    const id = parse(idSchema, request.params.id);
    const body = parse(z.object({ portionFraction: z.number().min(0).max(1), note: z.string().max(1000).default(''),
      expectedVersion: z.number().int().min(1).optional() }), request.body);
    const result = store.updatePortion(id, body.portionFraction, body.note, body.expectedVersion);
    return { meal: mealView(result.meal), state: viewState() };
  });
  app.post('/api/meals/:id/confirm', async request => {
    const id = parse(idSchema, request.params.id);
    // Attribution trace for the unwanted auto-confirm. It writes the confirm body (which can
    // contain a user note) to the log, so it stays behind an explicit flag instead of always on.
    if (env.HABI_CONFIRM_TRACE === '1') console.warn('[habi-confirm]', JSON.stringify({ at: new Date().toISOString(), id,
      body: request.body ?? null, ua: request.headers['user-agent'] ?? null, origin: request.headers['origin'] ?? null,
      referer: request.headers['referer'] ?? null }));
    const body = parse(z.object({ expectedVersion: z.number().int().min(1).optional(),
      portionFraction: z.number().min(0).max(1).optional(), note: z.string().max(1000).optional() })
      .refine(value => value.portionFraction === undefined ? value.note === undefined : value.expectedVersion !== undefined), request.body ?? {});
    const correction = body.portionFraction === undefined ? null : { portionFraction: body.portionFraction, note: body.note ?? '' };
    const result = store.confirmMeal(id, body.expectedVersion, correction);
    return { ...result, meal: mealView(result.meal), state: viewState() };
  });
  app.post('/api/meals/:id/analyze', async request => {
    const id = parse(idSchema, request.params.id);
    parse(z.object({ consentToUpload: z.literal(true) }), request.body);
    if (!provider.visionConfigured) throw fail('尚未配置食物分析模型，可先保存照片并确认食量', 503);
    const meal = store.get('meals', id);
    if (!meal) throw fail('没有找到这餐记录', 404);
    if (activeAnalysis.has(id)) throw fail('这一餐正在分析，请稍候', 409);
    activeAnalysis.add(id);
    try {
      const capture = store.get('captures', meal.images[0].id);
      const buffer = await readFile(path.join(mediaDirectory, capture.filename));
      const estimate = await provider.analyze(buffer, capture.mimeType);
      // Fetch again after remote work so a concurrent user correction is never overwritten.
      const latest = store.get('meals', id);
      latest.title = estimate.title;
      latest.status = latest.confirmedAt ? 'confirmed' : 'estimated';
      latest.version += 1;
      latest.updatedAt = store.now();
      latest.analysis = { status: 'ready', provider: 'model', modelName: provider.visionModel,
        foods: estimate.foods, calorieRange: estimate.calorieRange, macros: estimate.macros ?? null, uncertainties: estimate.uncertainties,
        analyzedAt: store.now(), error: null, captureIds: [capture.id] };
      store.put('meals', id, latest);
      store.event('meal.analyzed', { mealId: id, captureIds: [capture.id] });
      return { meal: mealView(latest), state: viewState() };
    } catch (error) {
      const latest = store.get('meals', id);
      // Retain the last valid estimate on a failed refresh, clearly record the latest failure.
      latest.analysis = { ...latest.analysis, status: latest.analysis.calorieRange ? 'ready' : 'failed', error: error.message };
      latest.version += 1;
      latest.updatedAt = store.now();
      store.put('meals', id, latest);
      throw error;
    } finally { activeAnalysis.delete(id); }
  });

  // A photo is the user's own record. Deleting one is always allowed, whatever the review decided,
  // and when a photo is the last one of a meal the meal goes with it rather than being left empty.
  app.post('/api/captures/:id/recall', async request => {
    const id = parse(idSchema, request.params.id);
    const capture = store.get('captures', id);
    if (!capture) throw fail('这张照片已经不在记录里了', 404);
    const meal = capture.mealId ? store.get('meals', capture.mealId) : null;
    const summary = { captureId: id, source: capture.source ?? null, hadMeal: Boolean(meal),
      mealId: meal?.id ?? null, confirmed: Boolean(meal?.confirmedAt), mealIdWasLastPhoto: false };
    let deleteMeal = false;
    store.transaction(() => {
      store.delete('captures', id);
      store.delete('reviewJobs', id);
      const session = capture.session_id ? store.get('captureSessions', capture.session_id) : null;
      if (session) {
        const remaining = store.list('captures').filter(item => item.session_id === session.sessionId);
        if (remaining.length === 0 && !session.mealId) store.delete('captureSessions', session.sessionId);
        else store.put('captureSessions', session.sessionId, { ...session, imageUrl: remaining.at(-1)?.imageUrl ?? session.imageUrl, updatedAt: store.now() });
      }
      if (meal) {
        meal.images = (meal.images ?? []).filter(image => image.id !== id);
        meal.version += 1;
        meal.updatedAt = store.now();
        // A meal with no photo left has nothing to show or estimate, so it is withdrawn with it.
        deleteMeal = meal.images.length === 0;
        summary.mealIdWasLastPhoto = deleteMeal;
        if (deleteMeal) store.delete('meals', meal.id); else store.put('meals', meal.id, meal);
      }
      store.event('capture.recalled', summary);
    });
    // Rows first, files after: a failed unlink must never leave a half-deleted record behind.
    if (capture.filename) await unlink(path.join(mediaDirectory, capture.filename)).catch(() => {});
    return { recalled: summary, state: viewState() };
  });

  // Withdrawing a meal is the user's call at any time: the record, its photos and any suggestion
  // that pointed at it go away together, and only the fact of the recall is kept.
  app.post('/api/meals/:id/recall', async request => {
    const id = parse(idSchema, request.params.id);
    const meal = store.get('meals', id);
    if (!meal) throw fail('这一餐已经不在记录里了', 404);
    const captures = store.list('captures').filter(item => item.mealId === id);
    const proposals = store.list('messages').filter(item => item.mealProposal?.mealId === id);
    const sessionId = store.settings().lastCaptureSessionId;
    const session = sessionId ? store.get('captureSessions', sessionId) : null;
    const summary = { mealId: id, source: meal.source ?? null, confirmed: Boolean(meal.confirmedAt),
      portionFraction: meal.portionFraction ?? null, captureCount: captures.length, proposalCount: proposals.length,
      hadAnalysis: Boolean(meal.analysis?.calorieRange) };
    store.transaction(() => {
      for (const capture of captures) store.delete('captures', capture.id);
      for (const proposal of proposals) store.delete('messages', proposal.id);
      store.delete('posts', `meal-confirmed-${id}`);
      store.delete('meals', id);
      if (session && session.mealId === id) store.put('captureSessions', session.id, { ...session, mealId: null });
      store.event('meal.recalled', summary);
    });
    // Rows first, files after: a failed unlink must never leave a half-deleted record behind.
    for (const capture of captures) {
      if (capture.filename) await unlink(path.join(mediaDirectory, capture.filename)).catch(() => {});
    }
    return { recalled: summary, state: viewState() };
  });

  async function respond(message, post = null, selectedMeal = null) {
    const proposal = mealDraft(selectedMeal, message);
    if (proposal && proposal.portionFraction !== null) return {
      content: '先按你说的放在待确认的补充里。确认后，这餐的记录才会更新。',
      mode: 'local-rules', mealProposal: proposal,
    };
    const scope = selectedMeal?.id ?? null;
    const history = post ? post.replies.map(item => ({ role: item.role, content: item.body }))
      : store.list('messages').filter(item => (item.mealId ?? null) === scope).slice(0, 12).reverse();
    let content;
    if (provider.chatConfigured) content = await provider.chat(message, history, {
      post: post ? { body: post.body, kind: post.kind } : null,
      selectedMeal: selectedMeal ? {
        id: selectedMeal.id, title: selectedMeal.title, capturedAt: selectedMeal.capturedAt ?? selectedMeal.createdAt,
        confirmed: Boolean(selectedMeal.confirmedAt), portionFraction: selectedMeal.portionFraction, note: selectedMeal.note,
        analysisStatus: selectedMeal.analysis.status, foods: selectedMeal.analysis.foods,
        plateCalorieRange: selectedMeal.analysis.calorieRange, uncertainties: selectedMeal.analysis.uncertainties,
      } : null,
      confirmedMeals: store.list('meals').filter(meal => meal.confirmedAt).slice(0, 5).map(mealView),
      preferences: store.list('events').filter(item => item.type === 'preference.shared').slice(0, 10).map(item => item.text),
    });
    return { content: content ?? (proposal ? '这句先放在待确认的补充里。选一下这餐吃了多少，再确认就好。' : localReply(message)),
      mode: content ? 'model' : 'local-rules', ...(proposal ? { mealProposal: proposal } : {}) };
  }
  const inFlightMessages = new Map();
  app.post('/api/chat', async request => {
    const body = parse(z.object({ message: z.string().trim().min(1).max(4000), clientMessageId: idSchema.optional(), mealId: idSchema.optional() })
      .refine(value => !value.mealId || value.message.length <= 1000), request.body);
    const mealId = body.mealId ?? null;
    const sameRequest = value => value.input === body.message && (value.mealId ?? null) === mealId;
    const key = body.clientMessageId;
    if (key && inFlightMessages.has(key)) {
      const pending = inFlightMessages.get(key);
      if (!sameRequest(pending)) throw fail('消息 ID 已对应另一条内容或一餐', 409);
      return pending.promise;
    }
    const old = key ? store.get('chatRequests', key) : null;
    if (old) {
      if (!sameRequest(old)) throw fail('消息 ID 已对应另一条内容或一餐', 409);
      return { message: store.get('messages', old.responseId), state: viewState() };
    }
    const selectedMeal = mealId ? store.get('meals', mealId) : null;
    if (mealId && !selectedMeal) throw fail('没有找到这餐记录', 404);
    const action = (async () => {
      const signalId = key ? `chat-${createHash('sha256').update(key).digest('hex').slice(0, 32)}` : store.id('signal');
      let input = key ? store.get('chatSignalInputs', signalId) : null;
      if (input && (input.text !== body.message || (input.mealId ?? null) !== mealId)) throw fail('消息 ID 已对应另一条内容或一餐', 409);
      input ??= { signalId, text: body.message,
        mealId,
        speaker: 'self', sourceContext: 'user-conversation', observedAt: store.now(),
        recentUtterances: store.list('messages').filter(item => item.role === 'user' && (item.mealId ?? null) === mealId
          && store.clock().getTime() - Date.parse(item.createdAt) < 120000).slice(0, 5).reverse().map(item => item.content) };
      // Freeze the original observation and context across a failed model reply.
      // Retrying a message must not create a fresh camera window or an ID conflict.
      if (key) store.put('chatSignalInputs', signalId, input);
      // Clarifying an existing meal is not a new automatic-photo request.
      const classification = selectedMeal ? null : await trigger.classify(input);
      const intent = selectedMeal ? { action: 'ignore' } : diningIntent(input, classification, store.clock());
      const signal = selectedMeal ? null : applyTrigger(store, intent.explicit ? { ...classification, hardVeto: true, reason: 'restaurant_search_request' } : classification, input, false, captureCooldownMs);
      const recommendation = selectedMeal ? { action: 'ignore' } : dining.onSignal(input, classification, false);
      const response = intent.explicit ? { content: recommendation.job ? '我来看看附近符合你偏好的餐厅，推荐卡会在查询完成后更新。'
        : '暂时还不能生成附近餐厅推荐，请检查定位与餐厅服务配置。', mode: 'local-rules' } : await respond(body.message, null, selectedMeal);
      const user = { id: store.id('message'), role: 'user', content: body.message, mealId, createdAt: store.now(), mode: 'user' };
      // The reply keeps a pointer to the question it answered.
      const assistant = { id: store.id('message'), role: 'assistant', ...response, mealId, replyToId: user.id, createdAt: store.now() };
      store.transaction(() => {
        store.put('messages', user.id, user);
        store.put('messages', assistant.id, assistant);
        if (/^(?:我)?(?:不喜欢|喜欢|讨厌)/.test(body.message)) store.event('preference.shared', { text: body.message, messageId: user.id });
        if (key) store.put('chatRequests', key, { id: key, input: body.message, mealId, responseId: assistant.id, createdAt: store.now() });
        if (signal?.action !== 'capture_window') store.scene('listening');
      });
      return { message: assistant, signal, dining: recommendation, state: viewState() };
    })();
    if (key) inFlightMessages.set(key, { input: body.message, mealId, promise: action });
    try { return await action; } finally { if (key) inFlightMessages.delete(key); }
  });
  // What you said stays said. Only a record the camera produced can be taken back, and that lives on
  // POST /api/meals/:id/recall with no time limit at all.
  app.post('/api/posts/:id/reply', async request => {
    const id = parse(idSchema, request.params.id);
    const { message } = parse(z.object({ message: z.string().trim().min(1).max(4000) }), request.body);
    const post = store.get('posts', id);
    if (!post) throw fail('没有找到这条动态', 404);
    const response = await respond(message, post);
    const user = { id: store.id('reply'), role: 'user', body: message, createdAt: store.now(), mode: 'user' };
    const assistant = { id: store.id('reply'), role: 'assistant', body: response.content, createdAt: store.now(), mode: response.mode };
    const latest = store.get('posts', id);
    latest.replies.push(user, assistant);
    store.put('posts', id, latest);
    store.scene('listening');
    return { post: latest, reply: assistant, state: viewState() };
  });

  const frontend = path.resolve(options.frontendDir ?? path.join(repoRoot, 'apps/studio/dist'));
  if (await stat(path.join(frontend, 'index.html')).then(() => true).catch(() => false)) {
    await app.register(staticFiles, { root: frontend, prefix: '/', decorateReply: true });
    app.setNotFoundHandler((request, reply) => {
      if (request.method !== 'GET' || request.url.startsWith('/api/') || request.url.startsWith('/media/'))
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '没有找到这个资源' } });
      return reply.sendFile('index.html');
    });
  }
  reviewer.schedule();
  return app;
}
