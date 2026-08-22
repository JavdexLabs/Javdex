const FORBIDDEN_EVALUATE_IDENTIFIERS = new Set([
  'fetch',
  'import',
  'require',
  'XMLHttpRequest',
  'WebSocket',
  'eval',
  'Function',
  'FormData',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'cookieStore',
  'ClipboardItem',
  'FileReader'
])

const FORBIDDEN_EVALUATE_MEMBERS = new Set([
  'cookie',
  'credentials',
  'password',
  'value',
  'files',
  'forms',
  'elements',
  'attributes',
  'innerHTML',
  'outerHTML',
  'constructor',
  '__proto__',
  'prototype',
  'getOwnPropertyDescriptor'
])

const SENSITIVE_LITERAL = /(?:password|passwd|passcode|credential|captcha|hcaptcha|g-recaptcha|cf-turnstile|api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|secret)/iu

const REGEX_PREFIX_KEYWORDS = new Set([
  'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new', 'return',
  'throw', 'typeof', 'void', 'yield'
])

interface ScanResult {
  forbidden: boolean
  index: number
}

function isIdentifierStart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z_$]/u.test(char))
}

function isIdentifierPart(char: string | undefined): boolean {
  return Boolean(char && /[A-Za-z0-9_$]/u.test(char))
}

function skipQuotedString(source: string, start: number, quote: "'" | '"'): {
  index: number
  value: string
} {
  let index = start + 1
  let value = ''
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      value += source.slice(index, Math.min(source.length, index + 2))
      index += 2
      continue
    }
    if (char === quote) return { index: index + 1, value }
    value += char
    index += 1
  }
  return { index, value }
}

function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1
  let inCharacterClass = false
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '[') inCharacterClass = true
    else if (char === ']') inCharacterClass = false
    else if (char === '/' && !inCharacterClass) {
      index += 1
      while (/[A-Za-z]/u.test(source[index] ?? '')) index += 1
      return index
    }
    index += 1
  }
  return index
}

function scanTemplate(source: string, start: number): ScanResult {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '`') return { forbidden: false, index: index + 1 }
    if (char === '$' && source[index + 1] === '{') {
      const expression = scanCode(source, index + 2, true)
      if (expression.forbidden) return expression
      index = expression.index
      continue
    }
    index += 1
  }
  return { forbidden: false, index }
}

function scanCode(source: string, start = 0, stopAtTemplateBrace = false): ScanResult {
  let index = start
  let braceDepth = 0
  let canStartRegex = true
  const computedMemberBrackets: boolean[] = []

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]
    if (/\s/u.test(char)) {
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      index += 2
      while (index < source.length && source[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        index += 1
      }
      index = Math.min(source.length, index + 2)
      continue
    }
    if (char === '/' && canStartRegex) {
      index = skipRegexLiteral(source, index)
      canStartRegex = false
      continue
    }
    if (char === "'" || char === '"') {
      const literal = skipQuotedString(source, index, char)
      if (
        computedMemberBrackets.at(-1) === true &&
        (FORBIDDEN_EVALUATE_IDENTIFIERS.has(literal.value) ||
          FORBIDDEN_EVALUATE_MEMBERS.has(literal.value))
      ) {
        return { forbidden: true, index: literal.index }
      }
      if (SENSITIVE_LITERAL.test(literal.value)) return { forbidden: true, index: literal.index }
      index = literal.index
      canStartRegex = false
      continue
    }
    if (char === '`') {
      const template = scanTemplate(source, index)
      if (template.forbidden) return template
      index = template.index
      canStartRegex = false
      continue
    }
    if (isIdentifierStart(char)) {
      const tokenStart = index
      index += 1
      while (isIdentifierPart(source[index])) index += 1
      const token = source.slice(tokenStart, index)
      let previous = tokenStart - 1
      while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1
      const isMember = source[previous] === '.'
      if (
        FORBIDDEN_EVALUATE_IDENTIFIERS.has(token) ||
        (isMember && FORBIDDEN_EVALUATE_MEMBERS.has(token))
      ) {
        return { forbidden: true, index }
      }
      canStartRegex = REGEX_PREFIX_KEYWORDS.has(token)
      continue
    }
    if (/[0-9]/u.test(char)) {
      index += 1
      while (/[A-Za-z0-9_.]/u.test(source[index] ?? '')) index += 1
      canStartRegex = false
      continue
    }
    if (char === '[') {
      computedMemberBrackets.push(!canStartRegex)
      canStartRegex = true
      index += 1
      continue
    }
    if (char === ']') {
      computedMemberBrackets.pop()
      canStartRegex = false
      index += 1
      continue
    }
    if (char === '{') {
      braceDepth += 1
      canStartRegex = true
      index += 1
      continue
    }
    if (char === '}') {
      if (stopAtTemplateBrace && braceDepth === 0) {
        return { forbidden: false, index: index + 1 }
      }
      braceDepth = Math.max(0, braceDepth - 1)
      canStartRegex = false
      index += 1
      continue
    }
    if (char === ')' || char === '.') {
      canStartRegex = false
    } else if (char === '+' && next === '+') {
      canStartRegex = false
      index += 1
    } else if (char === '-' && next === '-') {
      canStartRegex = false
      index += 1
    } else {
      canStartRegex = true
    }
    index += 1
  }
  return { forbidden: false, index }
}

/**
 * Reject executable access to browser/network escape hatches without treating diagnostic text,
 * comments or regular-expression patterns as executable API references.
 */
export function containsForbiddenBrowserEvaluateApi(expression: string): boolean {
  return scanCode(expression).forbidden
}

export function prepareBrowserEvaluate(
  expression: string,
  requestedTimeoutMs: number | undefined
): { source: string; timeoutMs: number } {
  const normalized = expression.trim()
  if (!normalized) throw new Error('evaluate requires expression')
  if (containsForbiddenBrowserEvaluateApi(normalized)) {
    throw new Error('evaluate expression contains forbidden or sensitive APIs')
  }
  const timeoutMs = typeof requestedTimeoutMs === 'number' && Number.isFinite(requestedTimeoutMs)
    ? Math.max(500, Math.min(10_000, Math.round(requestedTimeoutMs)))
    : 3_000
  return {
    source: `(async () => {
      const candidate = ${normalized};
      const result = typeof candidate === 'function' ? await candidate() : candidate;
      return JSON.parse(JSON.stringify(result));
    })()`,
    timeoutMs
  }
}

export async function runPreparedBrowserEvaluate<T>(input: {
  execute(): Promise<T>
  timeoutMs: number
  onTimeout(): Promise<void> | void
}): Promise<T> {
  const timeoutError = new Error('evaluate timed out')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      input.execute(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError), input.timeoutMs)
      })
    ])
  } catch (error) {
    if (error === timeoutError) await input.onTimeout()
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}
