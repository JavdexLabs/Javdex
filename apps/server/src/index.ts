import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServerConfig } from './config'
import { bindInstance } from './identity'
import { startJavdexServer } from './runtime'

function defaultStaticRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'web')
}

async function main(): Promise<void> {
  const { command, config } = await loadServerConfig(process.env, process.argv, {
    staticRoot: defaultStaticRoot()
  })
  if (command === 'bind') {
    const record = bindInstance(config.dataDir)
    process.stdout.write(`${JSON.stringify(record)}\n`)
    return
  }
  const server = await startJavdexServer(config)
  process.stdout.write(`javdex-server listening on ${config.listenHost}:${server.port}\n`)
  let stopping = false
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) return
    stopping = true
    void server
      .stop(signal)
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
