/** Real Step API check using an isolated backend and a supplied synthetic PNG. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../services/api/src/app.mjs';
import { ModelProvider } from '../../services/api/src/provider.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false },
  fixture: { type: 'string' }, output: { type: 'string', default: 'output/validation/mac-step-check.json' } } });
if (!values.live || !values.fixture) {
  process.stderr.write('Requires --live --fixture PATH. Sends this test PNG and a synthetic greeting to the configured Step API.\n');
  process.exit(2);
}
const png = await readFile(values.fixture);
assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG fixture required');
const calls = [];
const provider = new ModelProvider(process.env, async (url, init) => {
  assert.equal(new URL(url).origin, 'https://api.stepfun.com', 'This diagnostic only permits official Step');
  const start = performance.now();
  const response = await fetch(url, init);
  const data = await response.clone().json().catch(() => null);
  calls.push({ httpStatus: response.status, model: data?.model ?? null,
    elapsedMs: Math.round(performance.now() - start), finishReason: data?.choices?.[0]?.finish_reason ?? null,
    usage: data?.usage ?? null,
    // Only this explicit synthetic fixture/greeting response, never the request key.
    content: typeof data?.choices?.[0]?.message?.content === 'string'
      ? data.choices[0].message.content.slice(0, 16000) : null });
  return response;
});
const analyze = provider.analyze.bind(provider);
let modelResult;
provider.analyze = async (...args) => { modelResult = await analyze(...args); return modelResult; };
assert.ok(provider.visionConfigured && provider.chatConfigured, 'Configure both Step vision and chat first');
const scratch = await mkdtemp(path.join(os.tmpdir(), 'companion-step-check-'));
const token = randomBytes(32).toString('hex');
const app = await createApp({ provider, dataDir: scratch,
  env: { HOST: '127.0.0.1', APP_ACCESS_TOKEN: token, DEVICE_ACCESS_TOKEN: randomBytes(32).toString('hex') } });
const report = { checkedAt: new Date().toISOString(), syntheticFixture: true, realStepApi: true,
  productionDataModified: false, apiKeyPrinted: false,
  fixtureSha256: createHash('sha256').update(png).digest('hex'),
  model: provider.visionModel, chatModel: provider.chatModel, calls };
try {
  const form = new FormData(); form.append('image', new Blob([png], { type: 'image/png' }), 'synthetic-api-check.png');
  const request = new Request('http://localhost/api/capture', { method: 'POST', body: form });
  const capture = await app.inject({ method: 'POST', url: '/api/capture',
    headers: { 'content-type': request.headers.get('content-type'), 'x-app-token': token },
    payload: Buffer.from(await request.arrayBuffer()) });
  assert.equal(capture.statusCode, 201, capture.body);
  const meal = capture.json().meal;
  const analyzed = await app.inject({ method: 'POST', url: `/api/meals/${meal.id}/analyze`,
    headers: { 'x-app-token': token }, payload: { consentToUpload: true } });
  report.vision = { httpStatus: analyzed.statusCode, modelResult,
    result: analyzed.json().meal?.analysis ?? analyzed.json().error };
  assert.equal(analyzed.statusCode, 200, analyzed.body);
  assert.equal(report.vision.modelResult.foodDetected, false);
  assert.equal(report.vision.result.calorieRange, null);
  const chat = await app.inject({ method: 'POST', url: '/api/chat', headers: { 'x-app-token': token },
    payload: { message: '你好，这是接口连通性测试。请用一句中文问候。', clientMessageId: 'explicit-step-connectivity-check' } });
  const response = chat.json();
  report.chat = { httpStatus: chat.statusCode, mode: response.message?.mode,
    text: response.message?.content ?? response.error?.message };
  assert.equal(chat.statusCode, 200, chat.body);
  assert.equal(report.chat.mode, 'model');
  assert.ok(report.chat.text?.length > 0);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => call.httpStatus === 200));
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message.slice(0, 1000); process.exitCode = 1;
} finally {
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(values.output), { recursive: true });
  await writeFile(values.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await app.close(); await rm(scratch, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ report: values.output, passed: report.passed,
  model: report.model, visionStatus: report.vision?.httpStatus, chatStatus: report.chat?.httpStatus,
  productionDataModified: false }) + '\n');
