export const ACTION_NETWORK_MAX_REQUESTS = 24
export const ACTION_NETWORK_POST_DATA_LIMIT = 512

const ACTION_NETWORK_TYPES = new Set(['Document', 'XHR', 'Fetch'])
const SENSITIVE_POST_DATA = /(?:password|passwd|passcode|credential|captcha|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|secret)/iu

export interface AgentActionNetworkRequest {
  method: string
  url: string
  resourceType: string
  status?: number
  postData?: string
}

export function isActionNetworkResourceType(type: string): boolean {
  return ACTION_NETWORK_TYPES.has(type)
}

export function sanitizeActionNetworkUrl(url: string | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    parsed.username = ''
    parsed.password = ''
    return parsed.href
  } catch {
    return null
  }
}

export function sanitizeActionNetworkPostData(postData: string | undefined): string | undefined {
  const value = postData?.trim()
  if (!value) return undefined
  if (SENSITIVE_POST_DATA.test(value)) return undefined
  return value.length > ACTION_NETWORK_POST_DATA_LIMIT
    ? value.slice(0, ACTION_NETWORK_POST_DATA_LIMIT)
    : value
}

export function normalizeActionNetworkMethod(method: string | undefined): string {
  const value = method?.trim()
  return value ? value.toUpperCase() : 'GET'
}

/** Action-scoped document/xhr/fetch log. Host does not label which request is search. */
export class ActionNetworkCapture {
  private active = false
  private readonly pending = new Map<string, AgentActionNetworkRequest>()
  private completed: AgentActionNetworkRequest[] = []

  get isActive(): boolean {
    return this.active
  }

  begin(): void {
    this.active = true
    this.pending.clear()
    this.completed = []
  }

  rememberRequest(input: {
    requestId: string
    url?: string
    method?: string
    type?: string
    postData?: string
  }): void {
    if (!this.active || !input.requestId) return
    const type = input.type ?? ''
    if (!isActionNetworkResourceType(type)) return
    const url = sanitizeActionNetworkUrl(input.url)
    if (!url) return
    const item: AgentActionNetworkRequest = {
      method: normalizeActionNetworkMethod(input.method),
      url,
      resourceType: type
    }
    const postData = sanitizeActionNetworkPostData(input.postData)
    if (postData) item.postData = postData
    this.pending.set(input.requestId, item)
    this.pushCompleted(item)
  }

  rememberResponse(input: {
    requestId: string
    url?: string
    status?: number
    type?: string
  }): void {
    if (!this.active || !input.requestId) return
    const existing = this.pending.get(input.requestId)
    if (existing) {
      if (typeof input.status === 'number' && Number.isFinite(input.status)) {
        existing.status = input.status
      }
      return
    }
    this.rememberRequest({
      requestId: input.requestId,
      url: input.url,
      type: input.type
    })
    const created = this.pending.get(input.requestId)
    if (created && typeof input.status === 'number' && Number.isFinite(input.status)) {
      created.status = input.status
    }
  }

  take(): AgentActionNetworkRequest[] | undefined {
    if (!this.active) return undefined
    this.active = false
    this.pending.clear()
    return this.completed.slice()
  }

  private pushCompleted(item: AgentActionNetworkRequest): void {
    this.completed.push(item)
    if (this.completed.length > ACTION_NETWORK_MAX_REQUESTS) {
      this.completed.shift()
    }
  }
}
