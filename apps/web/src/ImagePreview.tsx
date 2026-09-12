import Lightbox from 'yet-another-react-lightbox'
import Zoom from 'yet-another-react-lightbox/plugins/zoom'
import Counter from 'yet-another-react-lightbox/plugins/counter'
import 'yet-another-react-lightbox/styles.css'
import 'yet-another-react-lightbox/plugins/counter.css'
import './image-preview.css'

export default function ImagePreview({ images, index, close, exited }: {
  images: { src: string; alt: string }[]
  index: number
  close: () => void
  exited: () => void
}): JSX.Element {
  return <Lightbox
    className="image-preview"
    open={index >= 0}
    index={Math.max(0, index)}
    slides={images}
    close={close}
    portal={{ container: { onKeyDownCapture: event => {
      if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
        .filter(button => button.getClientRects().length > 0)
      if (!buttons.length) return
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
      const next = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (current + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
      event.preventDefault()
      event.stopPropagation()
      buttons[next].focus()
    } } }}
    plugins={[Zoom, Counter]}
    zoom={{ maxZoomPixelRatio: 4, scrollToZoom: true, zoomInMultiplier: 1.2,
      wheelZoomDistanceFactor: 600, doubleClickMaxStops: 8 }}
    labels={{ Close: '关闭预览', Next: '下一张', Previous: '上一张',
      'Zoom in': '放大', 'Zoom out': '缩小', Lightbox: '图片预览',
      Slide: '图片', Carousel: '图片轮播', 'Photo gallery': '影片图片', '{index} of {total}': '第 {index} 张，共 {total} 张' }}
    render={{ iconError: () => <span role="alert">图片加载失败，请关闭后重试</span> }}
    carousel={{ finite: true, preload: 1, imageFit: 'contain' }}
    controller={{ aria: true, closeOnBackdropClick: true }}
    animation={window.matchMedia('(prefers-reduced-motion: reduce)').matches ? { fade: 0, swipe: 0, zoom: 0 } : { fade: 160, swipe: 250 }}
    on={{ exited }}
  />
}
