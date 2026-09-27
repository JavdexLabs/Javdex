import { structuredError } from '@shared/protocol/errors'

// Format 1 describes a catalog identity, introduced with the official schema 17.
export const MIN_BACKUP_SCHEMA_VERSION = 17

/** Compare release versions, including SemVer prerelease precedence, without build metadata. */
export function compareBackupVersions(source: string, target: string): number {
  if (source === target) return 0
  const parse = (value: string): { core: bigint[]; pre: string[] } => {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value)
    if (!match) throw structuredError('INVALID_INPUT', '无法识别备份或当前应用的版本，不能确认恢复兼容性')
    const pre = match[4]?.split('.') ?? []
    if (pre.some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) throw structuredError('INVALID_INPUT', '应用预发布版本无效')
    return { core: match.slice(1, 4).map(BigInt), pre }
  }
  const a = parse(source); const b = parse(target)
  const compare = (x: bigint | string, y: bigint | string): number => x === y ? 0 : x < y ? -1 : 1
  for (let i = 0; i < 3; i++) { const order = compare(a.core[i], b.core[i]); if (order) return order }
  if (!a.pre.length || !b.pre.length) return a.pre.length ? -1 : b.pre.length ? 1 : 0
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1
    if (b.pre[i] === undefined) return 1
    const numericA = /^\d+$/.test(a.pre[i]); const numericB = /^\d+$/.test(b.pre[i])
    const order = numericA && numericB ? compare(BigInt(a.pre[i]), BigInt(b.pre[i])) : numericA !== numericB ? numericA ? -1 : 1 : compare(a.pre[i], b.pre[i])
    if (order) return order
  }
  return 0
}
