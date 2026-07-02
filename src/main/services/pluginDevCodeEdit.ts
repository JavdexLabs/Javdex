import type { ScraperPluginKind } from '@shared/types'

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/

export interface TopLevelFunctionInfo {
  name: string
  startLine: number
  endLine: number
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function lineNumberAt(code: string, index: number): number {
  return code.slice(0, index).split('\n').length
}

function buildFunctionPattern(target: string): RegExp {
  const t = escapeRegExp(target)
  return new RegExp(
    `(?:async\\s+function\\s+${t}\\s*\\([^)]*\\)\\s*\\{)|(?:function\\s+${t}\\s*\\([^)]*\\)\\s*\\{)|(?:const\\s+${t}\\s*=\\s*async\\s*\\([^)]*\\)\\s*=>\\s*\\{)|(?:const\\s+${t}\\s*=\\s*function\\s*\\([^)]*\\)\\s*\\{)`,
    'm'
  )
}

function findFunctionBodyEnd(code: string, braceStart: number): number {
  let depth = 0
  for (let i = braceStart; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

function findTopLevelFunctionRange(
  code: string,
  targetName: string
): { start: number; end: number; startLine: number; endLine: number } | null {
  const fnPattern = buildFunctionPattern(targetName)
  const match = fnPattern.exec(code)
  if (!match || match.index === undefined) return null

  const start = match.index
  const braceStart = code.indexOf('{', match.index)
  if (braceStart < 0) return null
  const end = findFunctionBodyEnd(code, braceStart)
  if (end < 0) return null

  return {
    start,
    end,
    startLine: lineNumberAt(code, start),
    endLine: lineNumberAt(code, end)
  }
}

/** Collect top-level binding names in source order (line-based depth tracking). */
export function listTopLevelBindingNames(code: string): string[] {
  const names: string[] = []
  let depth = 0

  for (const line of code.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('//')) {
      depth += countBraceDelta(line)
      depth = Math.max(0, depth)
      continue
    }

    if (depth === 0) {
      const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/)
      const constMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/)
      if (fnMatch) names.push(fnMatch[1])
      if (constMatch) names.push(constMatch[1])
    }

    depth += countBraceDelta(line)
    depth = Math.max(0, depth)
  }

  return names
}

function countBraceDelta(line: string): number {
  let delta = 0
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let escaped = false

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (inSingle) {
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '"') inDouble = false
      continue
    }
    if (inTemplate) {
      if (ch === '`') inTemplate = false
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '`') {
      inTemplate = true
      continue
    }
    if (ch === '{') delta += 1
    else if (ch === '}') delta -= 1
  }

  return delta
}

export function findDuplicateTopLevelBindings(code: string): string[] {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const name of listTopLevelBindingNames(code)) {
    if (seen.has(name)) dupes.add(name)
    seen.add(name)
  }
  return [...dupes]
}

export function assertNoDuplicateTopLevelBindings(code: string): void {
  const dupes = findDuplicateTopLevelBindings(code)
  if (dupes.length === 0) return
  throw new Error(
    `检测到重复顶层符号：${dupes.join('、')}。请用 functionName 直接替换 helper，或使用 replace_snippet，不要在 parseVideo/parseActress 替换块里重复声明 head 中已有的 helper。`
  )
}

export function listTopLevelFunctions(code: string): TopLevelFunctionInfo[] {
  const seen = new Set<string>()
  const out: TopLevelFunctionInfo[] = []

  for (const name of listTopLevelBindingNames(code)) {
    if (seen.has(name)) continue
    seen.add(name)
    const range = findTopLevelFunctionRange(code, name)
    if (!range) continue
    out.push({ name, startLine: range.startLine, endLine: range.endLine })
  }

  return out
}

