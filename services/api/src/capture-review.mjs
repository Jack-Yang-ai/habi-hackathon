import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** A saved first photo is reviewed before it becomes a candidate meal. */
export class CaptureReviewer {
  constructor(store, provider, mediaDirectory) {
    this.store = store;
    this.provider = provider;
    this.mediaDirectory = mediaDirectory;
    this.pending = null;
    this.closed = false;
  }
  session(capture) { return capture.session_id ? this.store.get('captureSessions', capture.session_id) : null; }
  validate(capture, source = 'esp32') {
    const session = this.session(capture);
    if (!session) return null;
    if ((session.source ?? 'esp32') !== source)
      throw Object.assign(new Error('照片来源与采集会话不一致'), { statusCode: 409 });
    const window = session.windows.find(item => item.id === capture.capture_window_id);
    const count = this.store.list('captures').filter(item => item.capture_window_id === window?.id).length;
    if (!window || window.phase !== capture.capture_phase || count >= window.maxCaptures
        || (session.deviceId && session.deviceId !== capture.device_id))
      throw Object.assign(new Error('照片不属于有效的拍摄阶段或已超出预算'), { statusCode: 409 });
    return session;
  }
  register(capture) {
    const s = this.session(capture);
    if (!s) return;
    s.deviceId ??= capture.deviceId;
    s.imageUrl = capture.imageUrl;
    s.updatedAt = this.store.now();
    if (['waiting_photo', 'waiting_retry'].includes(s.status) && capture.capture_window_id === s.currentWindowId) {
      s.status = 'checking';
      this.store.put('reviewJobs', capture.id, { id: capture.id, captureId: capture.id, sessionId: s.id,
        state: 'queued', attempts: 0, createdAt: this.store.now() });
    } else if (s.foodDetected && s.status !== 'cancelled' && this.captures(s.id).length >= s.maxCaptures) s.status = 'complete';
    this.store.put('captureSessions', s.id, s);
  }
  captures(sessionId) { return this.store.list('captures').filter(item => item.session_id === sessionId).reverse(); }
  schedule() {
    if (this.closed || this.pending) return;
    this.pending = new Promise(resolve => setImmediate(resolve)).then(async () => {
      const jobs = this.store.list('reviewJobs').filter(item => ['queued', 'running'].includes(item.state)).reverse();
      for (const job of jobs) { if (this.closed) break; await this.run(job); }
    }).finally(() => {
      this.pending = null;
      if (!this.closed && this.store.list('reviewJobs').some(item => item.state === 'queued')) this.schedule();
    });
  }
  async drain() { while (this.pending) await this.pending; }
  async close() { this.closed = true; await this.drain(); }
  stop(s, status, reason) {
    s.status = status; s.reason = reason; s.updatedAt = this.store.now();
    this.store.put('captureSessions', s.id, s);
    if (this.store.settings().captureWindow?.sessionId === s.id) {
      this.store.settings({ captureWindow: null }); this.store.scene('idle', 1);
    }
  }
  async run(job) {
    const store = this.store;
    const s = store.get('captureSessions', job.sessionId);
    if (!s || (store.settings().paused && s.source !== 'phone') || s.status === 'cancelled') {
      store.put('reviewJobs', job.id, { ...job, state: 'skipped' }); return;
    }
    if (!this.provider.visionConfigured || job.attempts >= 2) {
      this.stop(s, 'failed', '首张照片已保存，识别服务暂不可用。');
      store.put('reviewJobs', job.id, { ...job, state: 'failed' }); return;
    }
    store.put('reviewJobs', job.id, { ...job, state: 'running', attempts: job.attempts + 1 });
    try {
      const capture = store.get('captures', job.captureId);
      const estimate = await this.provider.analyze(await readFile(path.join(this.mediaDirectory, capture.filename)), capture.mimeType);
      store.transaction(() => {
        const latest = store.get('captureSessions', s.id);
        if ((store.settings().paused && latest.source !== 'phone') || latest.status === 'cancelled') {
          store.put('reviewJobs', job.id, { ...job, state: 'skipped', attempts: job.attempts + 1 }); return;
        }
        latest.reviewAttempts = (latest.reviewAttempts ?? 0) + 1;
        latest.foodDetected = estimate.foodDetected;
        latest.updatedAt = store.now();
        const captures = this.captures(s.id);
        if (estimate.foodDetected) {
          const meal = this.saveMeal(latest, captures, estimate, capture);
          latest.mealId = meal.id;
          this.nextWindow(latest, 'food_found', Math.min(2, latest.maxCaptures - captures.length));
        } else if (['uncertain', 'unusable'].includes(estimate.imageQuality) && latest.reviewAttempts < 2 && captures.length < latest.maxCaptures) {
          latest.reason = '首张画面不清楚，再试一张就好。';
          this.nextWindow(latest, 'waiting_retry', 1);
        } else this.stop(latest, ['uncertain', 'unusable'].includes(estimate.imageQuality) ? 'uncertain' : 'no_food',
          ['uncertain', 'unusable'].includes(estimate.imageQuality) ? '画面仍不清楚，本次先结束。' : '这张没看到食物，本次先结束。');
        store.put('captureSessions', latest.id, latest);
        store.put('reviewJobs', job.id, { ...job, state: 'done', attempts: job.attempts + 1,
          foodDetected: estimate.foodDetected, imageQuality: estimate.imageQuality ?? 'unknown', completedAt: store.now() });
        store.event('capture.first-frame-reviewed', { captureId: capture.id, sessionId: latest.id,
          foodDetected: estimate.foodDetected, status: latest.status });
      });
    } catch {
      const latest = store.get('captureSessions', s.id);
      const cancelled = (store.settings().paused && latest.source !== 'phone') || latest.status === 'cancelled';
      if (!cancelled) this.stop(latest, 'failed', '照片已保存，识别暂时没有完成，本次先结束。');
      store.put('reviewJobs', job.id, { ...job, state: cancelled ? 'skipped' : 'failed', attempts: job.attempts + 1 });
    }
  }
  nextWindow(s, status, remaining) {
    const store = this.store;
    const current = store.settings().captureWindow;
    const canContinue = remaining > 0 && Date.parse(s.expiresAt) > store.clock().getTime()
      && current?.sessionId === s.id && !store.settings().paused;
    s.status = canContinue ? status : s.foodDetected ? 'complete' : 'uncertain';
    if (!canContinue) {
      if (current?.sessionId === s.id) store.settings({ captureWindow: null });
      return;
    }
    const id = `${s.id}-f${s.reviewAttempts}`;
    s.currentWindowId = id;
    s.windows.push({ id, phase: 'followup', maxCaptures: remaining });
    store.settings({ captureWindow: { ...current, id, phase: 'followup', phaseMaxCaptures: remaining } });
  }
  saveMeal(s, captures, estimate, analyzedCapture) {
    const store = this.store;
    const id = s.mealId ?? `meal_${createHash('sha256').update(s.id).digest('hex').slice(0, 32)}`;
    const first = captures[0];
    const old = store.get('meals', id);
    const meal = old ?? { id, version: 0, source: s.source ?? 'esp32', deviceId: s.deviceId,
      groupKey: `${s.deviceId}:${s.id}`, createdAt: first.receivedAt, capturedAt: first.capturedAt,
      imageUrl: analyzedCapture.imageUrl, portionFraction: null, note: '', confirmedAt: null, corrections: [] };
    meal.title = estimate.title;
    meal.status = meal.confirmedAt ? 'confirmed' : 'estimated';
    meal.version += 1; meal.updatedAt = store.now();
    meal.images = captures.map(item => ({ id: item.id, imageUrl: item.imageUrl, capturedAt: item.capturedAt, receivedAt: item.receivedAt }));
    meal.analysis = { status: 'ready', provider: 'model', modelName: this.provider.visionModel,
      foods: estimate.foods, calorieRange: estimate.calorieRange, macros: estimate.macros ?? null, uncertainties: estimate.uncertainties,
      analyzedAt: store.now(), error: null, captureIds: [analyzedCapture.id], imageQuality: estimate.imageQuality ?? 'unknown' };
    store.put('meals', id, meal);
    for (const capture of captures) store.put('captures', capture.id, { ...capture, mealId: id });
    store.scene('collecting', 10);
    return meal;
  }
}
