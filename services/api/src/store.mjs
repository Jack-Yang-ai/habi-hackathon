import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(directory, clock = () => new Date()) {
    this.directory = directory;
    this.clock = clock;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'companion.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents (
        kind TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(kind, id)
      );`);
    this.readStatement = this.db.prepare('SELECT payload FROM documents WHERE kind=? AND id=?');
    this.listStatement = this.db.prepare('SELECT payload FROM documents WHERE kind=? ORDER BY created_at DESC, rowid DESC');
    this.listLimitStatement = this.db.prepare('SELECT payload FROM documents WHERE kind=? ORDER BY created_at DESC, rowid DESC LIMIT ?');
    // Rows whose document does not point at a meal: a capture the review rejected has no meal row,
    // and asking for it in SQL is what keeps it from being pushed out of a limited page.
    this.listUnlinkedStatement = this.db.prepare(`SELECT payload FROM documents WHERE kind=?
      AND json_extract(payload, '$.mealId') IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?`);
    this.countStatement = this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE kind=?');
    this.writeStatement = this.db.prepare(`INSERT INTO documents(kind,id,created_at,payload) VALUES(?,?,?,?)
      ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload`);
    // Starts at the number of stored documents so a restart still yields a revision nobody else holds.
    this.revision = this.db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
    if (!this.get('settings', 'app')) this.put('settings', 'app', {
      id: 'app', createdAt: this.now(), paused: true, captureIntervalSeconds: 30,
      scene: 'idle', sceneUntil: null, proactivePosts: true,
      captureMode: 'signals', captureWindow: null, lastTriggerAt: null, reminder: null,
    });
  }
  now() { return this.clock().toISOString(); }
  id(prefix) { return `${prefix}_${randomUUID()}`; }
  get(kind, id) {
    const row = this.readStatement.get(kind, id);
    return row ? JSON.parse(row.payload) : null;
  }
  list(kind, options = {}) {
    const { limit = null, pick = null, unlinked = false } = typeof options === 'number' ? { limit: options } : options;
    const rows = unlinked ? this.listUnlinkedStatement.all(kind, limit ?? -1)
      : limit === null ? this.listStatement.all(kind) : this.listLimitStatement.all(kind, limit);
    // Rows are whole documents, so a reader that only needs a few fields should ask for them here:
    // the alternative is parsing hundreds of kilobytes of evidence to throw almost all of it away.
    if (!pick) return rows.map(row => JSON.parse(row.payload));
    const fields = Array.isArray(pick) ? pick : [pick];
    return rows.map(row => {
      const value = JSON.parse(row.payload);
      const projected = {};
      for (const field of fields) projected[field] = value[field];
      return projected;
    });
  }
  put(kind, id, data) {
    this.writeStatement.run(kind, id, data.createdAt ?? this.now(), JSON.stringify(data));
    // A cheap monotonic change marker: readers use it to skip rebuilding a payload nobody changed.
    this.revision += 1;
    return data;
  }
  /** Monotonic change marker; see put(). */
  currentRevision() { return this.revision; }
  count(kind) { return this.countStatement.get(kind).n; }
  delete(kind, id) {
    this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind, id);
    this.revision += 1;
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  settings(patch) {
    const current = this.get('settings', 'app');
    return patch ? this.put('settings', 'app', { ...current, ...patch }) : current;
  }
  scene(scene, seconds = 12) {
    this.settings({ scene, sceneUntil: new Date(this.clock().getTime() + seconds * 1000).toISOString() });
  }
  event(type, references = {}) {
    const event = { id: this.id('event'), type, ...references, createdAt: this.now() };
    return this.put('events', event.id, event);
  }
  updatePortion(id, portionFraction, note = '', expectedVersion) {
    return this.transaction(() => {
      const meal = this.get('meals', id);
      if (!meal) throw Object.assign(new Error('没有找到这餐记录'), { statusCode: 404 });
      if (expectedVersion !== undefined && meal.version !== expectedVersion)
        throw Object.assign(new Error('这餐刚刚有更新，请刷新后再确认'), { statusCode: 409 });
      meal.portionFraction = portionFraction;
      meal.note = note;
      meal.corrections.push({ portionFraction, note, createdAt: this.now() });
      meal.version += 1;
      meal.updatedAt = this.now();
      this.put('meals', id, meal);
      const event = this.event('meal.portion-corrected', { mealId: id, portionFraction });
      this.scene('collecting');
      return { meal, event };
    });
  }
  confirmMeal(id, expectedVersion, correction = null) {
    return this.transaction(() => {
      const meal = this.get('meals', id);
      if (!meal) throw Object.assign(new Error('没有找到这餐记录'), { statusCode: 404 });
      // Retry after a lost response must not create a second post or event.
      if (meal.confirmedAt) {
        if (correction && (meal.portionFraction !== correction.portionFraction || meal.note !== correction.note))
          throw Object.assign(new Error('这餐已经确认，新的补充请在记录中修改'), { statusCode: 409 });
        return { meal, post: this.get('posts', `meal-confirmed-${id}`), duplicate: true };
      }
      if (expectedVersion !== undefined && meal.version !== expectedVersion)
        throw Object.assign(new Error('这餐刚刚有更新，请刷新后再确认'), { statusCode: 409 });
      if (correction) {
        meal.portionFraction = correction.portionFraction;
        meal.note = correction.note;
        meal.corrections.push({ ...correction, createdAt: this.now() });
        this.event('meal.portion-corrected', { mealId: id, portionFraction: correction.portionFraction });
      }
      if (meal.portionFraction === null) throw Object.assign(new Error('请先确认这餐实际吃了多少'), { statusCode: 400 });
      meal.status = 'confirmed';
      meal.confirmedAt = this.now();
      meal.updatedAt = this.now();
      meal.version += 1;
      this.put('meals', id, meal);
      const event = this.event('meal.confirmed', { mealId: id, portionFraction: meal.portionFraction });
      const post = {
        id: `meal-confirmed-${id}`, kind: 'shared-experience',
        body: meal.portionFraction === 0
          ? '这份食物你没有吃，我已经把它记清楚了。谢谢你告诉我。'
          : '这一餐记好了，你确认过的食量也一起收进记录。今天的小相册又添了一页。',
        createdAt: this.now(), mealId: id, sourceEventIds: [event.id], replies: [],
      };
      this.put('posts', post.id, post);
      this.scene('collecting', 15);
      return { meal, post, duplicate: false };
    });
  }
  ensureVirtualPost() {
    const settings = this.settings();
    if (!settings.proactivePosts) return;
    const last = this.list('posts').find(post => post.kind === 'virtual-life');
    if (last && this.clock().getTime() - Date.parse(last.createdAt) < 24 * 3600_000) return;
    const day = this.now().slice(0, 10);
    const id = `little-room-${day}`;
    if (this.get('posts', id)) return;
    this.put('posts', id, {
      id, kind: 'virtual-life', body: '我在小屋里给植物浇了水，又给你留了一个靠窗的位置。你想说话的时候，我在这里。',
      createdAt: this.now(), mealId: null, sourceEventIds: [], replies: [],
    });
    if (!settings.sceneUntil || Date.parse(settings.sceneUntil) <= this.clock().getTime()) this.scene('watering', 10);
  }
  close() { this.db.close(); }
}

export function mealView(meal) {
  const range = meal.analysis?.calorieRange;
  const macros = meal.analysis?.macros;
  const portion = meal.portionFraction;
  return {
    ...meal, captureCount: meal.images.length,
    analysis: meal.analysis ? { ...meal.analysis, macros: macros ?? null } : meal.analysis,
    consumedMacros: macros && portion !== null
      ? { proteinG: Math.round(macros.proteinG * portion), carbsG: Math.round(macros.carbsG * portion), fatG: Math.round(macros.fatG * portion) }
      : null,
    consumedCalorieRange: range && meal.portionFraction !== null
      ? { min: Math.round(range.min * meal.portionFraction), max: Math.round(range.max * meal.portionFraction) }
      : null,
  };
}
