import path from 'node:path'

export interface MainWindowAssetPaths {
  preload: string
  renderer: string
}

/** Resolve renderer assets from Electron's application root, not an emitted chunk directory. */
export function resolveMainWindowAssetPaths(appRoot: string): MainWindowAssetPaths {
  return {
    preload: path.join(appRoot, 'out', 'preload', 'index.js'),
    renderer: path.join(appRoot, 'out', 'renderer', 'index.html')
  }
}
