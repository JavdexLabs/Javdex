import fs from 'node:fs'
import path from 'node:path'
import {
  enableCatalogMigration,
  openIsolatedCatalog,
  statusCatalogMigration
} from './catalogMigration'

function requiredEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} required`)
  return value
}

function main(): void {
  if (process.env.JAVDEX_ENOSPC_CHILD !== '1') return
  const migrationId = requiredEnv('JAVDEX_ENOSPC_MIGRATION_ID')
  const digest = requiredEnv('JAVDEX_ENOSPC_DIGEST')
  const imagesDir = requiredEnv('JAVDEX_ENOSPC_IMAGES')
  const coverRel = requiredEnv('JAVDEX_ENOSPC_COVER_REL')
  const database = openIsolatedCatalog(requiredEnv('JAVDEX_ENOSPC_TARGET_DB'))
  const host = {
    appVersion: '0.7.0',
    userDataPath: requiredEnv('JAVDEX_TEST_USER_DATA'),
    imagesDir,
    mediaMounts: { mapped: requiredEnv('JAVDEX_ENOSPC_MOUNT') }
  }
  try {
    try {
      const enabled = enableCatalogMigration({ confirmSourceStopped: true, migrationId, digest }, host, database)
      process.stdout.write(
        `${JSON.stringify({
          code: null,
          phase: enabled.phase,
          coverExists: fs.existsSync(path.join(imagesDir, coverRel))
        })}\n`
      )
    } catch (error) {
      const status = statusCatalogMigration({ migrationId }, database)
      process.stdout.write(
        `${JSON.stringify({
          code: error && typeof error === 'object' && 'code' in error ? String((error as { code?: string }).code ?? '') : '',
          message: error instanceof Error ? error.message : String(error),
          phase: status.phase,
          coverExists: fs.existsSync(path.join(imagesDir, coverRel))
        })}\n`
      )
    }
  } finally {
    database.close()
  }
}

main()
