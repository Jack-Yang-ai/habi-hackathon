import { createHash } from 'node:crypto';
import { AmapProvider, diningError, distanceMeters, navigationLinks } from './amap.mjs';

const LOCATION_TTL = 5 * 60000, CARD_TTL = 30 * 60000;
const defaults = { proactiveEnabled: false, mealTimeEnabled: false, style: 'balanced', radiusMeters: 1500,
  maxCostYuan: null, excludedKeywords: [], mealTimes: { lunch: '11:20', dinner: '17:20' }, version: 0, updatedAt: null };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = job => ['queued', 'running'].includes(job.status);
const active = card => card && ['active', 'selected'].includes(card.status);
const safeError = error => ({ code: error.code?.startsWith('AMAP_') || error.code?.startsWith('DINING_') ? error.code : 'DINING_FAILED',
  message: error.code?.startsWith('AMAP_') || error.code?.startsWith('DINING_') ? error.message : '餐厅推荐暂时失败，请稍后重试' });

export function mealContext(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric',
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(item => [item.type, item.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`, minute = Number(parts.hour) * 60 + Number(parts.minute);
  const slot = minute >= 300 && minute < 600 ? 'breakfast' : minute >= 600 && minute < 900 ? 'lunch'
    : minute >= 900 && minute < 1380 ? 'dinner' : 'late';
  return { day, minute, slot, key: `${day}:${slot}` };
}
export function openingState(hours, now) {
  if (!hours) return 'unknown';
  if (/^(?:24小时|全天|00:00\s*[-~至]\s*24:00)$/.test(hours.trim())) return 'within_hours';
  const ranges = [...hours.matchAll(/(\d{1,2}):(\d{2})\s*[-~至]\s*(\d{1,2}):(\d{2})/g)];
  if (!ranges.length || hours.replace(/\d{1,2}:\d{2}\s*[-~至]\s*\d{1,2}:\d{2}/g, '').replace(/[\s,，;；/、]/g, '')) return 'unknown';
  const minute = mealContext(now).minute;
  let inside = false;
  for (const range of ranges) {
    const [sh, sm, eh, em] = range.slice(1).map(Number);
    if (sh > 23 || sm > 59 || eh > 24 || em > 59 || (eh === 24 && em !== 0)) return 'unknown';
    const start = sh * 60 + sm, end = eh * 60 + em;
    if (start === end) return 'unknown';
    if (start < end ? minute >= start && minute < end : minute >= start || minute < end) inside = true;
  }
  return inside ? 'within_hours' : 'outside_hours';
}
function cue(poi, style) {
  const pattern = style === 'plant-forward' ? /蔬食|素食|素菜|轻食|沙拉/ : /蒸菜|蒸食|清蒸|轻食|沙拉|健康餐|清汤|粗粮|杂粮|蔬食|素食/;
  const tag = poi.tags.find(value => pattern.test(value));
  if (tag) return { source: 'amap', field: 'business.tag', text: `店铺标签含「${tag.slice(0, 30)}」` };
  const match = poi.name.match(pattern);
  return match ? { source: 'amap', field: 'name', text: `店名含「${match[0]}」，可进一步了解菜品` } : null;
}
function rank(candidates, preferences, now) {
  return candidates.filter(poi => poi.straightDistanceMeters <= preferences.radiusMeters
    && openingState(poi.openingHoursToday, now) !== 'outside_hours' && cue(poi, preferences.style)
    && (preferences.maxCostYuan === null || (poi.costYuan !== null && poi.costYuan <= preferences.maxCostYuan))
    && !preferences.excludedKeywords.some(word => `${poi.name} ${poi.type} ${poi.tags.join(' ')}`.toLowerCase().includes(word.toLowerCase())))
    .sort((a, b) => {
      const score = poi => (cue(poi, preferences.style)?.field === 'business.tag' ? 100 : 0)
        + (openingState(poi.openingHoursToday, now) === 'within_hours' ? 30 : 0) - poi.straightDistanceMeters / 100;
      return score(b) - score(a) || a.id.localeCompare(b.id);
    });
}

/** Recommendation gates are stricter than the low-cost first-photo probe. */
export function diningIntent(input, classification, now) {
  const age = now.getTime() - Date.parse(input.observedAt);
  if (!Number.isFinite(age) || age > 120000 || age < -10000 || input.speaker !== 'self'
      || input.sourceContext !== 'user-conversation' || (input.asrEvidence && (!input.asrEvidence.speechVadVerified
        || input.asrEvidence.timeSource === 'synthetic_fixture'))) return { action: 'ignore' };
  const text = input.text;
  if (/不要.*推荐|别.*推荐|不用.*推荐|这餐.*不.*推荐/.test(text)) return { action: 'close', reason: 'user_declined' };
  if (['eating_now', 'finished', 'declined'].includes(classification.stage)) return { action: 'close', reason: 'meal_started_or_finished' };
  if (classification.hardVeto || /明天|后天|下周|昨天|上次|如果|假如|比如|翻译|他说|她说|主播|台词|这句话/.test(text)) return { action: 'ignore' };
  if (/已经?(?:选好|订好|定好).*?(?:店|餐厅|饭店)|(?:在家吃|吃外卖|不出门吃)/.test(text)) return { action: 'close', reason: 'meal_already_decided' };
  const explicit = /吃什么|去哪[里儿]?吃|哪[家里].*(?:餐厅|饭店|吃)|(?:推荐|帮我找|找一家|找个|有没有|哪里有).*(?:餐厅|饭店|轻食|健康餐|清淡|吃的|吃饭)|(?:餐厅|饭店).*(?:推荐|哪家)/.test(text)
    || /^(?:(?:habi|哈比)[，,\s]*)?(?:附近|周边)(?:的)?(?:健康|清淡|轻食)?(?:餐厅|饭店)[？?。.!！\s]*$/i.test(text.trim());
  if (explicit) return { action: 'request', source: 'explicit_request', explicit: true };
  if (classification.stage === 'start_soon' && ['explicit_local_pattern', 'accepted_recent_invitation', 'jev_unavailable_local_fallback'].includes(classification.reason))
    return { action: 'request', source: 'meal_intent', explicit: false };
  return { action: 'ignore' };
}

export class DiningService {
  constructor(store, options = {}) {
    this.store = store;
    this.provider = options.provider ?? new AmapProvider(options.env, options.fetcher);
    this.running = null;
    this.controller = null;
    this.closed = false;
    if (!store.get('diningSettings', 'self')) store.put('diningSettings', 'self', { ...defaults, id: 'self' });
    if (!store.get('diningState', 'self')) store.put('diningState', 'self', { id: 'self', generation: 0, cardId: null, lastJobId: null });
    for (const job of store.list('diningJobs').filter(item => item.status === 'running')) {
      store.put('diningJobs', job.id, { ...job, status: job.attempts < 2 ? 'queued' : 'failed',
        error: job.attempts < 2 ? null : { code: 'DINING_INTERRUPTED', message: '上次餐厅查询中断，请重新请求' }, updatedAt: store.now() });
    }
    this.timer = options.scheduler === false ? null : setInterval(() => { this.tick(); }, 60000);
    this.timer?.unref();
    this.schedule();
  }
  preferences() { const { id, ...value } = this.store.get('diningSettings', 'self'); return value; }
  internal() { return this.store.get('diningState', 'self'); }
  locationStatus(location = this.store.get('diningLocation', 'latest')) {
    if (!location) return { status: 'missing', observedAt: null, accuracyMeters: null };
    const age = this.store.clock().getTime() - Date.parse(location.observedAt);
    return { status: age < -10000 || age > LOCATION_TTL ? 'stale' : location.accuracyMeters > 200 ? 'inaccurate' : 'fresh',
      observedAt: location.observedAt, accuracyMeters: location.accuracyMeters, coordinateSystem: location.coordinateSystem };
  }
  requireLocation() {
    if (this.locationStatus().status !== 'fresh') throw diningError('DINING_LOCATION_REQUIRED', '请先更新五分钟内、精度不超过 200 米的位置');
    return this.store.get('diningLocation', 'latest');
  }
  requireProvider() { if (!this.provider.configured) throw diningError('AMAP_NOT_CONFIGURED', '请先在服务端配置高德 Web 服务 Key', 503); }
  setPreferences(patch) {
    const old = this.preferences();
    const next = { ...old, ...patch, mealTimes: { ...old.mealTimes, ...patch.mealTimes } };
    if (hash({ ...next, version: 0, updatedAt: null }) !== hash({ ...old, version: 0, updatedAt: null })) {
      this.invalidate('preferences_changed');
      this.store.put('diningSettings', 'self', { ...next, id: 'self', version: old.version + 1, updatedAt: this.store.now() });
    }
    return this.state();
  }
  setLocation(value) {
    const age = this.store.clock().getTime() - Date.parse(value.observedAt);
    if (age > LOCATION_TTL || age < -10000) throw diningError('DINING_INVALID_LOCATION_TIME', '位置已过期或时间不正确', 400);
    const old = this.store.get('diningLocation', 'latest');
    if (old && Date.parse(value.observedAt) < Date.parse(old.observedAt)) throw diningError('DINING_OLDER_LOCATION', '不能用旧位置覆盖较新的位置');
    if (old?.observedAt === value.observedAt) {
      const { id, createdAt, ...previous } = old;
      if (hash(previous) !== hash(value)) throw diningError('DINING_LOCATION_CONFLICT', '同一时间的位置内容不一致');
      return { duplicate: true, location: this.locationStatus() };
    }
    if (old && (old.coordinateSystem !== value.coordinateSystem || distanceMeters(old, value) > 500 || value.accuracyMeters > 200)) this.invalidate('location_changed');
    this.store.put('diningLocation', 'latest', { ...value, id: 'latest', createdAt: this.store.now() });
    this.schedule();
    return { duplicate: false, location: this.locationStatus() };
  }
  clearLocation() {
    this.invalidate('location_cleared');
    this.store.delete('diningLocation', 'latest');
    for (const card of this.store.list('diningCards')) this.store.put('diningCards', card.id, { ...card, origin: null, inputLocation: null });
    for (const job of this.store.list('diningJobs')) this.store.put('diningJobs', job.id, { ...job, inputLocation: null });
    return { location: this.locationStatus() };
  }
  closeDeliveries(cardId, reason) {
    for (const delivery of this.store.list('diningDeliveries').filter(item => item.cardId === cardId && item.status === 'pending'))
      this.store.put('diningDeliveries', delivery.id, { ...delivery, status: 'withdrawn', reason, updatedAt: this.store.now() });
  }
  closeCard(card, status, reason) {
    if (!active(card)) return;
    this.store.put('diningCards', card.id, { ...card, status, closedReason: reason, version: card.version + 1, updatedAt: this.store.now() });
    this.closeDeliveries(card.id, reason);
  }
  cancelJobs(reason) {
    for (const job of this.store.list('diningJobs').filter(pending)) this.store.put('diningJobs', job.id,
      { ...job, status: 'cancelled', inputLocation: null, error: { code: 'DINING_CANCELLED', message: reason }, updatedAt: this.store.now() });
    this.controller?.abort();
  }
  invalidate(reason) {
    this.cancelJobs(reason);
    const state = this.internal();
    this.closeCard(this.store.get('diningCards', state.cardId ?? ''), 'expired', reason);
    this.store.put('diningState', 'self', { ...state, generation: state.generation + 1 });
  }
  stopMeal(reason) {
    const meal = mealContext(this.store.clock());
    this.store.put('diningStops', meal.key, { id: meal.key, reason, createdAt: this.store.now() });
    this.invalidate(reason);
  }
  mealStarted(key) {
    if (this.store.list('meals').some(meal => meal.confirmedAt && meal.portionFraction > 0
        && mealContext(new Date(meal.capturedAt ?? meal.createdAt)).key === key)) return true;
    return this.store.list('captureSessions').some(session => session.foodDetected === true
      && this.store.clock().getTime() - Date.parse(session.updatedAt) < 2 * 3600000
      && mealContext(new Date(session.createdAt)).key === key);
  }
  mealBlocked(key) { return Boolean(this.store.get('diningStops', key)) || this.mealStarted(key); }
  refresh() {
    const card = this.store.get('diningCards', this.internal().cardId ?? '');
    const location = this.store.get('diningLocation', 'latest');
    if (active(card) && card.inputLocation && location && (location.coordinateSystem !== card.inputLocation.coordinateSystem
        || distanceMeters(location, card.inputLocation) > 500)) { this.closeCard(card, 'expired', 'location_changed'); return; }
    if (active(card) && (Date.parse(card.expiresAt) <= this.store.clock().getTime() || this.locationStatus().status !== 'fresh'))
      this.closeCard(card, 'expired', Date.parse(card.expiresAt) <= this.store.clock().getTime() ? 'expired' : 'location_stale');
    else if (active(card) && this.mealStarted(card.mealKey)) this.closeCard(card, 'expired', 'meal_started_or_finished');
  }
  cardView(card) {
    if (!card) return null;
    const { origin, inputLocation, candidates, seenPoiIds, preferences, ...view } = card;
    return { ...view, actions: { swapAvailable: card.status === 'active' && rank(candidates, preferences, this.store.clock()).some(poi => !seenPoiIds.includes(poi.id)),
      navigationAvailable: active(card), dismissAvailable: card.status === 'active' } };
  }
  jobView(job) {
    if (!job) return null;
    const { id, requestId, type, source, status, attempts, cardId, resultVersion, error, createdAt, updatedAt, expiresAt } = job;
    return { id, requestId, type, source, status, attempts, cardId, resultVersion: resultVersion ?? null, error, createdAt, updatedAt, expiresAt };
  }
  state() {
    this.refresh();
    const state = this.internal(), card = this.store.get('diningCards', state.cardId ?? '');
    return { schemaVersion: 1, now: this.store.now(), config: { provider: 'amap', configured: this.provider.configured,
      layout: 'single', timeZone: 'Asia/Shanghai', locationMaxAgeSeconds: 300, locationMaxAccuracyMeters: 200,
      cardMaxAgeSeconds: 1800, notificationTransport: 'outbox' }, preferences: this.preferences(), location: this.locationStatus(),
      card: active(card) ? this.cardView(card) : null, lastJob: this.jobView(this.store.get('diningJobs', state.lastJobId ?? '')) };
  }
  card(id) {
    this.refresh();
    const card = this.store.get('diningCards', id);
    if (!card) throw diningError('DINING_CARD_NOT_FOUND', '没有找到这张推荐卡', 404);
    return this.cardView(card);
  }
  request(id) {
    const saved = this.store.get('diningRequests', id);
    if (!saved) throw diningError('DINING_REQUEST_NOT_FOUND', '没有找到这次推荐请求', 404);
    this.refresh();
    const job = this.store.get('diningJobs', saved.jobId);
    return { job: this.jobView(job), card: job.cardId ? this.cardView(this.store.get('diningCards', job.cardId)) : null };
  }
  existingRequest(requestId, fingerprint) {
    if (this.store.get('diningActions', requestId)) throw diningError('DINING_REQUEST_CONFLICT', '请求 ID 已对应另一项操作');
    const old = this.store.get('diningRequests', requestId);
    if (!old) return null;
    if (old.fingerprint !== fingerprint) throw diningError('DINING_REQUEST_CONFLICT', '请求 ID 已对应另一项操作');
    return { ...this.request(requestId), duplicate: true };
  }
  enqueue(requestId, { type = 'recommend', source = 'explicit_request', cardId = null, expectedVersion = null } = {}) {
    const fingerprint = hash({ type, source, cardId, expectedVersion });
    const old = this.existingRequest(requestId, fingerprint);
    if (old) return old;
    this.requireProvider();
    const location = this.requireLocation(), preferences = this.preferences(), meal = mealContext(this.store.clock());
    this.refresh();
    if (source !== 'explicit_request') {
      if (!preferences.proactiveEnabled) return { skipped: true, reason: 'proactive_disabled' };
      if (this.mealBlocked(meal.key)) return { skipped: true, reason: 'meal_started_or_finished' };
      if (this.store.get('diningClaims', meal.key)) return { skipped: true, reason: 'already_recommended_this_meal' };
    }
    if (type === 'swap') {
      const card = this.store.get('diningCards', cardId);
      if (!card || card.status !== 'active' || this.internal().cardId !== cardId) throw diningError('DINING_CARD_INACTIVE', '这张推荐已失效，请重新获取');
      if (card.version !== expectedVersion) throw diningError('DINING_VERSION_CONFLICT', '推荐刚刚有更新，请刷新后重试');
      if (!rank(card.candidates, preferences, this.store.clock()).some(poi => !card.seenPoiIds.includes(poi.id))) throw diningError('DINING_NO_ALTERNATIVE', '当前没有其他符合条件的餐厅');
      if (this.store.list('diningJobs').some(job => pending(job) && job.cardId === cardId)) throw diningError('DINING_BUSY', '正在换一家，请稍候');
    }
    this.cancelJobs('newer_request');
    const state = this.internal();
    const job = { id: this.store.id('diningjob'), requestId, type, source, cardId, expectedVersion, mealKey: meal.key,
      status: 'queued', attempts: 0, generation: state.generation + 1, inputLocation: location, preferences,
      error: null, createdAt: this.store.now(), updatedAt: this.store.now(), expiresAt: new Date(this.store.clock().getTime() + 120000).toISOString() };
    this.store.transaction(() => {
      this.store.put('diningJobs', job.id, job);
      this.store.put('diningRequests', requestId, { id: requestId, fingerprint, jobId: job.id, createdAt: this.store.now() });
      this.store.put('diningState', 'self', { ...state, generation: job.generation, lastJobId: job.id });
      if (type === 'recommend') this.store.put('diningClaims', meal.key, { id: meal.key, jobId: job.id, createdAt: this.store.now() });
    });
    this.schedule();
    return { job: this.jobView(job), card: null, duplicate: false };
  }
  onSignal(input, classification, dryRun = true) {
    const intent = diningIntent(input, classification, this.store.clock());
    if (dryRun) return { ...intent, dryRun: true };
    if (intent.action === 'close') {
      if (this.store.get('diningClosedSignals', input.signalId)) return { ...intent, duplicate: true };
      return this.store.transaction(() => {
        this.stopMeal(intent.reason);
        this.store.put('diningClosedSignals', input.signalId, { id: input.signalId, createdAt: this.store.now() });
        return intent;
      });
    }
    if (intent.action !== 'request') return intent;
    if (!intent.explicit && !this.preferences().proactiveEnabled) return { action: 'skip', reason: 'proactive_disabled' };
    try { return { action: 'request', ...this.enqueue(`signal:${hash(input.signalId).slice(0, 40)}`, { source: intent.source }) }; }
    catch (error) { return { action: 'skip', error: safeError(error) }; }
  }
  tick() {
    if (this.closed) return;
    this.refresh();
    const preferences = this.preferences(), now = mealContext(this.store.clock());
    if (preferences.proactiveEnabled && preferences.mealTimeEnabled && this.provider.configured && this.locationStatus().status === 'fresh') {
      for (const [slot, time] of Object.entries(preferences.mealTimes)) {
        const [hour, minute] = time.split(':').map(Number), elapsed = now.minute - hour * 60 - minute;
        if (now.slot === slot && elapsed >= 0 && elapsed < 90) {
          try { this.enqueue(`time:${now.day}:${slot}`, { source: 'meal_time' }); } catch { /* A failed tick is visible through the job, never an unhandled timer rejection. */ }
        }
      }
    }
    this.schedule();
  }
  schedule() {
    if (this.closed || this.running) return;
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = null;
      if (!this.closed && this.store.list('diningJobs').some(job => job.status === 'queued')) this.schedule();
    });
  }
  async idle() {
    while (this.running) await this.running;
  }
  guard(job) {
    const latest = this.store.get('diningJobs', job.id);
    if (this.closed || !latest || !pending(latest) || this.internal().generation !== job.generation)
      throw diningError('DINING_CANCELLED', '推荐请求已取消或被更新');
    if (Date.parse(job.expiresAt ?? job.createdAt) <= this.store.clock().getTime())
      throw diningError('DINING_REQUEST_EXPIRED', '这次查询已经过期，请重新请求');
    const location = this.requireLocation();
    if (!job.inputLocation || location.coordinateSystem !== job.inputLocation.coordinateSystem || distanceMeters(location, job.inputLocation) > 500
        || this.preferences().version !== job.preferences.version) throw diningError('DINING_CONTEXT_CHANGED', '位置或偏好已有变化，请重新请求');
    if (this.mealStarted(job.mealKey) || (job.source !== 'explicit_request' && (!this.preferences().proactiveEnabled || this.mealBlocked(job.mealKey))))
      throw diningError('DINING_CANCELLED', '当前不再需要主动推荐');
    if (job.type === 'swap') {
      const card = this.store.get('diningCards', job.cardId);
      if (!card || card.status !== 'active' || card.version !== job.expectedVersion || Date.parse(card.expiresAt) <= this.store.clock().getTime())
        throw diningError('DINING_CARD_INACTIVE', '这张推荐已失效，请重新获取');
      if (!card.inputLocation || card.inputLocation.coordinateSystem !== location.coordinateSystem || distanceMeters(card.inputLocation, location) > 500)
        throw diningError('DINING_CONTEXT_CHANGED', '位置已有变化，请重新请求');
    }
  }
  async execute(job, signal) {
    this.guard(job);
    const previous = job.type === 'swap' ? this.store.get('diningCards', job.cardId) : null;
    const origin = previous?.origin ?? await this.provider.locate(job.inputLocation, signal);
    this.guard(job);
    const search = previous ? { candidates: previous.candidates, partial: previous.partialSearch }
      : await this.provider.search(origin, job.preferences, this.store.now(), signal);
    const seen = previous?.seenPoiIds ?? [];
    const choices = rank(search.candidates, job.preferences, this.store.clock()).filter(poi => !seen.includes(poi.id));
    let restaurant = null, detailUnavailable = false;
    // Bound upstream work even when multiple stale POIs disappeared or closed.
    for (const candidate of choices.slice(0, 5)) {
      this.guard(job);
      let detailed;
      try { detailed = await this.provider.detail(candidate, origin, this.store.now(), signal); }
      catch (error) {
        if (signal.aborted) throw error;
        detailed = candidate; detailUnavailable = true;
      }
      if (detailed && rank([detailed], job.preferences, this.store.clock()).length) { restaurant = detailed; break; }
    }
    this.guard(job);
    if (!restaurant) throw diningError(previous ? 'DINING_NO_ALTERNATIVE' : 'DINING_NO_MATCH', '附近暂未找到其他符合条件的餐厅');
    let walking;
    try { walking = await this.provider.walking(origin, restaurant, signal); }
    catch (error) { if (signal.aborted) throw error; walking = { status: 'unavailable', distanceMeters: null, durationSeconds: null, source: null }; }
    this.guard(job);
    const now = this.store.now(), reason = cue(restaurant, job.preferences.style);
    const card = { id: previous?.id ?? this.store.id('diningcard'), version: (previous?.version ?? 0) + 1,
      kind: 'restaurant_recommendation', layout: 'single', status: 'active', source: previous?.source ?? job.source,
      mealKey: previous?.mealKey ?? job.mealKey, createdAt: previous?.createdAt ?? now, updatedAt: now,
      expiresAt: previous?.expiresAt ?? new Date(this.store.clock().getTime() + CARD_TTL).toISOString(),
      title: '附近有个吃饭的选择', body: '结合你设置的偏好，找了一家可以进一步了解菜品的餐厅。',
      restaurant: { ...restaurant, walking, openingStatus: openingState(restaurant.openingHoursToday, this.store.clock()) },
      recommendation: { reasons: [reason, { source: 'amap', field: 'location', text: `直线距离约 ${restaurant.straightDistanceMeters} 米` }],
        orderingTips: job.preferences.style === 'plant-forward' ? ['可向商家询问蔬菜、主食与蛋白质食材的搭配。'] : ['可向商家询问少油少盐、酱汁分放和蔬菜搭配。'],
        uncertainties: ['店铺名称和标签只是推荐线索，菜品营养、油盐和过敏原未核实。',
          '忌口仅按已设置的排除关键词筛选，不能证明食材或交叉接触安全。',
          ...(restaurant.openingHoursToday ? ['营业状态按提供的时段判断，实时情况请向商家确认。'] : ['营业时间暂无信息，请向商家确认。']),
          ...(walking.status === 'unavailable' ? ['步行路线暂不可用，未估算步行时间。'] : []),
          ...(search.partial ? ['部分搜索请求未成功，备选餐厅可能不完整。'] : []),
          ...(detailUnavailable ? ['详情暂未刷新，当前使用本次周边搜索返回的信息。'] : [])], nutrition: null },
      origin, inputLocation: previous?.inputLocation ?? job.inputLocation, candidates: search.candidates, seenPoiIds: [...seen, restaurant.id],
      preferences: job.preferences, partialSearch: search.partial, closedReason: null };
    this.store.transaction(() => {
      if (!previous) this.closeCard(this.store.get('diningCards', this.internal().cardId ?? ''), 'superseded', 'new_recommendation');
      this.store.put('diningCards', card.id, card);
      this.store.put('diningState', 'self', { ...this.internal(), cardId: card.id });
      this.store.put('diningJobs', job.id, { ...job, status: 'succeeded', cardId: card.id, resultVersion: card.version,
        inputLocation: null, updatedAt: now });
      this.store.event(previous ? 'dining.card-swapped' : 'dining.card-created', { cardId: card.id, version: card.version, source: job.source });
      if (!previous && job.source !== 'explicit_request') {
        const delivery = { id: this.store.id('diningdelivery'), cardId: card.id, status: 'pending',
          type: 'restaurant_recommendation', title: 'Habi · 附近吃什么', body: `附近的「${restaurant.name}」可以看看。`,
          createdAt: now, updatedAt: now, expiresAt: card.expiresAt };
        this.store.put('diningDeliveries', delivery.id, delivery);
      }
    });
  }
  async drain() {
    while (!this.closed) {
      const job = this.store.list('diningJobs').reverse().find(item => item.status === 'queued');
      if (!job) return;
      const running = { ...job, status: 'running', attempts: job.attempts + 1, updatedAt: this.store.now() };
      this.store.put('diningJobs', job.id, running);
      this.controller = new AbortController();
      try { await this.execute(running, this.controller.signal); }
      catch (error) {
        const current = this.store.get('diningJobs', job.id);
        if (pending(current) && this.closed) this.store.put('diningJobs', job.id, { ...current, status: 'queued', error: null, updatedAt: this.store.now() });
        else if (pending(current)) this.store.put('diningJobs', job.id, { ...current,
          status: ['DINING_CANCELLED', 'DINING_REQUEST_EXPIRED'].includes(error.code) ? 'cancelled' : ['DINING_NO_MATCH', 'DINING_NO_ALTERNATIVE'].includes(error.code) ? 'skipped' : 'failed',
          error: safeError(error), inputLocation: null, updatedAt: this.store.now() });
      } finally { this.controller = null; }
    }
  }
  mutate(cardId, { requestId, expectedVersion }, status) {
    const fingerprint = hash({ cardId, expectedVersion, status });
    if (this.store.get('diningRequests', requestId)) throw diningError('DINING_REQUEST_CONFLICT', '请求 ID 已对应另一项操作');
    const previous = this.store.get('diningActions', requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw diningError('DINING_REQUEST_CONFLICT', '请求 ID 已对应另一项操作');
      return { ...previous.response, duplicate: true };
    }
    this.refresh();
    const card = this.store.get('diningCards', cardId);
    if (!card || card.status !== 'active' || this.internal().cardId !== cardId) throw diningError('DINING_CARD_INACTIVE', '这张推荐已失效，请重新获取');
    if (card.version !== expectedVersion) throw diningError('DINING_VERSION_CONFLICT', '推荐刚刚有更新，请刷新后重试');
    this.cancelJobs(status);
    const updated = { ...card, status, version: card.version + 1, updatedAt: this.store.now() };
    const response = { card: this.cardView(updated), duplicate: false };
    this.store.transaction(() => {
      this.store.put('diningCards', cardId, updated);
      this.store.put('diningStops', card.mealKey, { id: card.mealKey, reason: status, createdAt: this.store.now() });
      this.closeDeliveries(cardId, status);
      this.store.put('diningActions', requestId, { id: requestId, fingerprint, response, createdAt: this.store.now() });
      this.store.event(`dining.card-${status}`, { cardId });
    });
    return response;
  }
  navigation(cardId) {
    this.refresh();
    const card = this.store.get('diningCards', cardId);
    if (!active(card) || this.internal().cardId !== cardId || !card.origin) throw diningError('DINING_CARD_INACTIVE', '这张推荐已失效，请重新获取');
    return { cardId, version: card.version, restaurantName: card.restaurant.name, walking: card.restaurant.walking,
      ...navigationLinks(card.origin, card.restaurant) };
  }
  deliveries() {
    this.refresh();
    return this.store.list('diningDeliveries').filter(item => item.status === 'pending');
  }
  acknowledge(id) {
    this.refresh();
    const delivery = this.store.get('diningDeliveries', id);
    if (!delivery) throw diningError('DINING_DELIVERY_NOT_FOUND', '没有找到这条提醒', 404);
    if (delivery.status === 'pending') this.store.put('diningDeliveries', id, { ...delivery, status: 'acknowledged', updatedAt: this.store.now() });
    return { delivery: this.store.get('diningDeliveries', id), duplicate: delivery.status === 'acknowledged' };
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.controller?.abort();
    await this.idle();
  }
}
