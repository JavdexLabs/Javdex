import { contextBridge } from 'electron'
import { installSharedTextureReceiver } from '../apps/desktop/src/preload/sharedTextureReceiver'
const bind = installSharedTextureReceiver()
contextBridge.exposeInMainWorld('textureProbe', { bind })