export function normalizePluginCodeExport(kind: ScraperPluginKind, code: string): string {
  const parserName = kind === 'video' ? 'parseVideo' : 'parseActress'
  let normalized = code.trim()

  normalized = normalized.replace(
    new RegExp(`\\bexport\\s+default\\s+\\{\\s*${parserName}\\b`),
    `module.exports = { ${parserName}`
  )
  normalized = normalized.replace(
    new RegExp(`\\bexport\\s+(async\\s+function\\s+${parserName}\\s*\\()`, 'g'),
    '$1'
  )
  normalized = normalized.replace(
    new RegExp(`\\bexport\\s+(function\\s+${parserName}\\s*\\()`, 'g'),
    '$1'
  )
  normalized = normalized.replace(
    /\bexport\s+(async\s+function\s+parseTask\s*\()/g,
    '$1'
  )
  normalized = normalized.replace(/\bexport\s+(function\s+parseTask\s*\()/g, '$1')

  if (/\bmodule\.exports\b|\bexports\./.test(normalized)) return normalized

  const parserPattern = new RegExp(
    `(async\\s+function\\s+${parserName}\\s*\\(|function\\s+${parserName}\\s*\\(|(?:const|let|var)\\s+${parserName}\\s*=)`
  )
  if (parserPattern.test(normalized)) {
    return `${normalized}\n\nmodule.exports = { ${parserName} }\n`
  }

  if (
    /\basync\s+function\s+parseTask\s*\(|\bfunction\s+parseTask\s*\(|\b(?:const|let|var)\s+parseTask\s*=/.test(
      normalized
    )
  ) {
    return `${normalized}\n\nmodule.exports = { parseTask }\n`
  }

  return normalized
}

function finalizePluginCode(kind: ScraperPluginKind, code: string): string {
  const normalized = normalizePluginCodeExport(kind, code)
  assertNoDuplicateTopLevelBindings(normalized)
  return normalized
}

export function replacePluginSnippetCode(
  kind: ScraperPluginKind,
  currentCode: string,
  oldText: string,
  newText: string,
  nearLine?: number
): string {
  if (!oldText) throw new Error('oldText 不能为空')
  if (oldText === newText) throw new Error('oldText 与 newText 相同，无需替换')

  const indices: number[] = []
  let pos = 0
  while (pos <= currentCode.length) {
    const idx = currentCode.indexOf(oldText, pos)
    if (idx < 0) break
    indices.push(idx)
    pos = idx + 1
  }

  if (indices.length === 0) {
    throw new Error('未找到 oldText 匹配片段，请扩大上下文（多带 2～3 行 surrounding code）')
  }

  let replaceIndex = indices[0]
  if (indices.length > 1) {
    if (nearLine !== undefined && Number.isFinite(nearLine)) {
      replaceIndex = indices.reduce((best, idx) => {
        const line = lineNumberAt(currentCode, idx)
        const bestLine = lineNumberAt(currentCode, best)
        return Math.abs(line - nearLine) < Math.abs(bestLine - nearLine) ? idx : best
      })
    } else {
      throw new Error(
        `oldText 匹配 ${indices.length} 处，不唯一；请扩大 oldText 或提供 nearLine 指定行号`
      )
    }
  }

  const next =
    currentCode.slice(0, replaceIndex) + newText + currentCode.slice(replaceIndex + oldText.length)
  return finalizePluginCode(kind, next)
}

export function replacePluginFunctionCode(
  kind: ScraperPluginKind,
  currentCode: string,
  functionName: string | undefined,
  newFunctionCode: string
): string {
  const parserName = kind === 'video' ? 'parseVideo' : 'parseActress'
  const target = functionName?.trim() || parserName

  if (!IDENTIFIER_PATTERN.test(target)) {
    throw new Error(`无效的 functionName：${target}`)
  }

  const range = findTopLevelFunctionRange(currentCode, target)
  if (!range) {
    const available = listTopLevelFunctions(currentCode)
      .map((item) => `${item.name}@${item.startLine}`)
      .join(', ')
    if (target !== parserName && target !== 'parseTask') {
      throw new Error(
        `未找到顶层函数 ${target}。${available ? `当前顶层函数：${available}` : '当前 code 中无已知顶层函数'}`
      )
    }
    return finalizePluginCode(kind, `${currentCode.trim()}\n\n${newFunctionCode.trim()}`)
  }

  const moduleExportMatch = /\bmodule\.exports\s*=/.exec(currentCode.slice(range.end))
  const tail = moduleExportMatch
    ? currentCode.slice(range.end)
    : `\n\nmodule.exports = { ${parserName} }\n`

  const head = currentCode.slice(0, range.start)
  const headNames = new Set(listTopLevelBindingNames(head))
  const newNames = listTopLevelBindingNames(newFunctionCode)
  const overlap = newNames.filter((name) => headNames.has(name) && name !== target)
  if (overlap.length > 0) {
    throw new Error(
      `替换 ${target} 时，code 中重复声明了 head 已有的顶层符号：${overlap.join('、')}。请改用 functionName="${overlap[0]}" 或 replace_snippet。`
    )
  }

  return finalizePluginCode(kind, `${head}${newFunctionCode.trim()}${tail}`)
}
