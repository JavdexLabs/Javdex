import { readTestUserDataPath } from '@shared/appIdentity'

export interface LibraryImageSize {
  width: number
  height: number
}

export interface LibraryImageCodec {
  sizeFromBuffer(data: Uint8Array): LibraryImageSize | null
  sizeFromPath(filePath: string): LibraryImageSize | null
}

export interface LibraryHost {
  userDataPath(): string
  images?: LibraryImageCodec
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

export function getLibraryImageCodec(): LibraryImageCodec | undefined {
  return host?.images
}
