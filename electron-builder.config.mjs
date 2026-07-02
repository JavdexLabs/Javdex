/** @type {import('electron-builder').Configuration} */
const base = {
  appId: 'com.javdex.app',
  productName: 'Javdex',
  extraMetadata: {
    description: 'Javdex'
  },
  copyright: 'Copyright © Javdex',
  directories: {
    buildResources: 'build',
    output: 'dist'
  },
  files: ['out/**/*'],
  asar: true,
  npmRebuild: true,
  nodeGypRebuild: false,
  extraResources: [
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'build/icon.ico', to: 'icon.ico' }
  ],
  win: {
    icon: 'build/icon.ico',
    artifactName: '${productName}-Setup-${version}-${arch}.${ext}',
    legalTrademarks: 'Javdex',
    target: []
  },
  portable: {
    artifactName: '${productName}-${version}-portable-${arch}.${ext}'
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Javdex',
    uninstallDisplayName: 'Javdex',
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    installerHeaderIcon: 'build/icon.ico'
  },
  mac: {
    icon: 'build/icon.icns',
    category: 'public.app-category.entertainment',
    artifactName: '${productName}-${version}-${arch}.${ext}',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    target: []
  },
  dmg: {
    title: '${productName} ${version} ${arch}',
    icon: 'build/icon.icns'
  },
  linux: {
    icon: 'build/icon.png',
    category: 'Video',
    maintainer: 'Javdex',
    artifactName: '${productName}-${version}-${arch}.${ext}',
    target: []
  }
}

function readSelectedTargets() {
  const raw = process.env.ELECTRON_BUILDER_TARGETS
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export default function buildConfig() {
  const selected = readSelectedTargets()
  const config = structuredClone(base)

  if (selected?.win) config.win.target = selected.win
  if (selected?.mac) config.mac.target = selected.mac
  if (selected?.linux) config.linux.target = selected.linux

  return config
}
