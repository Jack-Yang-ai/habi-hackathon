import { createHash } from 'node:crypto';

const mealWords = /吃|喝|饭|餐|饿|食物|零食|火锅|早餐|午餐|晚餐|食堂|外卖|便当/;
const nonCurrent = /明天|后天|下周|下个月|明早|明晚|下班后|等会儿|待会儿|过一会儿|假如|如果|假设|要是|以前|昨天|上次/;
const invitation = /要不要吃|要不要.*喝|一起吃|吃不吃|一起.*(?:午饭|晚饭|早饭)/;
const acceptance = /^(?:好(?:啊|呀|的)?|可以(?:啊)?|行(?:啊)?|走(?:吧)?|一起|去吧|我也去)[，,。！!\s]*(?:走吧|现在走|一起去)?[。！!\s]*$/;
// Preparation is sufficient for a probe. "Not eaten yet" is not a refusal.
const preparation = /我(?:们)?(?:现在|这就|马上)?(?:要|准备|打算)?(?:去)?吃(?:饭|午饭|晚饭|早饭|早餐|午餐|晚餐|点东西|零食)|(?:准备|打算|马上|这就)(?:现在|马上)?(?:去)?(?:吃|用餐|食堂|餐厅|饭店)|我(?:们)?(?:先)?去(?:食堂|餐厅|饭店)|开饭了/;

// Whole-utterance commands only: quotes, negation and future plans cannot match.
//
// SenseVoice mis-spells the wake word and the command in many ways on real recordings. The lists
// below are the observed spellings from this project plus the predictable neutral-tone homophones,
// and they are matched only as a complete utterance so "他说…" or "明天…" can never fire a camera.
const wakeAliases = ['habi', 'happy', '哈比', '哈皮', '哈哔', '哈必', '哈b', 'h皮', '他比', '海比', '还彼', '阿皮'];
const phoneCommandWords = ['记录', '纪录', '记路', '基录', '记陆', '之录', '之路'];
const boardCommandWords = ['看看', '看一眼', '看一下', '看下', '瞧瞧', '瞅瞅', '堪堪', '坎坎', '砍砍', '卡看', '看刊',
  '拍一张', '拍个照', '拍照', '拍下'];

function compactUtterance(text) {
  return text.replace(/[\s，,。.!！?？、：:；;、·~～]/gu, '').toLowerCase();
}

function isWholeUtterance(text, commandWords) {
  const compact = compactUtterance(text);
  const wake = wakeAliases.join('|');
  const commands = commandWords.join('|');
  return new RegExp(`^(?:${wake})(?:${commands})$`, 'u').test(compact);
}

/** 哈比记录 → the phone answers its own camera immediately. */
export function isPhoneCameraCommand(text) {
  return isWholeUtterance(text, phoneCommandWords);
}

/** 哈比看看 → ask the paired wearable camera for one frame. Same utterance, different device. */
export function isBoardCameraCommand(text) {
  return isWholeUtterance(text, boardCommandWords);
}

