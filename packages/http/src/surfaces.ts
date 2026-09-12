export const BROWSER_HTTP_SURFACE = 'browser' as const
export const MANAGE_HTTP_SURFACE = 'manage' as const

export type HttpSurface = typeof BROWSER_HTTP_SURFACE | typeof MANAGE_HTTP_SURFACE

/** Management HTTP is assembled only by the server host. Local browse never enables it. */
export function createManageHttpServer(): never {
  throw new Error('管理 HTTP 面不能由本地浏览服务装配；服务器宿主在 S04 之后单独注册。')
}
