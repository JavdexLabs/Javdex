import path from 'node:path'
import fs from 'node:fs'
import type { ExternalVideoResourceKind } from '@shared/videoTypes'
import { normalizeExternalVideoResource } from '@shared/videoResourceLinks'

export const MAX_STRM_BYTES = 1024 * 1024

export type StrmParseErrorCode =
  | 'too_large'
  | 'invalid_utf8'
  | 'missing_target'
  | 'multiple_targets'
  | 'unsupported_target'

const STRM_ERROR_MESSAGES: Record<StrmParseErrorCode, string> = {
  too_large: 'STRM 文件超过 1 MiB',
  invalid_utf8: 'STRM 文件不是有效的 UTF-8 文本',
  missing_target: 'STRM 文件没有有效目标',
  multiple_targets: 'STRM 文件包含多个目标',
  unsupported_target: 'STRM 目标协议不受支持'
}

export class StrmParseError extends Error {
  constructor(readonly code: StrmParseErrorCode) {
    super(STRM_ERROR_MESSAGES[code])
    this.name = 'StrmParseError'
  }
}

export interface ParsedStrmTarget {
  kind: ExternalVideoResourceKind
  locator: string
  targetKey: string
}

export function isStrmFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.strm'
}

export function parseStrmContent(
  _sourcePath: string,
  content: Uint8Array
): ParsedStrmTarget {
  if (content.byteLength > MAX_STRM_BYTES) throw new StrmParseError('too_large')

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new StrmParseError('invalid_utf8')
  }

  const targets = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
  if (targets.length === 0) throw new StrmParseError('missing_target')
  if (targets.length !== 1) throw new StrmParseError('multiple_targets')

  try {
    const normalized = normalizeExternalVideoResource(targets[0])
    return {
      kind: normalized.kind,
      locator: normalized.locator,
      targetKey: normalized.resourceKey
    }
  } catch {
    throw new StrmParseError('unsupported_target')
  }
}

export function readStrmFile(sourcePath: string): ParsedStrmTarget {
  const stat = fs.statSync(sourcePath)
  if (stat.size > MAX_STRM_BYTES) throw new StrmParseError('too_large')
  return parseStrmContent(sourcePath, fs.readFileSync(sourcePath))
}
