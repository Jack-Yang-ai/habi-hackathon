import { useEffect, useRef, useState } from 'react'
import type { Scene } from './model'

// Expression frames are derived from the user-supplied front artwork by tools/habi-avatar.py.
type Face = 'open' | 'closed' | 'look-l' | 'look-r' | 'look-up' | 'happy'
const faces: Face[] = ['open', 'closed', 'look-l', 'look-r', 'look-up', 'happy']
const frame = (face: Face) => `/habi/habi-${face}.webp`

export const sceneLabel: Record<Scene, string> = {
  idle: '在这里', received: '收好了一张照片', watering: '在陪着你', resting: '在休息', chatting: '在听你说', watching: '在留意这一餐',
}

function reducedMotion() { return matchMedia('(prefers-reduced-motion: reduce)').matches }

/**
 * Small living Habi: blinks, glances, tilts toward the conversation and reacts to scene changes.
 * `cue` bumps whenever something new appears so Habi can look at it.
 */
export function Habi({ scene = 'idle', size = 44, cue = 0, thinking = false }: { scene?: Scene; size?: number; cue?: number; thinking?: boolean }) {
  const [face, setFace] = useState<Face>('open')
  const [visibleFace, setVisibleFace] = useState<Face>(face)
  const readyFaces = useRef(new Set<Face>())
  const targetFace = useRef(face)
  targetFace.current = face
  const mounted = useRef(false)
  const [react, setReact] = useState(false)
  const base = useRef<Face>('open')
  base.current = scene === 'resting' ? 'closed' : thinking ? 'look-up' : 'open'

  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (readyFaces.current.has(face)) setVisibleFace(face)
  }, [face])
  async function decodeFrame(item: Face, image: HTMLImageElement) {
    // decode() can reject for a frame that already loaded; a loaded bitmap is still usable.
    try { await image.decode() } catch {}
    if (!mounted.current || !image.naturalWidth) return
    readyFaces.current.add(item)
    if (item === targetFace.current) setVisibleFace(item)
  }

  // Idle life: blink every few seconds, sometimes glance aside.
  useEffect(() => {
    if (reducedMotion()) { setFace(base.current); return }
    let timer = 0
    let restore = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        if (base.current === 'closed') { schedule(); return }
        const glance = Math.random() < .22
        setFace(glance ? (Math.random() < .5 ? 'look-l' : 'look-r') : 'closed')
        restore = window.setTimeout(() => { setFace(base.current); schedule() }, glance ? 900 : 140)
      }, 2600 + Math.random() * 3200)
    }
    setFace(base.current)
    schedule()
    return () => { window.clearTimeout(timer); window.clearTimeout(restore) }
  }, [scene, thinking])

  // A new photo is a small happy moment; a new message makes Habi look over.
  useEffect(() => {
    if (cue === 0 || reducedMotion()) return
    setReact(true)
    setFace(scene === 'received' ? 'happy' : 'look-r')
    const timer = window.setTimeout(() => { setFace(base.current); setReact(false) }, scene === 'received' ? 1500 : 1100)
    return () => window.clearTimeout(timer)
  }, [cue])
  useEffect(() => {
    if (scene !== 'received' || reducedMotion()) return
    setFace('happy'); setReact(true)
    const timer = window.setTimeout(() => { setFace(base.current); setReact(false) }, 1600)
    return () => window.clearTimeout(timer)
  }, [scene])

  return <span className={`habi habi-${scene} ${react ? 'habi-react' : ''} ${thinking ? 'habi-thinking' : ''}`} style={{ '--habi-size': `${size}px` } as React.CSSProperties} role="img" aria-label={`Habi${sceneLabel[scene]}`}>
    <span className="habi-glow" aria-hidden="true"/>
    <span className="habi-body" aria-hidden="true">
      {faces.map(item => <img key={item} src={frame(item)} alt="" decoding="async" draggable={false} onLoad={event => void decodeFrame(item, event.currentTarget)} className={item === visibleFace ? 'on' : ''}/>)}
    </span>
  </span>
}
