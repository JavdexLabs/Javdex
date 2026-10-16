import { z } from 'zod'
import { SERVER_ENVIRONMENT_VERSION, SERVER_RUNTIME_ID } from './serverUpdateTypes'

export { SERVER_ENVIRONMENT_VERSION, SERVER_RUNTIME_ID } from './serverUpdateTypes'
export const SERVER_IMAGE_UPGRADE_MESSAGE = '需要升级服务端Docker镜像'
export const serverEnvironmentInfoSchema = z.object({
  format: z.literal(1),
  environmentVersion: z.number().int().positive().safe(),
  runtimeId: z.string().min(1).max(80),
  platform: z.enum(['linux/amd64', 'linux/arm64'])
})
export type ServerEnvironmentInfo = z.infer<typeof serverEnvironmentInfoSchema>
export interface ServerEnvironmentSnapshot {
  state: 'compatible' | 'imageRequired' | 'clientRequired' | 'unavailable'
  currentVersion: number | null
  requiredVersion: number
  runtimeId: string | null
  platform: string | null
  message: string | null
}

export function evaluateServerEnvironment(info: ServerEnvironmentInfo | null, requiredVersion = SERVER_ENVIRONMENT_VERSION): ServerEnvironmentSnapshot {
  const state = !info || info.environmentVersion < requiredVersion ? 'imageRequired'
    : info.environmentVersion > requiredVersion ? 'clientRequired'
      : info.runtimeId !== SERVER_RUNTIME_ID ? 'unavailable' : 'compatible'
  return {
    state, currentVersion: info?.environmentVersion ?? null, requiredVersion,
    runtimeId: info?.runtimeId ?? null, platform: info?.platform ?? null,
    message: state === 'imageRequired' ? SERVER_IMAGE_UPGRADE_MESSAGE
      : state === 'clientRequired' ? '服务端运行环境较新，请升级此客户端'
        : state === 'unavailable' ? '运行环境与此客户端不兼容，请核对镜像和客户端版本' : null
  }
}

export class ServerEnvironmentMismatchError extends Error {
  readonly code = 'ENVIRONMENT_VERSION_MISMATCH'
  readonly currentEnvironmentVersion: number
  readonly requiredEnvironmentVersion: number
  constructor(currentEnvironmentVersion: number, requiredEnvironmentVersion: number) {
    super(currentEnvironmentVersion < requiredEnvironmentVersion ? SERVER_IMAGE_UPGRADE_MESSAGE : '服务端运行环境较新，请升级此客户端')
    this.name = 'ServerEnvironmentMismatchError'
    this.currentEnvironmentVersion = currentEnvironmentVersion
    this.requiredEnvironmentVersion = requiredEnvironmentVersion
  }
}

export function assertServerEnvironmentVersion(required: number, current = SERVER_ENVIRONMENT_VERSION): void {
  if (required !== current) throw new ServerEnvironmentMismatchError(current, required)
}
