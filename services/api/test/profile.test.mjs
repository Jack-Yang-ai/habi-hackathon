import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.mjs';

async function setup(t, env = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'companion-profile-'));
  let app = await createApp({ dataDir, env });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { get app() { return app; }, async reopen() { await app.close(); app = await createApp({ dataDir, env }); } };
}
const fixture = { nickname: '界面测试用户', gender: 'undisclosed', age: 30, heightCm: 170.5, weightKg: 65.2, goal: 'balanced', dietaryNotes: '仅为测试备注' };

test('profile starts empty, saves optional details durably and can be cleared', async t => {
  const ctx = await setup(t);
  const empty = (await ctx.app.inject('/api/profile')).json().profile;
  assert.deepEqual(empty, { nickname: '', gender: 'undisclosed', age: null, heightCm: null, weightKg: null, goal: null, dietaryNotes: '', calorieTarget: null, updatedAt: null });
  const saved = await ctx.app.inject({ method: 'POST', url: '/api/profile', payload: { ...fixture, nickname: '  界面测试用户  ' } });
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().profile.nickname, fixture.nickname);
  assert.ok(saved.json().profile.updatedAt);
  await ctx.reopen();
  assert.deepEqual((await ctx.app.inject('/api/profile')).json().profile, saved.json().profile);
  assert.deepEqual((await ctx.app.inject('/api/state')).json().profile, saved.json().profile);
  assert.equal((await ctx.app.inject('/api/state')).json().meals.length, 0);
  const cleared = await ctx.app.inject({ method: 'POST', url: '/api/profile', payload: {} });
  assert.equal(cleared.statusCode, 200);
  const { updatedAt, ...fields } = cleared.json().profile;
  assert.ok(updatedAt);
  assert.deepEqual({ ...fields, updatedAt: null }, empty);
});

test('invalid profile values leave the saved profile unchanged', async t => {
  const { app } = await setup(t);
  const saved = (await app.inject({ method: 'POST', url: '/api/profile', payload: fixture })).json().profile;
  for (const invalid of [{ age: 0 }, { age: 30.5 }, { heightCm: 251 }, { weightKg: -1 }, { weightKg: '65' }, { nickname: 'a'.repeat(31) }, { dietaryNotes: 'x'.repeat(501) }, { gender: 'invalid' }, { goal: 'invalid' }, { calorieTarget: 100 }, { calorieTarget: 1800.5 }, { unexpected: true }]) {
    const response = await app.inject({ method: 'POST', url: '/api/profile', payload: { ...fixture, ...invalid } });
    assert.equal(response.statusCode, 400, JSON.stringify(invalid));
    assert.deepEqual((await app.inject('/api/profile')).json().profile, saved);
  }
});

test('profile uses app authorization and cannot be read or changed with a device credential', async t => {
  const { app } = await setup(t, { APP_ACCESS_TOKEN: 'profile-app-fixture', DEVICE_ACCESS_TOKEN: 'profile-device-fixture' });
  assert.equal((await app.inject('/api/profile')).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/profile', headers: { 'x-device-token': 'profile-device-fixture' } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/api/profile', payload: fixture, headers: { 'x-device-token': 'profile-device-fixture' } })).statusCode, 401);
  const response = await app.inject({ method: 'POST', url: '/api/profile', payload: fixture, headers: { 'x-app-token': 'profile-app-fixture' } });
  assert.equal(response.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/profile', headers: { 'x-app-token': 'profile-app-fixture' } })).json().profile.nickname, fixture.nickname);
});
