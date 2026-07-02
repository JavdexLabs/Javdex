import { resolve } from 'path'
import { cpSync, existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

function copyBundledPluginsPlugin() {
  const source = resolve('src/main/bundled-plugins')
  const target = resolve('out/main/bundled-plugins')
  return {
    name: 'copy-bundled-plugins',
    closeBundle() {
      if (!existsSync(source)) return
      cpSync(source, target, { recursive: true })
    }
  }
}

function copyAppResourcesPlugin() {
  const source = resolve('resources')
  const target = resolve('out/resources')
  return {
    name: 'copy-app-resources',
    closeBundle() {
      if (!existsSync(source)) return
      cpSync(source, target, { recursive: true })
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyBundledPluginsPlugin(), copyAppResourcesPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
})
