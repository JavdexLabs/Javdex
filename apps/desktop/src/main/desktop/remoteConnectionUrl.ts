import { structuredError } from '@shared/protocol/errors'

/** The desktop always connects to the deployment's single public TLS gateway. */
export function assertRemoteBaseUrl(value: string): void {
  let url: URL
  try { url = new URL(value) } catch { throw structuredError('INVALID_INPUT', '请输入完整的 HTTPS 服务器地址') }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw structuredError('INVALID_INPUT', '请使用统一入口的 HTTPS 根地址，不包含路径、账号或密码')
  }
}
