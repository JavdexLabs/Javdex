import type { BrowserWindow } from 'electron'
import { createNativeSharedTextureBridge, type SharedTextureProducer } from './nativeSharedTexture'

export function createMacSharedTextureBridge(native: SharedTextureProducer, window: BrowserWindow) {
  return createNativeSharedTextureBridge(native, window, 'darwin')
}