/** Context is an acquisition hint, never a claim that food was consumed. */
export class ContextTrigger {
  constructor(env = process.env, fetcher = fetch) {
    this.endpoint = env.JEV_URL ?? '';
    this.fetcher = fetcher;
    this.timeout = Math.max(1000, Math.min(60000, Number(env.JEV_TIMEOUT_MS) || 15000));
    if (this.endpoint) {
      const url = new URL(this.endpoint);
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
          || url.username || url.password || url.search || url.hash)
        throw new Error('JEV_URL must point to a local loopback decision service');
    }
  }
  async classify(input) {
    const text = input.text.trim();
    const base = { stage: 'uncertain', subject: input.speaker, source: 'local-rules', model: null,
      probability: null, margin: null, domainCalibrated: false, evidence: text, ingestionConfirmed: false };
    if (input.sourceContext === 'media')
      return { ...base, stage: 'unrelated', reason: 'media_or_other_person', hardVeto: true };
    if (input.sourceContext === 'test-fixture' || input.asrEvidence?.timeSource === 'synthetic_fixture')
      return { ...base, reason: 'test_fixture', hardVeto: true };
    if (input.asrEvidence && !input.asrEvidence.speechVadVerified)
      return { ...base, reason: 'unverified_speech_segment', hardVeto: true };
    if (input.speaker === 'other' && !(input.sourceContext === 'user-conversation' && invitation.test(text)))
      return { ...base, stage: 'unrelated', reason: 'media_or_other_person', hardVeto: true };
    if (isPhoneCameraCommand(text)) return { ...base, reason: 'explicit_camera_command' };
    if (isBoardCameraCommand(text)) return { ...base, reason: 'explicit_board_command' };
    if (/不吃了|不去吃|先不吃|取消.*吃饭|我不饿|不想吃|已经吃饱|(?:不是|并不|没有)(?:要|准备|打算).*吃/.test(text)
        || /(?:不|没有)(?:准备|打算).*(?:吃|用餐|食堂|餐厅|饭店)/.test(text)
        || (!invitation.test(text) && /不吃(?:饭|午饭|晚饭|早饭)|不要吃/.test(text)))
      return { ...base, stage: 'declined', reason: 'explicit_decline', hardVeto: true };
    if (nonCurrent.test(text))
      return { ...base, reason: 'non_current_or_hypothetical', hardVeto: true };
    if (/(?:比如|例如|举例|翻译|模拟|这句话|台词|他说|她说|主播说).*吃|吃药|玩吃鸡/.test(text))
      return { ...base, reason: 'quoted_or_non_meal_context', hardVeto: true };
    if (/刚吃完|吃完了|吃过了|已经吃了/.test(text)) return { ...base, stage: 'finished', reason: 'retrospective' };
    if (/[他她](?:们)?(?:现在|马上)?(?:要|准备|打算|去|在).*(?:吃|食堂|餐厅|饭店)/.test(text) && !/我也|一起/.test(text))
      return { ...base, subject: 'other', reason: 'third_party', hardVeto: true };
    const previous = (input.recentUtterances ?? []).slice(-2);
    const acceptedInvitation = input.speaker === 'self' && acceptance.test(text)
      && previous.some(value => invitation.test(value) && !nonCurrent.test(value));
    let ruleStage = 'uncertain';
    if (preparation.test(text) || /我正在吃|我在吃/.test(text))
      ruleStage = /正在吃|我在吃/.test(text) ? 'eating_now' : 'start_soon';
    else if (acceptedInvitation) ruleStage = 'start_soon';
    else if (invitation.test(text)) ruleStage = 'invited';
    if (/我.*吃.*(?:吗|么|？|\?)$/.test(text) && ruleStage === 'start_soon') ruleStage = 'uncertain';
    if (ruleStage === 'uncertain' && !mealWords.test(text) && !previous.some(value => mealWords.test(value)))
      return { ...base, stage: 'unrelated', reason: 'no_meal_context' };
    if (!this.endpoint && !input.localDecision) return { ...base, stage: ruleStage, reason: acceptedInvitation ? 'accepted_recent_invitation' : 'explicit_local_pattern' };
    try {
      let data;
      if (input.localDecision) {
        const local = input.localDecision;
        data = { model: local.model, runtime: local.runtime, modelSha256: local.modelSha256,
          results: [{ answers: [{ id: 'meal_stage', value: local.stage, top_probability: local.probability,
            margin: local.margin, distribution: local.distribution }] }], usage: { wall_ms: local.wallMs } };
      } else {
        const response = await this.fetcher(`${this.endpoint.replace(/\/$/, '')}/api/evaluate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state: { transcript: text, speaker: input.speaker, source: input.sourceContext,
            recent_utterances: input.recentUtterances ?? [], audio_events: input.audioEvents ?? [] }, questions: [{
            id: 'meal_stage', type: 'choice',
            question: '根据完整上下文，用户本人当前的用餐准备状态是什么？计划和邀请不是实际摄入，背景媒体不是本人行动。',
            options: {
              start_soon: '用户本人明确表示现在或马上准备吃东西，适合短时拍摄确认。',
              invited: '有人邀请吃东西，但尚未明确用户本人接受或开始。',
              eating_now: '上下文明确表示用户本人当前正在吃东西。',
              finished: '谈论已经吃完或过去的进食，当前不应开始拍摄。',
              declined: '用户明确拒绝、取消或停止吃东西。',
              unrelated: '只是在谈论食物、别人、未来安排、媒体或其他事情。',
              uncertain: '证据不足，无法确定用户本人现在是否准备吃东西。',
            },
          }] }), signal: AbortSignal.timeout(this.timeout), redirect: 'error',
        });
        if (!response.ok) throw new Error('decision_unavailable');
        data = await response.json();
      }
      const answer = data?.results?.[0]?.answers?.find(item => item.id === 'meal_stage');
      const allowed = ['start_soon', 'invited', 'eating_now', 'finished', 'declined', 'unrelated', 'uncertain'];
      if (!answer || !allowed.includes(answer.value) || !Number.isFinite(answer.top_probability) || !Number.isFinite(answer.margin)
          || answer.top_probability < 0 || answer.top_probability > 1 || answer.margin < 0 || answer.margin > 1)
        throw new Error('invalid_decision');
      // A released general decision head has no validated Chinese meal-domain
      // calibration. Explicit context rules remain authoritative; its actual
      // answer is retained as an advisory measurement, never hidden as success.
      const assessment = { stage: answer.value, probability: answer.top_probability, margin: answer.margin,
        distribution: answer.distribution, wallMs: data.usage?.wall_ms ?? null,
        execution: input.localDecision ? 'android-local' : 'host-local',
        runtime: data.runtime ?? null, modelSha256: data.modelSha256 ?? null };
      if (ruleStage !== 'uncertain') return { ...base, stage: ruleStage, model: data.model,
        reason: acceptedInvitation ? 'accepted_recent_invitation' : 'explicit_local_pattern', modelAssessment: assessment };
      return { ...base, stage: answer.value, source: String(data.model).startsWith('decider') ? 'decider' : 'agentjev', model: data.model,
        probability: answer.top_probability, margin: answer.margin,
        reason: 'uncalibrated_domain_decision', distribution: answer.distribution,
        modelWallMs: data.usage?.wall_ms ?? null, localPattern: ruleStage,
        execution: assessment.execution, runtime: assessment.runtime, modelSha256: assessment.modelSha256 };
    } catch {
      return { ...base, stage: ruleStage, reason: 'jev_unavailable_local_fallback' };
    }
  }
}

// cooldownMs is overridable so bench sessions can iterate without waiting out the real 5 minute
// window between probes; production always passes the default.
export function triggerPlan(classification, input, settings, now, cooldownMs = 5 * 60000) {
  const result = { stage: classification.stage, action: 'defer', reason: classification.reason,
    captureWindowSeconds: 0, captureIntervalSeconds: 15, maxCaptures: 3 };
  const age = now.getTime() - Date.parse(input.observedAt);
  if (!Number.isFinite(age) || age > 120000 || age < -10000) return { ...result, reason: 'stale_or_future_signal' };
  const selfContext = input.speaker === 'self' && input.sourceContext === 'user-conversation';
  if (classification.hardVeto) return { ...result, action: classification.stage === 'declined' && selfContext ? 'cancel' : 'ignore' };
  if (classification.stage === 'finished') return { ...result, action: selfContext ? 'cancel' : 'ignore', reason: 'already_finished' };
  if (settings.paused) return { ...result, reason: 'user_paused' };
  if (classification.reason === 'explicit_camera_command')
    return { ...result, action: 'phone_capture', reason: 'explicit_camera_command', maxCaptures: 1 };
  // An explicit "哈比看看" is a direct request for one wearable frame, so it skips the trigger
  // cooldown that exists to stop ambient clues from probing over and over.
  if (classification.reason === 'explicit_board_command')
    return { ...result, action: 'capture_window', reason: 'explicit_board_command', captureWindowSeconds: 45, maxCaptures: 1 };
  const possibleMeal = ['start_soon', 'eating_now', 'invited'].includes(classification.stage)
    || mealWords.test(input.text);
  if (!possibleMeal) return result;
  if (settings.lastTriggerAt && now.getTime() - Date.parse(settings.lastTriggerAt) < cooldownMs)
    return { ...result, reason: 'capture_cooldown' };
  // The user explicitly chose a low-cost first-photo probe. Ambiguous meal
  // intent may request ONE frame; only vision can unlock follow-up frames.
  return { ...result, action: 'capture_window', reason: selfContext ? 'near_term_self_context' : 'possible_meal_first_photo', captureWindowSeconds: 45 };
}

export function applyTrigger(store, classification, input, dryRun = true, cooldownMs = 5 * 60000) {
  const plan = triggerPlan(classification, input, store.settings(), store.clock(), cooldownMs);
  const output = { ...plan, classification, dryRun, receivedAt: store.now(), signalId: input.signalId,
    observedAt: input.observedAt, speaker: input.speaker, sourceContext: input.sourceContext,
    note: plan.action === 'phone_capture' ? '明确拍照口令，请手机拍一张；不代表已看到食物或实际进食。'
      : plan.reason === 'explicit_board_command' ? '明确口令，已请随身相机拍一张；不代表已看到食物或实际进食。'
      : '准备去吃饭即可成为采集线索；不代表已看到食物、实际进食或热量。' };
  const fingerprint = createHash('sha256').update(JSON.stringify({ text: input.text, speaker: input.speaker,
    sourceContext: input.sourceContext, observedAt: input.observedAt, recentUtterances: input.recentUtterances ?? [],
    audioEvents: input.audioEvents ?? [], asrEvidence: input.asrEvidence ?? null,
    localDecision: input.localDecision ?? null })).digest('hex');
  if (dryRun) return output;
  return store.transaction(() => {
    const old = store.get('signals', input.signalId);
    if (old) {
      if (old.fingerprint !== fingerprint) throw Object.assign(new Error('线索 ID 已对应另一条内容'), { statusCode: 409 });
      return { ...old, duplicate: true };
    }
    if (plan.action === 'cancel') {
      const sessionId = store.settings().lastCaptureSessionId;
      const session = sessionId ? store.get('captureSessions', sessionId) : null;
      if (session) store.put('captureSessions', session.id, { ...session, status: 'cancelled', updatedAt: store.now() });
      store.settings({ captureWindow: null, reminder: null });
      store.scene('idle', 1);
    }
    if (plan.action === 'capture_window') {
      const sessionId = `window-${createHash('sha256').update(input.signalId).digest('hex').slice(0, 32)}`;
      const windowId = `${sessionId}-p1`;
      const expiresAt = new Date(store.clock().getTime() + plan.captureWindowSeconds * 1000).toISOString();
      store.put('captureSessions', sessionId, { id: sessionId, sessionId, status: 'waiting_photo',
        reason: null, imageUrl: null, foodDetected: null, deviceId: null, mealId: null,
        createdAt: store.now(), updatedAt: store.now(), expiresAt, maxCaptures: plan.maxCaptures,
        currentWindowId: windowId, windows: [{ id: windowId, phase: 'probe', maxCaptures: 1 }], reviewAttempts: 0 });
      store.settings({ lastTriggerAt: store.now(),
        lastCaptureSessionId: sessionId,
        captureWindow: { id: windowId, phase: 'probe', sessionId, phaseMaxCaptures: 1, startedAt: store.now(),
          expiresAt,
          maxCaptures: plan.maxCaptures, captureIntervalSeconds: plan.captureIntervalSeconds, signalId: input.signalId },
        reminder: { body: '我先请随身相机看一张，看到食物再补充记录。随时可以暂停。', createdAt: store.now(),
          expiresAt: new Date(store.clock().getTime() + 120000).toISOString(), signalId: input.signalId },
      });
      store.scene('collecting', 15);
    } else if (plan.action === 'soft_reminder') {
      store.settings({ lastReminderAt: store.now(), reminder: { body: '听起来可能要吃东西了。需要我帮你记这一餐时，随时告诉我。', createdAt: store.now(),
        expiresAt: new Date(store.clock().getTime() + 120000).toISOString(), signalId: input.signalId } });
      store.scene('listening', 10);
    }
    const saved = { ...output, fingerprint, asrEvidence: input.asrEvidence ?? null,
      localDecision: input.localDecision ?? null, createdAt: store.now() };
    store.put('signals', input.signalId, saved);
    store.event('context.signal-evaluated', { signalId: input.signalId, action: plan.action, decisionSource: classification.source });
    return saved;
  });
}
