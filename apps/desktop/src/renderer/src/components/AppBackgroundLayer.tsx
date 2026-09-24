import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties
} from 'react'

type BackgroundFit = 'cover' | 'contain'

type PortraitFrame = {
  leftPct: number
  widthPct: number
  fadePx: number
}

function computePortraitFrame(
  containerW: number,
  containerH: number,
  imageW: number,
  imageH: number
): PortraitFrame {
  const scale = Math.min(containerW / imageW, containerH / imageH)
  const renderedW = imageW * scale
  const leftPct = ((containerW - renderedW) / 2 / containerW) * 100
  const widthPct = (renderedW / containerW) * 100
  const fadePx = Math.min(140, Math.max(56, renderedW * 0.16))
  return { leftPct, widthPct, fadePx }
}

export default function AppBackgroundLayer({
  src,
  animationClass
}: {
  src: string
  animationClass: string
}): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null)
  const [fit, setFit] = useState<BackgroundFit>('cover')
  const [frame, setFrame] = useState<PortraitFrame | null>(null)

  const syncPortraitFrame = useCallback(() => {
    const root = rootRef.current
    const natural = naturalSizeRef.current
    if (!root || !natural) return

    const { width, height } = root.getBoundingClientRect()
    if (width <= 0 || height <= 0) return

    setFrame(computePortraitFrame(width, height, natural.w, natural.h))
  }, [])

  const applyNaturalSize = useCallback(
    (width: number, height: number) => {
      if (width <= 0 || height <= 0) return

      const isPortrait = height > width
      naturalSizeRef.current = { w: width, h: height }
      setFit(isPortrait ? 'contain' : 'cover')

      if (!isPortrait) {
        setFrame(null)
        return
      }

      const root = rootRef.current
      if (root) {
        const { width: containerW, height: containerH } = root.getBoundingClientRect()
        if (containerW > 0 && containerH > 0) {
          setFrame(computePortraitFrame(containerW, containerH, width, height))
          return
        }
      }

      setFrame(null)
    },
    []
  )

  useLayoutEffect(() => {
    let cancelled = false

    setFit('cover')
    setFrame(null)
    naturalSizeRef.current = null

    const probe = new Image()
    const finish = (): void => {
      if (cancelled) return
      applyNaturalSize(probe.naturalWidth, probe.naturalHeight)
    }

    probe.onload = finish
    probe.src = src
    if (probe.complete) finish()

    return () => {
      cancelled = true
      probe.onload = null
    }
  }, [src, applyNaturalSize])

  useEffect(() => {
    if (fit !== 'contain') return

    syncPortraitFrame()
    const root = rootRef.current
    if (!root) return

    const observer = new ResizeObserver(() => syncPortraitFrame())
    observer.observe(root)
    return () => observer.disconnect()
  }, [fit, syncPortraitFrame])

  const frameStyle: CSSProperties | undefined =
    frame && fit === 'contain'
      ? {
          left: `${frame.leftPct}%`,
          width: `${frame.widthPct}%`
        }
      : undefined

  const leftFadeStyle: CSSProperties | undefined =
    frame && fit === 'contain'
      ? { left: `${frame.leftPct}%`, width: frame.fadePx }
      : undefined

  const rightFadeStyle: CSSProperties | undefined =
    frame && fit === 'contain'
      ? {
          left: `calc(${frame.leftPct}% + ${frame.widthPct}% - ${frame.fadePx}px)`,
          width: frame.fadePx
        }
      : undefined

  return (
    <div
      ref={rootRef}
      className={`app-background ${animationClass}${
        fit === 'contain' ? ' app-background--portrait' : ''
      }`}
      aria-hidden
    >
      {fit === 'contain' ? (
        frame ? (
          <>
            <div className="app-background-frame" style={frameStyle}>
              <img src={src} alt="" draggable={false} className="app-background-frame-img" />
            </div>
            <div
              className="app-background-edge-fade app-background-edge-fade--left"
              style={leftFadeStyle}
            />
            <div
              className="app-background-edge-fade app-background-edge-fade--right"
              style={rightFadeStyle}
            />
          </>
        ) : null
      ) : (
        <img
          src={src}
          alt=""
          draggable={false}
          className="app-background-img app-background-img--cover"
        />
      )}
      <div className="app-background-shade" />
    </div>
  )
}
