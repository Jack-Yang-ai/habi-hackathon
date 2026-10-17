// Only the user's explicit whole-meal proportions become a draft. This parser
// does not infer ingredient-level intake or let a conversation mutate a meal.
export function explicitPortion(message) {
  const text = message.trim();
  if (!text || /[?？]|吗|么|是否|是不是|要不要|能不能|为什么|怎么|多少/.test(text)) return null;
  if (/如果|假如|假设|打算|准备|计划|希望|想|可能|也许|应该|本来|不是|并非/.test(text)) return null;
  const [first, ...notes] = text.replace(/[。.!！\s]+$/, '').split(/[，,]/);
  const head = first.replace(/\s+/g, '').replace(/^(?:这一餐|这份餐|刚才那餐|这餐|这顿|这份)[：:]?/, '');
  const tail = notes.join('，');
  // "饭吃完了，菜吃一半" has no single safe whole-meal proportion.
  if (/一半|半份|四分之一|全部|全份|全吃|吃完|吃光|\d\s*[%％]|\d\s*\/\s*\d/.test(tail)) return null;
  if (/(?:没|未|不曾|没有)吃|其实|改成|说错|记错|口误|不对|否认|别人|朋友|同事|孩子|家人|妈妈|爸爸|我们|[他她]/.test(tail)) return null;
  if (/^(?:我)?(?:只)?(?:吃了|吃掉了)?(?:约|大约)?(?:一半|半份|50[%％]|1\/2)$/.test(head)) return 0.5;
  if (/^(?:我)?(?:只)?(?:吃了|吃掉了)?(?:约|大约)?(?:四分之一|25[%％]|1\/4)$/.test(head)) return 0.25;
  if (/^(?:我)?(?:(?:全部|全份|100[%％])(?:吃完了|吃了)?|(?:全|都)(?:吃完了|吃了)|吃完了|吃光了|全部吃完)$/.test(head))
    return /剩|留|没|未|不/.test(tail) ? null : 1;
  if (/^(?:我)?(?:没有吃|没吃|一口没吃|一口也没吃|0[%％])$/.test(head))
    return /吃|喝|尝/.test(tail) ? null : 0;
  return null;
}

export function mealDraft(meal, message) {
  if (!meal || meal.confirmedAt) return null;
  return {
    mealId: meal.id,
    expectedVersion: meal.version,
    portionFraction: explicitPortion(message),
    note: message,
  };
}
