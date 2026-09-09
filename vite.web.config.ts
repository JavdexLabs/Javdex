import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
export default defineConfig({
  root: resolve('src/web'),
  plugins: [react()],
  build: { outDir: resolve('out/web'), emptyOutDir: true, target: 'es2020' }
})
