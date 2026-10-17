import { useEffect, useRef } from 'react'

import 'xgplayer/dist/index.min.css'

/** 播放器内核：按需导入 xgplayer，不负责页面导航或 App 方向。 */
export function VideoPlayer({ src, poster, className }: {
  src: string
  poster?: string
  className?: string
}) {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount || !src) return
    let cancelled = false
    let dispose: (() => void) | undefined
    void import('xgplayer').then(({ default: Player }) => {
      if (cancelled) return
      const player = new Player({
        el: mount,
        url: src,
        poster,
        width: '100%',
        height: '100%',
        playsinline: true,
        autoplay: false,
        lang: 'zh-cn',
        videoFillMode: 'contain',
        // 不让播放器接管页面级手势；进度条仍可拖动。
        disableGesture: true,
        // 页面负责方向与返回，禁用内建原生 / CSS 全屏和旋转插件。
        ignores: ['fullscreen', 'cssfullscreen'],
        cssFullscreen: false,
        rotate: false,
        commonStyle: { progressColor: 'rgb(var(--primary))', playedColor: 'rgb(var(--primary))' },
      })
      dispose = () => player.destroy()
    }).catch(() => {
      if (!cancelled) mount.textContent = '播放器加载失败，请重试'
    })
    return () => {
      cancelled = true
      dispose?.()
    }
  }, [src, poster])

  return <div ref={mountRef} className={className} />
}
