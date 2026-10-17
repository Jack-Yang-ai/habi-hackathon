/** Explicit, isolated replay: saved phone decision -> connector -> real Step vision.
 * No recording, camera, firmware exposure, production API or LAN listener is used.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../services/api/src/app.mjs';
import { ModelProvider } from '../../services/api/src/provider.mjs';

const { values } = parseArgs({ options: {
  live: { type: 'boolean', default: false },
  'phone-report': { type: 'string' }, 'no-food-png': { type: 'string' },
  output: { type: 'string', default: 'output/validation/phone-connector-step-replay.json' },
} });
if (!values.live || !values['phone-report'] || !values['no-food-png']) {
  process.stderr.write('Requires --live --phone-report PATH --no-food-png PATH. Sends the supplied test PNG to real Step vision.\n');
  process.exit(2);
}

const saved = JSON.parse(await readFile(values['phone-report'], 'utf8'));
const original = saved.matches?.find(item => item.localDecision && item.asrEvidence);
assert.ok(original, 'Phone report must contain an actual saved decision and audio timing evidence');
const image = await readFile(values['no-food-png']);
assert.ok(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Fixture must be PNG');
const width = image.readUInt32BE(16), height = image.readUInt32BE(20);
const apiKey = process.env.STEPFUN_API_KEY || process.env.FOOD_MODEL_API_KEY;
assert.ok(apiKey, 'A local Step API key is required');
// Whitelisted configuration prevents ambient gateway URLs from receiving this key.
const stepResponses = [];
const provider = new ModelProvider({ FOOD_MODEL_PROVIDER: 'stepfun', STEPFUN_API_KEY: apiKey,
  FOOD_MODEL_NAME: 'step-1o-turbo-vision', MODEL_TIMEOUT_MS: '120000' }, async (url, options) => {
  const response = await fetch(url, options);
  const data = await response.clone().json().catch(() => null);
  // Only the synthetic fixture response is recorded; request headers/keys are never saved.
  stepResponses.push({ httpStatus: response.status, model: data?.model ?? null,
    errorCode: data?.error?.code ?? null, finishReason: data?.choices?.[0]?.finish_reason ?? null,
    content: data?.choices?.[0]?.message?.content?.slice(0, 16000) ?? null });
  return response;
});
let visionCalls = 0, visionError = null;
const analyze = provider.analyze.bind(provider);
provider.analyze = async (...args) => {
  visionCalls += 1;
  try { return await analyze(...args); }
  catch (error) { visionError = { statusCode: error.statusCode ?? null, message: error.message }; throw error; }
};

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), 'echo-live-connector-'));
const secret = () => randomBytes(32).toString('base64url');
const appToken = secret(), upstreamToken = secret(), deviceToken = secret();
// Retain the recorded observedAt. Move only the isolated test server clock back
// to that signal, then advance it with real elapsed time throughout the replay.
const elapsedStart = performance.now();
const replayStart = Date.parse(original.observedAt) + 1000;
assert.ok(Number.isFinite(replayStart), 'Invalid original recording time');
let hostDecisionCalls = 0, app, bridge, lines;
const checkedAt = new Date().toISOString();
try {
  app = await createApp({ dataDir: path.join(scratch, 'api'), provider,
    env: { HOST: '127.0.0.1', APP_ACCESS_TOKEN: appToken, DEVICE_ACCESS_TOKEN: upstreamToken,
      JEV_URL: 'http://127.0.0.1:1' },
    clock: () => new Date(replayStart + performance.now() - elapsedStart),
    triggerFetcher: async () => { hostDecisionCalls += 1; throw new Error('Host inference forbidden in this replay'); },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  // The connector receives only disposable device credentials, never Step keys.
  const childEnv = { PATH: process.env.PATH, PYTHONUNBUFFERED: '1',
    ESP32_CONNECTOR_TOKEN: deviceToken, DEVICE_ACCESS_TOKEN: upstreamToken };
  bridge = spawn(process.env.PYTHON || 'python3', [path.join(root, 'tools/esp32/connector.py'), 'serve',
    '--host', '127.0.0.1', '--port', '0', '--upstream', base],
    { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  lines = createInterface({ input: bridge.stdout });
  let connectorErrors = '';
  bridge.stderr.on('data', chunk => { connectorErrors += chunk; });
  const ready = await Promise.race([
    once(lines, 'line', { signal: AbortSignal.timeout(5000) }).then(([line]) => JSON.parse(line)),
    once(bridge, 'exit').then(() => { throw new Error('Connector exited before ready: ' + connectorErrors); }),
  ]);
  const deviceBase = 'http://127.0.0.1:' + ready.port;
  const appJson = async (route, method = 'GET', body) => {
    const response = await fetch(base + route, { method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'X-App-Token': appToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200, 'Isolated App API response');
    return response.json();
  };
  const config = async () => {
    const response = await fetch(deviceBase + '/api/device/config?device_id=replay-camera', {
      headers: { 'X-Device-Token': deviceToken }, redirect: 'error', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); return response.json();
  };
  assert.equal((await config()).paused, true);
  await appJson('/api/device/pause', 'POST', { paused: false });
  const signal = await appJson('/api/signals/context', 'POST', {
    signalId: original.signalId, text: original.text, observedAt: original.observedAt,
    speaker: 'unknown', sourceContext: 'unknown', recentUtterances: [], audioEvents: [],
    asrEvidence: original.asrEvidence, localDecision: original.localDecision, dryRun: false,
  });
  assert.equal(signal.signal.action, 'capture_window');
  assert.equal(signal.signal.stage, 'start_soon');
  assert.equal(signal.signal.classification.ingestionConfirmed, false);
  assert.equal(signal.signal.classification.modelAssessment.execution, 'android-local');
  const before = await config();
  const window = before.capture_window;
  assert.equal(window.phase, 'probe'); assert.equal(window.remaining, 1);
  const metadata = { schema_version: 1, capture_id: 'replay-first-photo', device_id: 'replay-camera',
    boot_id: 'explicit-software-replay', sequence: 0, captured_at: before.server_time,
    time_source: 'server', uptime_ms: Math.floor(performance.now() - elapsedStart),
    mime_type: 'image/png', width, height, session_id: window.session_id,
    capture_window_id: window.id, capture_phase: window.phase };
  const upload = async () => {
    const form = new FormData(); form.append('image', new Blob([image], { type: 'image/png' }), 'synthetic-no-food.png');
    form.append('metadata', JSON.stringify(metadata));
    const response = await fetch(deviceBase + '/api/device/captures', { method: 'POST',
      headers: { 'X-Device-Token': deviceToken }, body: form, redirect: 'error', signal: AbortSignal.timeout(10000) });
    return { status: response.status, body: await response.json() };
  };
  const first = await upload(); assert.equal(first.status, 201); assert.equal(first.body.capture_id, metadata.capture_id);
  await app.reviewer.drain();
  const after = await appJson('/api/state');
  const deviceAfter = await config();
  const repeated = await upload();
  await app.reviewer.drain();
  assert.equal(repeated.status, 200); assert.equal(repeated.body.duplicate, true);
  assert.equal(visionCalls, 1); assert.equal(hostDecisionCalls, 0);
  const report = { checkedAt, completedAt: new Date().toISOString(), replayed: true,
    clockMode: 'original-signal-time-plus-real-elapsed', asrRerun: false, deciderRerun: false,
    originalSignalId: original.signalId, originalObservedAt: original.observedAt,
    originalAudioSha256: original.asrEvidence.audioSha256,
    recentUtterances: 'not present in saved report; replay uses empty history',
    microphoneStarted: false, hardwareCameraTest: false, firmwarePolicyExecuted: false,
    production8787Contacted: false, lanListenerOpened: false,
    fixture: { kind: 'supplied synthetic no-food PNG', width, height,
      sha256: createHash('sha256').update(image).digest('hex') },
    model: provider.visionModel, stepApiCalled: true, visionCalls, visionError, stepResponses, hostDecisionCalls,
    trigger: { stage: signal.signal.stage, action: signal.signal.action,
      ingestionConfirmed: signal.signal.classification.ingestionConfirmed },
    firstConfig: { phase: window.phase, remaining: window.remaining },
    ackStatus: first.status, duplicateAckStatus: repeated.status,
    review: after.device.captureReview, meals: after.meals.length,
    remainingWindow: after.device.captureWindow, devicePaused: deviceAfter.paused,
  };
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  assert.equal(report.review.status, 'no_food', 'Inspect saved report if real vision did not return clear no-food');
  assert.equal(report.review.foodDetected, false); assert.equal(report.meals, 0);
  assert.equal(report.remainingWindow, null); assert.equal(report.devicePaused, true);
  process.stdout.write(JSON.stringify({ report: values.output, review: report.review.status,
    stepApiCalled: true, visionCalls, meals: report.meals, duplicateAckStatus: repeated.status,
    hardwareCameraTest: false }) + '\n');
} finally {
  if (bridge && bridge.exitCode === null) { const exited = once(bridge, 'exit'); bridge.kill('SIGTERM'); await exited; }
  lines?.close(); await app?.close(); await rm(scratch, { recursive: true, force: true });
}
