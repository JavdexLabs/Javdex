import { createAvatarAnalysisBitmap } from '../avatarAutoCrop/image'
import { analyzeAvatarBitmap } from '../avatarAutoCrop/service'
import type { ActressFaceScanStatus } from './cache'
import type { ActressFaceScanTarget } from './scanQueue'

const NO_FACE_ERROR_PREFIX = '未检测到清晰人脸'

export function isNoFaceDetectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith(NO_FACE_ERROR_PREFIX)
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.decoding = 'async'
    image.onload = () => {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve(image)
      else reject(new Error('头像图片尺寸无效'))
    }
    image.onerror = () => reject(new Error('无法读取头像图片'))
    image.src = url
  })
}

/** Detect only whether the current display avatar contains a face. */
export async function detectActressAvatarFace(
  target: ActressFaceScanTarget
): Promise<ActressFaceScanStatus> {
  const image = await loadImage(target.avatarUrl)
  const bitmap = await createAvatarAnalysisBitmap(image)
  try {
    const result = await analyzeAvatarBitmap(bitmap, 'face', false)
    return result.candidates.length > 0 ? 'has-face' : 'without-face'
  } catch (error) {
    // The existing crop service reports a successful zero-face inference as an
    // error because its caller needs a crop candidate. The filter translates
    // that one domain outcome into the explicit no-face state.
    if (isNoFaceDetectionError(error)) return 'without-face'
    throw error
  }
}
