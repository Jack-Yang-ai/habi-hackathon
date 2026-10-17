/**
 * Live integration check against a deployed Habi backend — by default https://habi.zhexin.site,
 * the Mac mini that the phone's App service address points at.
 *
 * It answers "is the real deployment usable right now, and is it the build we think it is?":
 *   /health · served frontend bundle vs the local build · app session + /api/state ·
 *   device auth with the board's token (the phone relay forwards exactly this header) ·
 *   optionally one explicit synthetic PNG through the real phone-camera upload/review route.
 *
 * Read-only by default. --photo writes one synthetic capture to the remote database, then removes
 * it again through the normal recall route unless --keep-photo is given. No token is ever printed
 * or written into the report. Nothing here is evidence of food/calorie accuracy.
 *
 * Usage (from the repo root; tokens come from the Mac mini's .env and are never committed):
 *   node --env-file-if-exists=.env tools/backend/check-remote.mjs \
 *     --base https://habi.zhexin.site \
 *     --app-token "$APP_ACCESS_TOKEN" --device-token "$DEVICE_ACCESS_TOKEN" \
 *     [--photo] [--expect-bundle index-C1YhDFSZ.js]
 *
 * Or put HABI_REMOTE_BASE_URL / HABI_REMOTE_APP_TOKEN / HABI_REMOTE_DEVICE_TOKEN in the local .env.
 */
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';

const { values } = parseArgs({ options: {
  base: { type: 'string' },
  'app-token': { type: 'string' },
  'device-token': { type: 'string' },
  photo: { type: 'boolean', default: false },
  'keep-photo': { type: 'boolean', default: false },
  'expect-bundle': { type: 'string' },
  timeout: { type: 'string', default: '120000' },
  'local-dist': { type: 'string', default: 'apps/studio/dist/index.html' },
  output: { type: 'string', default: 'output/validation/remote-check.json' },
} });

const base = (values.base ?? process.env.HABI_REMOTE_BASE_URL ?? 'https://habi.zhexin.site').replace(/\/+$/, '');
const appToken = values['app-token'] ?? process.env.HABI_REMOTE_APP_TOKEN ?? '';
const deviceToken = values['device-token'] ?? process.env.HABI_REMOTE_DEVICE_TOKEN ?? '';
const timeoutMs = Number(values.timeout);
const fixturePath = path.join(import.meta.dirname, 'fixtures', 'no-food.png');
const report = { checkedAt: new Date().toISOString(), base, syntheticFixture: values.photo,
  productionDataModified: false, tokensPrinted: false, checks: [] };
let cookie = '';

function check(name, status, detail = {}) { report.checks.push({ name, status, ...detail }); }
function required(name, detail) { check(name, 'fail', detail); report.failed = true; }

async function fetchWithTimeout(url, init = {}) {
  return fetch(url, { redirect: 'manual', ...init, signal: AbortSignal.timeout(timeoutMs) });
}

