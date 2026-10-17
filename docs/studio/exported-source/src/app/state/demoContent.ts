/* =============================================================================
 * 演示模式的内容（**只在演示模式里使用**）
 *
 * 正常模式下这些内容一个都不会出现：没有真实记录就是空态，没有模型就是「尚未估算」。
 * 演示模式由用户在「变化」页显式打开，打开后全局会挂一条醒目的演示标记，
 * 且每张卡片都带「演示」徽标——不会和真实记录混在一起。
 *
 * 演示里的照片不是外链图片：`DEMO_IMAGE_PREFIX` 开头的地址由本地 SVG 插画渲染
 * （见 components/meals/DemoMealIllustration.tsx），不联网。
 * ========================================================================== */

import type { MealEstimate } from '@/shared/api/companionApi'

/** 演示照片的地址前缀：状态层用它标记"这张图来自演示插画" */
export const DEMO_IMAGE_PREFIX = 'demo://'

export function isDemoImage(imageUrl: string): boolean {
  return imageUrl.startsWith(DEMO_IMAGE_PREFIX)
}

/**
 * 演示里那份午餐的 AI 估算。
 *
 * 模型标识如实写明是演示样例，不当成真实结果；**热量恒为 null** ——
 * 平台没有内置的图片理解通道（见 README「这一版还没有做的事」），所以演示里也不编一个
 * 看起来合理的千卡数，界面会照实显示「热量未提供」。等真实模型接上再由服务端给值。
 */
export const DEMO_ESTIMATE: Omit<MealEstimate, 'createdAt'> = {
  model: '演示样例 · 非真实模型输出',
  summary: '看起来是一碗米饭配清炒青菜和煎蛋',
  kcal: null,
  items: ['米饭', '清炒青菜', '煎蛋'],
}

/** 用户确认后，小伴发布的那条动态。basis 必须是事实，不能凭空抒情 */
export function demoPostAfterConfirm(portionLabel: string, capturedAt: string): { action: 'collecting'; text: string; basis: string } {
  const time = new Date(capturedAt)
  const hhmm = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
  return {
    action: 'collecting',
    text: '照片我收进木盒里了。你说这一份吃了一半，那就记一半，不用凑整。',
    basis: `来自 ${hhmm} 的那张照片 · 你确认的份量是「${portionLabel}」`,
  }
}

/** 演示模式下小伴的回应。语气克制、不催促、不评价吃多吃少 */
export const DEMO_CHAT_REPLIES = [
  '嗯，我在的。窗边今天有太阳，我把薄荷挪过去了一点。',
  '好，我记下了。不用急着说清楚，想起什么再讲。',
  '我在听。今天有好好吃饭吗——不回答也没关系。',
  '那我把这条收起来了。你随时回来，我都在小屋里。',
]
