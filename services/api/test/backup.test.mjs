import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../src/app.mjs';

test('a live database backup restores the confirmed portion and exact original photo', async () => {
  const run = promisify(execFile);
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'habi-backup-test-'));
  const source = path.join(scratch, 'source'), backup = path.join(scratch, 'backup');
  let app, restored;
  try {
    app = await createApp({ env: {}, dataDir: source });
    const png = await readFile(path.join(root, 'tools/backend/fixtures/no-food.png'));
    const form = new FormData(); form.append('image', new Blob([png], { type: 'image/png' }), 'synthetic.png');
    const request = new Request('http://localhost/api/capture', { method: 'POST', body: form });
    const result = await app.inject({ method: 'POST', url: '/api/capture',
      headers: { 'content-type': request.headers.get('content-type') }, payload: Buffer.from(await request.arrayBuffer()) });
    assert.equal(result.statusCode, 201);
    const meal = result.json().meal;
    assert.equal((await app.inject({ method: 'POST', url: `/api/meals/${meal.id}/correction`, payload: { portionFraction: 0.5 } })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: `/api/meals/${meal.id}/confirm`, payload: {} })).statusCode, 200);
    // Source stays open in WAL mode; copying just its original .sqlite would be insufficient.
    const output = await run(process.execPath, [path.join(root, 'tools/backend/backup.mjs'), '--data-dir', source, '--output', backup]);
    const receipt = JSON.parse(output.stdout);
    assert.equal(receipt.integrity, 'ok'); assert.equal(receipt.photos, 1);
    assert.equal(receipt.audioIncluded, false); assert.equal(receipt.credentialsIncluded, false);
    restored = await createApp({ env: {}, dataDir: backup });
    const saved = (await restored.inject('/api/state')).json().meals;
    assert.equal(saved.length, 1); assert.equal(saved[0].id, meal.id);
    assert.equal(saved[0].portionFraction, 0.5); assert.equal(saved[0].status, 'confirmed');
    assert.deepEqual((await restored.inject(saved[0].imageUrl)).rawPayload, png);
  } finally {
    await restored?.close(); await app?.close(); await rm(scratch, { recursive: true, force: true });
  }
});
