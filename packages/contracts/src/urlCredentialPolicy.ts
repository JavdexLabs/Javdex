const SENSITIVE_QUERY_KEY = /(?:^|[-_])(?:access[_-]?token|token|secret|api[_-]?key|key|auth|authorization|signature|credential|policy|expires?)$/iu

export function isSensitiveUrlQueryKey(key: string): boolean {
  return SENSITIVE_QUERY_KEY.test(key)
}

export function hasSensitiveUrlQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some(isSensitiveUrlQueryKey)
}
