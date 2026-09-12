import type { DesktopSession } from '@shared/desktop/session'
import type { ThisComputerSettings } from '@shared/desktop/settings'
import type { CatalogTaskSnapshot } from '@shared/protocol/tasks'

export interface DesktopWorkStore {
  getTask(taskId: string): Promise<CatalogTaskSnapshot | null>
  putTask(task: CatalogTaskSnapshot): Promise<void>
  listOpenVerifications(): Promise<Array<{ operationId: string; catalogId: string }>>
}

export interface DesktopCredentialStore {
  isAvailable(): Promise<boolean>
  readWriterSecret(catalogId: string): Promise<string | null>
  writeWriterSecret(catalogId: string, secret: string): Promise<void>
  deleteWriterSecret(catalogId: string): Promise<void>
}

export interface DesktopSettingsStore {
  read(): Promise<ThisComputerSettings>
  write(patch: Partial<ThisComputerSettings>): Promise<ThisComputerSettings>
}

export interface DesktopRuntimePorts {
  settings: DesktopSettingsStore
  credentials: DesktopCredentialStore
  workStore: DesktopWorkStore
  session: () => DesktopSession
}
