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
export function post<T>(url: string, body = {}): Promise<T> {
  return api<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}
