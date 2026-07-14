import { resolve } from 'path'
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin, ViteDevServer } from 'vite'

const MEDIAPIPE_RUNTIME_FILES = [
  'vision_wasm_module_internal.js',
  'vision_wasm_module_internal.wasm'
] as const

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
