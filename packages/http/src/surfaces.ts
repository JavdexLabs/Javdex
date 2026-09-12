export const BROWSER_HTTP_SURFACE = 'browser' as const
export const MANAGE_HTTP_SURFACE = 'manage' as const

export type HttpSurface = typeof BROWSER_HTTP_SURFACE | typeof MANAGE_HTTP_SURFACE

/** Management HTTP is assembled only by a dedicated server manage process. Browse never enables it. */
export function createManageHttpServer(): never {
  throw new Error('管理 HTTP 面不能由浏览服务装配；须由独立的服务器管理宿主注册。')
}
