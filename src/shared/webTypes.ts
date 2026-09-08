/** Browser DTOs intentionally contain no filesystem paths or desktop commands. */
export interface WebAccessInput {
  enabled: boolean
  port: number
  username: string
  password?: string
}
export interface WebAccessStatus {
  enabled: boolean
  running: boolean
  port: number
  username: string
  hasPassword: boolean
  urls: string[]
  devices: WebDevice[]
  pairingUntil: number
  sessions: number
  error: string | null
}
export interface WebVideo {
  id: number
  code: string
  title: string
  cover: string | null
  releaseDate: string | null
  duration: number | null
  rating: number
}
export interface WebCollection {
  id: number
  name: string
  count: number
}
export interface WebBrowse {
  items: WebVideo[]
  total: number
  page: number
  pageSize: number
}
export interface WebResource {
  id: number
  name: string
  kind: string
  mime: string | null
  playable: boolean
  reason: string | null
}
export interface WebDetail extends WebVideo {
  summary: string | null
  maker: string | null
  publisher: string | null
  series: string | null
  director: string | null
  actresses: { id: number; name: string }[]
  tags: { id: number; name: string }[]
  images: string[]
  resources: WebResource[]
}

export interface WebDevice {
  id: string
  name: string
  remember: boolean
  created: number
  touched: number
}
