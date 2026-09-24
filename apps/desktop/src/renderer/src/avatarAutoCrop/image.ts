/** Keep media:// avatars origin-clean for canvas access and Worker transfer. */
export function loadAvatarAnalysisImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.decoding = 'async'
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image)
      else reject(new Error('头像图片尺寸无效'))
    }
    image.onerror = () => reject(new Error('无法读取头像图片'))
    image.src = url
  })
}

export async function createAvatarAnalysisBitmap(img: HTMLImageElement): Promise<ImageBitmap> {
  if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) {
    throw new Error('头像图片仍在加载，请稍后重试')
  }

  const ratio = Math.min(1, 1536 / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * ratio))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * ratio))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法读取头像图片')
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return createImageBitmap(canvas)
}
