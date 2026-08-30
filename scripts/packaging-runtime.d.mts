export const MAC_ELECTRON_LANGUAGES: readonly string[]
export const PORTABLE_ELECTRON_LANGUAGES: readonly string[]

export function macElectronLocaleNames(languages?: readonly string[]): Set<string>
export function prunePackagedRuntime(context: unknown): void
export function pruneBetterSqliteBuildFiles(packageDirectory: string): string[]
