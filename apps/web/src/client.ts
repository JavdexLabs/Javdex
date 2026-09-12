export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
export async function api<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers: { ...options.headers, 'X-Javdex-Client': 'web' }
  })
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: '请求失败，请稍后重试' }))
    throw new ApiError(response.status, body.error ?? '请求失败')
  }
  return response.json() as Promise<T>
}
export async function post<T>(
  url: string,
  body = {},
  options: RequestInit = {}
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  const parent = options.signal
  let timedOut = false
  if (parent?.aborted) abort()
  parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, 15_000)
  try {
    return await api<T>(url, {
      ...options,
      signal: controller.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  } catch (error) {
    if (timedOut) throw new Error('连接超时，请重试')
    throw error
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', abort)
  }
}
