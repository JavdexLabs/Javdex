import { nativeImage } from 'electron'
import type { LibraryImageCodec, LibraryImageSize } from '@library/runtime/host'

function nativeImageSize(image: Electron.NativeImage): LibraryImageSize | null {
  if (typeof image?.isEmpty !== 'function' || image.isEmpty()) return null
  const { width, height } = image.getSize()
  if (width <= 0 || height <= 0) return null
  return { width, height }
}

export function createElectronImageCodec(): LibraryImageCodec {
  return {
    sizeFromBuffer: (data) => {
      if (typeof nativeImage?.createFromBuffer !== 'function') return null
      return nativeImageSize(nativeImage.createFromBuffer(Buffer.from(data)))
    },
    sizeFromPath: (filePath) => {
      if (typeof nativeImage?.createFromPath !== 'function') return null
      return nativeImageSize(nativeImage.createFromPath(filePath))
    }
  }
}
