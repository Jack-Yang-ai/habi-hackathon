const alpha = color => {
  const parts = color.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 1]
  return parts.length > 3 ? parts[3] : 1
}
const parse = color => (color.match(/[\d.]+/g)?.slice(0, 3).map(Number) || [0, 0, 0])
const lum = rgb => {
  const [r, g, b] = rgb.map(value => { const v = value / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const over = (fg, bg) => { const a = alpha(fg); return parse(fg).map((value, index) => value * a + bg[index] * (1 - a)) }
const backdrop = node => {
  let layer = [22, 18, 15]
  const chain = []
  for (let current = node; current; current = current.parentElement) chain.push(current)
  for (const current of chain.reverse()) {
    const style = getComputedStyle(current)
    if (style.backgroundImage !== 'none' && style.backgroundImage.includes('gradient')) layer = [26, 21, 17]
    if (alpha(style.backgroundColor) > 0) layer = over(style.backgroundColor, layer)
  }
  return layer
}
const contrast = (fg, bg) => { const a = lum(parse(fg)), b = lum(bg); return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 }
const seen = new Set()
const text = []
for (const node of document.querySelectorAll('.app *, .sheet *')) {
  if (node.children.length || !node.textContent.trim()) continue
  const style = getComputedStyle(node)
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) < .5) continue
  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) continue
  const label = (node.className || node.tagName).toString().slice(0, 40)
  const value = contrast(style.color, backdrop(node))
  const rounded = Math.round(parseFloat(style.fontSize) || 16)
  const large = rounded >= 19 || (rounded >= 15 && Number(style.fontWeight) >= 600)
  const pass = value >= (large ? 3 : 4.5)
  const key = `${label}|${value}`
  if (seen.has(key)) continue
  seen.add(key)
  if (!pass) text.push({ label, text: node.textContent.trim().slice(0, 24), color: style.color, size: rounded, weight: style.fontWeight, ratio: value })
}
const small = []
for (const node of document.querySelectorAll('button, a, input, textarea, select, [role="radio"], [role="switch"], [role="tab"]')) {
  const rect = node.getBoundingClientRect()
  if (!rect.width || !rect.height) continue
  if (rect.height < 38 || rect.width < 38) small.push({ label: (node.className || node.tagName).toString().slice(0, 40), w: Math.round(rect.width), h: Math.round(rect.height), text: node.textContent.trim().slice(0, 16) })
}
const app = document.querySelector('.app')
const composer = document.querySelector('.composer')
const feed = document.querySelector('.feed')
const habi = document.querySelector('.habi')
const habiRect = habi?.getBoundingClientRect()
return {
  appWidth: app.clientWidth, appHeight: app.clientHeight,
  horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  feedOverflowX: feed ? feed.scrollWidth - feed.clientWidth : null,
  habi: habiRect ? { w: Math.round(habiRect.width), h: Math.round(habiRect.height), frame: document.querySelector('.habi-body img.on')?.getAttribute('src') } : null,
  composerBottomGap: composer ? Math.round(innerHeight - composer.getBoundingClientRect().bottom) : null,
  composerTop: composer ? Math.round(composer.getBoundingClientRect().top) : null,
  feedBottom: feed ? Math.round(feed.getBoundingClientRect().bottom) : null,
  contrastFailures: text,
  smallTargets: small,
}
