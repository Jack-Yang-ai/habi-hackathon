/** Opt-in live HTTP-contract check using public test coordinates and an isolated database. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from '../../services/api/src/app.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, help: { type: 'boolean' }, swap: { type: 'boolean' },
  'max-requests': { type: 'string', default: '3' },
  longitude: { type: 'string' }, latitude: { type: 'string' }, coordsys: { type: 'string', default: 'gcj02' } } });
if (values.help) {
  console.log('node --env-file=.env tools/backend/check-amap.mjs --live --longitude 116.397 --latitude 39.908 --coordsys gcj02');
  process.exit(0);
}
if (!values.live) throw new Error('Use --live to explicitly enable Amap requests; consumes your configured API quota.');
if (!process.env.AMAP_WEB_SERVICE_KEY?.trim()) throw new Error('Configure AMAP_WEB_SERVICE_KEY in the server .env first.');
if (values.longitude === undefined || values.latitude === undefined) throw new Error('Explicit test coordinates are required.');
const maxRequests = Number(values['max-requests']);
if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 5) throw new Error('--max-requests must be between 1 and 5.');
let requestsUsed = 0;
const limitedFetch = async (...args) => {
  if (requestsUsed >= maxRequests) throw new Error('Live check request budget exhausted; no further network request sent.');
  requestsUsed++;
  return fetch(...args);
};
const directory = await mkdtemp(path.join(os.tmpdir(), 'habi-amap-live-'));
let app;
try {
  app = await createApp({ dataDir: directory, env: { AMAP_WEB_SERVICE_KEY: process.env.AMAP_WEB_SERVICE_KEY,
    AMAP_TIMEOUT_MS: process.env.AMAP_TIMEOUT_MS, AMAP_SEARCH_KEYWORDS_MAX: '1' }, amapFetcher: limitedFetch, diningScheduler: false });
  const position = await app.inject({ method: 'POST', url: '/api/dining/location', payload: {
    longitude: Number(values.longitude), latitude: Number(values.latitude), coordinateSystem: values.coordsys,
    accuracyMeters: 10, observedAt: new Date().toISOString(),
  } });
  if (position.statusCode !== 200) throw new Error(`Location contract failed: HTTP ${position.statusCode}`);
  const queued = await app.inject({ method: 'POST', url: '/api/dining/recommendations', payload: { requestId: 'isolated-live-check' } });
  if (queued.statusCode !== 202) throw new Error(`Recommendation contract failed: HTTP ${queued.statusCode}`);
  await app.dining.idle();
  const result = (await app.inject('/api/dining/requests/isolated-live-check')).json();
  if (result.job.status !== 'succeeded') {
    console.log(JSON.stringify({ ok: false, stage: result.job.status, error: result.job.error, requestsUsed, maxRequests, isolatedDatabase: true }));
    process.exitCode = 1;
  } else {
    const navigation = await app.inject(`/api/dining/recommendations/${result.card.id}/navigation`);
    const swapped = values.swap ? await app.inject({ method: 'POST', url: `/api/dining/recommendations/${result.card.id}/swap`,
      payload: { requestId: 'isolated-live-swap', expectedVersion: result.card.version } }) : null;
    await app.dining.idle();
    const swap = swapped?.statusCode === 202 ? (await app.inject('/api/dining/requests/isolated-live-swap')).json() : null;
    const passed = navigation.statusCode === 200 && (swap ? swap.job.status === 'succeeded' && swap.card.restaurant.id !== result.card.restaurant.id
      : !values.swap || swapped.json().error?.code === 'DINING_NO_ALTERNATIVE');
    console.log(JSON.stringify({ ok: passed, provider: 'amap', recommendation: result.job.status,
      restaurantName: result.card.restaurant.name, walking: result.card.restaurant.walking.status,
      navigation: navigation.statusCode, swap: swap?.job.status ?? (values.swap ? 'no_alternative' : 'not_requested'), requestsUsed, maxRequests,
      credentialsPrinted: false, isolatedDatabase: true, realNutritionVerified: false }));
    if (!passed) process.exitCode = 1;
  }
} finally {
  if (app) await app.close();
  await rm(directory, { recursive: true, force: true });
}
