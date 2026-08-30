import { signAsync } from '@electron/osx-sign'
import { resolve } from 'node:path'
import {
  MAC_ELECTRON_LANGUAGES,
  PORTABLE_ELECTRON_LANGUAGES,
  prunePackagedRuntime
} from './scripts/packaging-runtime.mjs'

const adHocEntitlements = resolve('build/entitlements.mac.adhoc.plist')

async function signMacApp(options) {
  const identity = options.identity ?? '-'
  const signOptions = {
    ...options,
    identity,
    identityValidation: identity === '-' ? false : options.identityValidation
  }

  if (identity === '-') {
    const optionsForFile = options.optionsForFile
    signOptions.optionsForFile = (filePath) => ({
      ...(optionsForFile?.(filePath) ?? {}),
      entitlements: adHocEntitlements
    })
  }

  await signAsync(signOptions)
}

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
  files: [
    'out/**/*',
    '!out/resources/**/*',
    '!out/renderer/icon-{16,32,48,512}.png',
    '!node_modules/@mediapipe/tasks-vision/**/*',
    '!node_modules/**/*.d.ts',
    '!node_modules/**/*.d.mts',
    '!node_modules/**/*.d.cts',
    '!node_modules/**/*.d.ts.map',
    '!node_modules/**/*.map',
    '!node_modules/playwright-core/lib/vite/**/*',
    '!node_modules/@earendil-works/pi-coding-agent/**/*'
  ],
  asar: true,
  npmRebuild: true,
  nodeGypRebuild: false,
  extraResources: [
    { from: 'resources/icon.png', to: 'icon.png' },
    { from: 'build/icon.ico', to: 'icon.ico' }
  ],
  win: {
    icon: 'build/icon.ico',
    electronLanguages: PORTABLE_ELECTRON_LANGUAGES,
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
    identity: '-',
    electronLanguages: MAC_ELECTRON_LANGUAGES,
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
    electronLanguages: PORTABLE_ELECTRON_LANGUAGES,
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

  config.afterPack = prunePackagedRuntime
  config.mac.sign = signMacApp

  if (selected?.win) config.win.target = selected.win
  if (selected?.mac) config.mac.target = selected.mac
  if (selected?.linux) config.linux.target = selected.linux

  return config
}
