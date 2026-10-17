import { useEffect, useState } from 'react'
import pattern from '../../../contracts/rear-display/habi.json'
import type { Scene } from './model'

type Frame = { durationMs: number; rowBitmasks: number[] }
type Sequence = { loop: boolean; frames: Frame[] }
const sequences: Record<string, Sequence> = pattern.scenes

/** The same 1-bit Habi frames are packaged in Android assets. This is a design preview. */
export function RearDisplay({ scene, compact = false }: { scene: Scene; compact?: boolean }) {
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [frameIndex, setFrameIndex] = useState(0)
  const sequence = sequences[pattern.sceneAliases[scene]] || sequences.idle
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    setFrameIndex(0)
    if (reducedMotion || sequence.frames.length < 2) return
    let index = 0
    let timer: number
    const tick = () => {
      if (index + 1 >= sequence.frames.length && !sequence.loop) return
      index = (index + 1) % sequence.frames.length
      setFrameIndex(index)
      timer = window.setTimeout(tick, sequence.frames[index].durationMs)
    }
    timer = window.setTimeout(tick, sequence.frames[0].durationMs)
    return () => window.clearTimeout(timer)
  }, [sequence, reducedMotion])
  const frame = sequence.frames[reducedMotion ? 0 : frameIndex] || sequence.frames[0]
  return <div className={`rear-hardware ${compact ? 'rear-compact' : ''}`}>
    <div className="rear-camera"><i/><i/></div>
    <div className={`dot-matrix dot-${scene}`} role="img" aria-label={`点阵背屏中 Habi ${scene === 'resting' ? '休息' : scene === 'received' ? '收照片' : '陪伴'}的设计预览`}>
      <svg viewBox={`0 0 ${pattern.width} ${pattern.height}`} aria-hidden="true">
        {frame.rowBitmasks.flatMap((row, y) => Array.from({ length: pattern.width }, (_, x) => <circle key={`${x}-${y}`} cx={x + .5} cy={y + .5} r=".28" className={row & (1 << (pattern.width - 1 - x)) ? 'pixel-on' : 'pixel-off'}/>))}
      </svg>
    </div>
    <div className="rear-hardware-caption">HABI · EVERY LITTLE DAY</div>
  </div>
}
