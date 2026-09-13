import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadServerConfig } from './config'
import { issueDeployToken, issueMigrationToken } from './identity'
import { startJavdexServer } from './runtime'

function defaultStaticRoot(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'web')
}

function bootstrapTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.JAVDEX_BOOTSTRAP_TOKEN?.trim()
  return value ? value : undefined
}

async function main(): Promise<void> {
  const { command, config } = await loadServerConfig(process.env, process.argv, {
    staticRoot: defaultStaticRoot()
  })
  const bootstrapToken = bootstrapTokenFromEnv(process.env)
  if (command === 'bind') {
    const issued = issueDeployToken(config, 'initialBind', { bootstrapToken })
    process.stdout.write(`${JSON.stringify(issued)}\n`)
    return
  }
  if (command === 'recover') {
    const issued = issueDeployToken(config, 'deployRecover')
    process.stdout.write(`${JSON.stringify(issued)}\n`)
    return
  }
  if (command === 'migrate-auth') {
    const issued = issueMigrationToken(config)
    process.stdout.write(`${JSON.stringify(issued)}\n`)
    return
  }
  const server = await startJavdexServer(config, { bootstrapToken })
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