try {
  // 1. Public health endpoint. Anything but 200 means the deployment or its tunnel is down.
  const health = await fetchWithTimeout(`${base}/health`);
  const healthBody = await health.json().catch(() => null);
  if (health.status !== 200 || healthBody?.ok !== true) required('health', { httpStatus: health.status, body: healthBody });
  else check('health', 'pass', { httpStatus: health.status, service: healthBody.service });

  // 2. Deployment freshness: the served frontend bundle must be the one this checkout builds.
  try {
    const page = await fetchWithTimeout(`${base}/`);
    const html = await page.text();
    const remoteBundle = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(html)?.[1] ?? null;
    const localHtml = await readFile(values['local-dist'], 'utf8');
    const localBundle = /\/assets\/(index-[A-Za-z0-9_-]+\.js)/.exec(localHtml)?.[1] ?? null;
    const expected = values['expect-bundle'] ?? (values['local-dist'] === 'apps/studio/dist/index.html' ? localBundle : null);
    const detail = { httpStatus: page.status, remoteBundle, localBundle, expectedBundle: expected };
    if (!remoteBundle) required('deployment-bundle', detail);
    else if (expected && remoteBundle !== expected) required('deployment-bundle', { ...detail, reason: '线上前端不是这一版，Mac mini 还没同步/重启' });
    else if (localBundle && remoteBundle !== localBundle) check('deployment-bundle', 'warn', { ...detail, reason: '本地 dist 与线上不同；如果这正是未推送的改动就正常' });
    else check('deployment-bundle', 'pass', detail);
  } catch (error) {
    if (values['expect-bundle']) required('deployment-bundle', { error: error.message.slice(0, 300) });
    else check('deployment-bundle', 'warn', { error: error.message.slice(0, 300) });
  }

  // 3. App session. This is the same connection password the page asks for; the cookie it returns
  //    is what /api/state and the capture routes want.
  if (!appToken) check('app-session', 'skip', { reason: '未提供 --app-token/HABI_REMOTE_APP_TOKEN' });
  else {
    const session = await fetchWithTimeout(`${base}/api/session`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: appToken }) });
    const body = await session.json().catch(() => null);
    cookie = session.headers.getSetCookie?.().map(item => item.split(';')[0]).find(item => item.startsWith('de_session=')) ?? '';
    if (session.status !== 200 || !cookie) required('app-session', { httpStatus: session.status, message: body?.error?.message ?? '连接口令被拒绝或没有返回会话' });
    else check('app-session', 'pass', { httpStatus: session.status });
  }

  // 4. State: the exact request the phone page polls, plus the model/device facts that decide
  //    whether photos can be recognized at all.
  if (!appToken) check('app-state', 'skip', { reason: '需要 --app-token' });
  else {
    const stateResponse = await fetchWithTimeout(`${base}/api/state`, { headers: cookie ? { cookie } : {} });
    const state = await stateResponse.json().catch(() => null);
    if (stateResponse.status !== 200 || !state) required('app-state', { httpStatus: stateResponse.status, body: state?.error ?? null });
    else {
      const detail = { httpStatus: stateResponse.status, schemaVersion: state.schemaVersion,
        meals: state.meals?.length ?? 0, captures: state.captures?.length ?? 0,
        analysisConfigured: state.config?.analysisConfigured ?? null, analysisMode: state.config?.analysisMode ?? null,
        chatMode: state.config?.chatMode ?? null, paused: state.device?.paused ?? null,
        cameraConnected: state.device?.cameraConnected ?? null, phoneConnected: state.device?.phoneConnected ?? null,
        captureReview: state.device?.captureReview?.status ?? null };
      // If the model key is missing on the Mac mini, photos upload but never get recognized. That is
      // a configuration fact, not a transient failure, so it fails the check and says what to fix.
      if (detail.analysisConfigured === false) required('app-state', { ...detail, reason: '线上没有配置食物分析模型（STEPFUN_API_KEY），拍照不会识别' });
      else check('app-state', 'pass', detail);
      report.state = detail;
    }
  }

  // 5. Device auth. The ESP32's token is forwarded byte-for-byte by the phone relay; the Mac mini's
  //    DEVICE_ACCESS_TOKEN must equal it or every board config/status/upload request is a 401.
  //    The probe is a bodyless upload: auth runs before the route reads anything, so a token match
  //    ends in 400 "请以图片文件上传" and nothing is stored. A config GET would register a fresh
  //    synthetic device and make the App show 随身相机 online, so it is deliberately not used.
  if (!deviceToken) check('device-auth', 'skip', { reason: '未提供 --device-token/HABI_REMOTE_DEVICE_TOKEN' });
  else {
    const probe = await fetchWithTimeout(`${base}/api/device/captures`, { method: 'POST',
      headers: { 'x-device-token': deviceToken, 'content-type': 'application/json' }, body: '{}' });
    const body = await probe.json().catch(() => null);
    if (probe.status === 401) {
      required('device-auth', { httpStatus: 401, reason: '设备 token 与服务端 DEVICE_ACCESS_TOKEN 不一致；板子的 token 在 .tools/esp32/device-token' });
    } else if (probe.status === 400) check('device-auth', 'pass', { httpStatus: 400, note: 'token 已通过，空上传按预期被拒绝' });
    else required('device-auth', { httpStatus: probe.status, body: body?.error ?? null });
  }

  // 6. Optional one-photo round trip through the real phone path: upload -> durable capture ->
  //    Step review -> query. Synthetic no-food image only, removed again through the recall route.
  if (!values.photo) check('photo-review', 'skip', { reason: '未指定 --photo（默认只读）' });
  else if (!appToken) check('photo-review', 'skip', { reason: '需要 --app-token 才能上传并清理测试照片' });
  else {
    const png = await readFile(fixturePath);
    assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG fixture required');
    const captureId = `remote-check-${randomUUID()}`;
    const metadata = { schema_version: 1, capture_id: captureId, device_id: 'remote-check',
      boot_id: 'remote-check', sequence: 1, captured_at: new Date().toISOString(), time_source: 'phone',
      uptime_ms: 1, mime_type: 'image/png' };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('image', new Blob([png], { type: 'image/png' }), 'remote-check.png');
    const upload = await fetchWithTimeout(`${base}/api/phone/captures`, { method: 'POST', headers: cookie ? { cookie } : {}, body: form });
    const uploaded = await upload.json().catch(() => null);
    if (upload.status !== 201) required('photo-review', { stage: 'upload', httpStatus: upload.status, body: uploaded?.error ?? null });
    else {
      report.productionDataModified = true;
      const started = Date.now();
      let review = null;
      const terminal = new Set(['no_food', 'food_found', 'uncertain', 'failed', 'cancelled', 'complete']);
      while (Date.now() - started < timeoutMs) {
        const result = await fetchWithTimeout(`${base}/api/phone/captures/${encodeURIComponent(captureId)}`, { headers: cookie ? { cookie } : {} });
        const body = await result.json().catch(() => null);
        review = body?.review ?? null;
        if (result.status !== 200) { review = { status: `http_${result.status}`, error: body?.error?.message }; break; }
        if (review && terminal.has(review.status)) break;
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const detail = { stage: 'review', captureId, elapsedMs: Date.now() - started,
        reviewStatus: review?.status ?? null, foodDetected: review?.foodDetected ?? null, error: review?.error ?? null };
      if (review?.status === 'failed') required('photo-review', { ...detail, reason: '识别调用失败：线上模型配置或网络有问题' });
      else if (review?.status === 'no_food') check('photo-review', 'pass', { ...detail, syntheticImage: 'no-food.png' });
      else if (review?.status === 'food_found' || review?.status === 'complete') check('photo-review', 'warn', { ...detail, reason: '合成无食物图被判为有食物，识别准确率不在此脚本结论内' });
      else check('photo-review', 'warn', { ...detail, reason: '超时仍无终态结论' });
      if (!values['keep-photo']) {
        const recall = await fetchWithTimeout(`${base}/api/captures/${encodeURIComponent(captureId)}/recall`, { method: 'POST', headers: cookie ? { cookie } : {} });
        const recalled = await recall.json().catch(() => null);
        detail.cleanedUp = recall.status === 200;
        if (recall.status !== 200) check('photo-cleanup', 'warn', { httpStatus: recall.status, body: recalled?.error ?? null });
        else { report.productionDataModified = false; check('photo-cleanup', 'pass', { captureId }); }
      } else check('photo-cleanup', 'skip', { reason: '--keep-photo' });
    }
  }
} catch (error) {
  required('run', { error: error.message.slice(0, 1000) });
} finally {
  report.passed = !report.checks.some(item => item.status === 'fail');
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ base, passed: report.passed, report: values.output,
    checks: report.checks.map(item => `${item.status}:${item.name}`), productionDataModified: report.productionDataModified }) + '\n');
  process.exitCode = report.passed ? 0 : 1;
}
