import type { ViewState } from './model'

export type SignalCard = {
  kind: 'window' | 'reminder'
  label: string
  badge?: string
  key: string
  title: string
  body: string
  meta: string
  expiresAtMs: number
}
export type SignalPresentation = { status: string; detail: string; card: SignalCard | null }

export function estimatedServerNow(state: ViewState) {
  return state.serverNowMs + Math.max(0, Date.now() - state.receivedAtMs)
}

/** A context decision is an acquisition request, never proof of a meal. */
export function signalPresentation(state: ViewState): SignalPresentation {
  if (state.paused) return { status: '已暂停识别', detail: '自动拍照与识别已暂停，由你决定何时重新开启。', card: null }
  const now = estimatedServerNow(state)
  const window = state.captureWindow
  const review = state.captureReview && Date.parse(state.captureReview.expiresAt) > now ? state.captureReview : null
  if (review?.status === 'checking') {
    return { status: '首图复核中', detail: '正在检查画面里是否有食物，再决定是否补充视角。',
      card: { kind: 'window', label: '首图复核中', badge: '复核中', key: `review:${review.sessionId}`,
        title: 'Habi在看看这张照片', body: '正在通过 Step 视觉检查画面里是否有食物，复核后再决定要不要补拍。',
        meta: '首图已收到 · 复核期间不补拍', expiresAtMs: Date.parse(review.expiresAt) },
    }
  }
  if (window && window.remaining > 0 && Date.parse(window.expiresAt) > now) {
    const waiting = state.cameraConnected ? '等待照片到达' : '等待相机连接'
    const retry = review?.status === 'waiting_retry'
    if (retry || window.phase === 'probe') return {
      status: retry ? '补一张复核' : '等待首张照片',
      detail: retry ? `首图尚不能确认，最多重试一张；${waiting}。` : `先取一张送 Step 视觉检查；${waiting}。`,
      card: { kind: 'window', label: retry ? '补一张复核' : '首张取景', badge: retry ? '再看一次' : '先取一张',
        key: `window:${window.id}`, title: retry ? '补一张，再看看' : '先看一张，再决定',
        body: retry ? '首图还不能确认，这次只补一张再看。' : '收到用餐相关线索，先拍一张送 Step 视觉，检查画面里是否有食物。',
        meta: `${retry ? '最多重试 1 张' : '仅先取 1 张'} · ${waiting}`,
        expiresAtMs: Date.parse(window.expiresAt) },
    }
    if (window.phase === 'followup') return {
      status: '补充视角', detail: `已请求补充视角，本轮总计最多 ${window.maxCaptures} 张；实际食量仍由你确认。`,
      card: { kind: 'window', label: '补充视角', badge: '补充', key: `window:${window.id}`,
        title: '换个角度，多看一点',
        body: review?.foodDetected === true ? '首图中发现了食物，正在请求补充视角，方便你稍后确认。' : '正在请求补充视角，方便你稍后确认。',
        meta: `最多再补 ${Math.min(window.phaseMaxCaptures, window.remaining)} 张 · 本轮最多 ${window.maxCaptures} 张 · ${waiting}`,
        expiresAtMs: Date.parse(window.expiresAt) },
    }
    // A server still on the earlier contract has no probe/followup phase yet.
    return {
      status: state.cameraConnected ? '短时窗口中' : '等待相机',
      detail: `拍摄请求已发出，${waiting}。`,
      card: { kind: 'window', label: '短时取景', badge: '短时', key: `window:${window.id}`, title: 'Habi正帮你留意',
        body: '短时取景请求已发出，照片到达后再复核。', meta: waiting, expiresAtMs: Date.parse(window.expiresAt) },
    }
  }
  if (review?.status === 'food_found' || review?.status === 'complete') return { status: '视角已收好', detail: '照片中的食物还需你确认，尚未认定实际食量。', card: null }
  if (review?.status === 'no_food') return { status: '未见食物，已结束', detail: '这次取景没有生成餐食记录。', card: null }
  if (review?.status === 'uncertain') return { status: '首图未能确认', detail: '本次取景已停止，想继续时可手动补充照片。', card: null }
  if (review?.status === 'failed') return { status: '复核暂不可用', detail: '本次已停止补拍，稍后可以再试。', card: null }
  if (review?.status === 'cancelled') return { status: '本次已取消', detail: '取景与补拍已停止，等你准备好再继续。', card: null }
  const reminder = state.reminder
  const matchingSignal = reminder ? state.signals.find(signal => signal.signalId === reminder.signalId) : undefined
  const reminderExpiresAt = reminder ? Date.parse(reminder.expiresAt) : 0
  if (reminder && matchingSignal?.action === 'soft_reminder' && !matchingSignal.dryRun && reminderExpiresAt > now) {
    return { status: '有一句轻提醒', detail: '收到可能与用餐有关的线索，仍需要后续确认。',
      card: { kind: 'reminder', label: '用餐轻提醒', key: `reminder:${reminder.signalId}`, title: 'Habi留了一句话', body: reminder.body,
        meta: '线索还需确认 · 尚未开启拍摄窗口', expiresAtMs: reminderExpiresAt },
    }
  }
  const latest = state.signals[0]
  if (!latest) return { status: '等待信号', detail: state.captureMode === 'signals' ? '出现用餐线索时，先拍一张交给视觉复核。' : '按设备配置采集，用餐线索会单独判断。', card: null }
  if (latest.dryRun || latest.reason === 'test_fixture') return { status: '测试线索已忽略', detail: '验证信号不会开启真实拍摄或生成饮食记录。', card: null }
  if (latest.action === 'cancel') return { status: '本次已取消', detail: '已停止本次拍摄窗口，等你准备好再继续。', card: null }
  if (latest.action === 'capture_window') return { status: '本次窗口已结束', detail: '照片若已到达，可以去饮食页补充确认。', card: null }
  if (latest.stage === 'finished') return { status: '本次线索已结束', detail: '已经结束的用餐线索不会重新开启拍摄。', card: null }
  if (latest.action === 'ignore') return { status: '无须打扰', detail: '近期线索不需要开启拍摄，也不会生成饮食记录。', card: null }
  return { status: '等待新线索', detail: '继续安静观察，不把不确定的线索记作一餐。', card: null }
}
