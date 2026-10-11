import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const repo = process.cwd()
const server = await createServer({ configFile: false, root: path.join(repo, 'scripts/ui-regression'),
  plugins: [react()], cacheDir: path.join(repo, 'out/external-ratings-qa/.vite'),
  resolve: { alias: { '@shared': path.join(repo, 'packages/contracts/src'),
    react: path.join(repo, 'node_modules/react'), 'react-dom': path.join(repo, 'node_modules/react-dom') } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [repo] } } })
await server.listen()
console.log(`Preview: http://127.0.0.1:${server.httpServer.address().port}/external-ratings.html`)
