import type Database from 'better-sqlite3'
import { getDb } from '@library/db/database'
import { discardAllMaintenancePlans } from './catalogMaintenancePlans'
import { recoverCatalogTasks } from './catalogTasks'
import { resetCatalogNfoRuntime } from './catalogNfoExport'
import { resetCatalogScanRuntime } from './catalogScanRuntime'

export function recoverCatalogMaintenance(database: Database.Database = getDb()): {
  discardedPlans: number
  scanTasks: number
  inspectionTasks: number
} {
  resetCatalogScanRuntime()
  resetCatalogNfoRuntime()
  const discardedPlans = discardAllMaintenancePlans(database)
  const tasks = recoverCatalogTasks(database)
  return { discardedPlans, ...tasks }
}
