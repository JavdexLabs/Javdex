import { resolve } from 'path'
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin, ViteDevServer } from 'vite'

const MEDIAPIPE_RUNTIME_FILES = [
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm'
] as const
const PI_EXTENSION_LOADER_SUFFIX =
  '/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js'
const PI_EXTENSION_API_STUB = '\0javdex-pi-extension-api-stub'

function mediaPipeRuntimePlugin(): Plugin {
  const source = resolve('node_modules/@mediapipe/tasks-vision/wasm')
  const target = resolve('out/renderer/mediapipe')

  return {
    name: 'copy-mediapipe-runtime',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        const pathname = request.url?.split('?', 1)[0] ?? ''
        const fileName = pathname.startsWith('/mediapipe/')
          ? pathname.slice('/mediapipe/'.length)
          : ''
        if (!MEDIAPIPE_RUNTIME_FILES.includes(fileName as (typeof MEDIAPIPE_RUNTIME_FILES)[number])) {
          next()
          return
        }
        const filePath = resolve(source, fileName)
        if (!existsSync(filePath)) {
          response.statusCode = 404
          response.end()
          return
        }
        response.setHeader(
          'Content-Type',
          fileName.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8'
        )
        createReadStream(filePath).pipe(response)
      })
    },
    closeBundle() {
      mkdirSync(target, { recursive: true })
      for (const fileName of MEDIAPIPE_RUNTIME_FILES) {
        copyFileSync(resolve(source, fileName), resolve(target, fileName))
      }
    }
  }
}

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

function slimPiRuntimePlugin(): Plugin {
  return {
    name: 'slim-pi-runtime',
    enforce: 'pre',
    resolveId(source, importer) {
      if (
        source === '../../index.js' &&
        importer?.replaceAll('\\', '/').endsWith(PI_EXTENSION_LOADER_SUFFIX)
      ) {
        return PI_EXTENSION_API_STUB
      }
      return null
    },
    load(id) {
      if (id === PI_EXTENSION_API_STUB) return 'export {}'
      return null
    }
  }
}

function copyPiRuntimeAssetsPlugin(): Plugin {
  const source = resolve(
    'node_modules/@earendil-works/pi-coding-agent/node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm'
  )
  const target = resolve('out/main/chunks/photon_rs_bg.wasm')
  return {
    name: 'copy-pi-runtime-assets',
    closeBundle() {
      mkdirSync(resolve('out/main/chunks'), { recursive: true })
      copyFileSync(source, target)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [
      slimPiRuntimePlugin(),
      externalizeDepsPlugin({ exclude: ['undici'] }),
      copyBundledPluginsPlugin(),
      copyPiRuntimeAssetsPlugin()
    ],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@pi-coding-agent-runtime': resolve(
          'node_modules/@earendil-works/pi-coding-agent/dist'
        )
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
    plugins: [react(), mediaPipeRuntimePlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html')
        }
      }
    }
  }
})
