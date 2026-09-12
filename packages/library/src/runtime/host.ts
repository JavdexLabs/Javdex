import { readTestUserDataPath } from '@shared/appIdentity'

export interface LibraryHost {
  userDataPath(): string
}

let host: LibraryHost | null = null

export function configureLibraryHost(next: LibraryHost): void {
  host = next
}

export function resetLibraryHostForTests(): void {
  host = null
}

export function resolveLibraryUserDataPath(): string {
  const fromEnv = readTestUserDataPath()
  if (fromEnv) return fromEnv
  if (!host) throw new Error('Library host is not configured')
  return host.userDataPath()
}
