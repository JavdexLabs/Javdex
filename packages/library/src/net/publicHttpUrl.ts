import { lookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'

export type PublicLookupAddress = { address: string; family: number }
export interface ResolvedPublicHttpUrl {
  url: URL
  addresses: PublicLookupAddress[]
}

type LookupAddress = PublicLookupAddress
type LookupAll = (hostname: string) => Promise<LookupAddress[]>

const NON_PUBLIC_IPV6 = new BlockList()
for (const [network, prefix] of [
  ['::', 8],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3ffe::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8]
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, 'ipv6')
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split('.').map(Number)
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false
  const [a, b, c] = octets
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false
  if (a === 100 && b >= 64 && b <= 127) return false
  if (a === 169 && b === 254) return false
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false
  if (a === 192 && b === 168) return false
  if (a === 198 && (b === 18 || b === 19)) return false
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  return true
}

function isPublicIpv6(rawAddress: string): boolean {
  const address = rawAddress.toLowerCase()
  return !NON_PUBLIC_IPV6.check(address, 'ipv6')
}

export function isPublicIpAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function normalizedHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
}

export async function resolvePublicHttpUrl(
  rawUrl: string,
  lookupAll: LookupAll = async (hostname) =>
    lookup(hostname, { all: true, verbatim: true }) as Promise<LookupAddress[]>
): Promise<ResolvedPublicHttpUrl> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new Error('链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('链接必须是有效的 HTTP/HTTPS 地址')
  }
  if (url.username || url.password) {
    throw new Error('链接不能包含用户名或密码')
  }

  const hostname = normalizedHostname(url)
  if (
    !hostname ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('链接不能访问本机或内网地址')
  }
  const literalFamily = isIP(hostname)
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupAll(hostname)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
    throw new Error('链接不能访问本机或内网地址')
  }
  url.hash = ''
  return { url, addresses }
}

export async function assertPublicHttpUrl(
  rawUrl: string,
  lookupAll?: LookupAll
): Promise<URL> {
  return (await resolvePublicHttpUrl(rawUrl, lookupAll)).url
}
