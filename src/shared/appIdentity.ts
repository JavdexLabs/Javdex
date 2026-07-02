/** Display name shown in window title, sidebar, and agent prompts. */
export const APP_DISPLAY_NAME = 'Javdex'

/** Electron userData folder name under %AppData% (capitalized). */
export const APP_PACKAGE_NAME = 'Javdex'

/** Env override for tests and headless main-process runs. */
export const TEST_USER_DATA_ENV = 'JAVDEX_TEST_USER_DATA'

/** Env override for bundled plugin root in tests. */
export const BUNDLED_PLUGINS_ROOT_ENV = 'JAVDEX_BUNDLED_PLUGINS_ROOT'

export function readTestUserDataPath(): string | undefined {
  return process.env[TEST_USER_DATA_ENV]
}
