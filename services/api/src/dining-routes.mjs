import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const preferences = z.object({
  proactiveEnabled: z.boolean().optional(), mealTimeEnabled: z.boolean().optional(),
  style: z.enum(['balanced', 'lighter', 'plant-forward']).optional(),
  radiusMeters: z.number().int().min(300).max(5000).optional(),
  maxCostYuan: z.number().positive().max(10000).nullable().optional(),
  excludedKeywords: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
  mealTimes: z.object({ lunch: time.refine(value => value >= '10:00' && value < '15:00').optional(),
    dinner: time.refine(value => value >= '15:00' && value < '23:00').optional() }).strict().optional(),
}).strict();
const location = z.object({ longitude: z.number().min(-180).max(180), latitude: z.number().min(-90).max(90),
  coordinateSystem: z.enum(['gcj02', 'wgs84']), accuracyMeters: z.number().min(0).max(50000),
  observedAt: z.iso.datetime({ offset: true }) }).strict();
const action = z.object({ requestId: id, expectedVersion: z.number().int().min(1) }).strict();

export function registerDiningRoutes(app, dining, parse) {
  const sendJob = (reply, result) => reply.code(['queued', 'running'].includes(result.job?.status) ? 202 : 200).send(result);
  app.get('/api/dining', async () => dining.state());
  app.post('/api/dining/preferences', async request => dining.setPreferences(parse(preferences, request.body)));
  app.post('/api/dining/location', async request => dining.setLocation(parse(location, request.body)));
  app.post('/api/dining/location/clear', async request => { parse(z.object({}).strict(), request.body ?? {}); return dining.clearLocation(); });
  app.post('/api/dining/recommendations', async (request, reply) => {
    const body = parse(z.object({ requestId: id }).strict(), request.body);
    return sendJob(reply, dining.enqueue(body.requestId));
  });
  app.get('/api/dining/requests/:id', async request => dining.request(parse(id, request.params.id)));
  app.get('/api/dining/recommendations/:id', async request => ({ card: dining.card(parse(id, request.params.id)) }));
  app.post('/api/dining/recommendations/:id/swap', async (request, reply) => {
    const body = parse(action, request.body);
    return sendJob(reply, dining.enqueue(body.requestId, { type: 'swap', cardId: parse(id, request.params.id), expectedVersion: body.expectedVersion }));
  });
  for (const [suffix, status] of [['dismiss', 'dismissed'], ['select', 'selected']]) {
    app.post(`/api/dining/recommendations/:id/${suffix}`, async request => dining.mutate(parse(id, request.params.id), parse(action, request.body), status));
  }
  app.get('/api/dining/recommendations/:id/navigation', async request => dining.navigation(parse(id, request.params.id)));
  app.get('/api/dining/deliveries', async () => ({ deliveries: dining.deliveries() }));
  app.post('/api/dining/deliveries/:id/ack', async request => { parse(z.object({}).strict(), request.body ?? {}); return dining.acknowledge(parse(id, request.params.id)); });
}
