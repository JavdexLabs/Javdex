const KEYWORDS = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'instanceof',
  'let',
  'module',
  'new',
  'null',
  'of',
  'return',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'exports',
  'require'
])

type HighlightKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'function'

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function wrap(kind: HighlightKind, text: string): string {
  if (kind === 'plain') return escapeHtml(text)
  return `<span class="code-hl-${kind}">${escapeHtml(text)}</span>`
}

function isIdentifierStart(ch: string): boolean {
  return /[a-zA-Z_$]/.test(ch)
}

function isIdentifierPart(ch: string): boolean {
  return /[a-zA-Z0-9_$]/.test(ch)
}

export function highlightJavaScript(code: string): string {
  let html = ''
  let i = 0

  while (i < code.length) {
    const ch = code[i]
    const next = code[i + 1]

    if (ch === '/' && next === '/') {
      let j = i + 2
      while (j < code.length && code[j] !== '\n') j += 1
      html += wrap('comment', code.slice(i, j))
      i = j
      continue
    }

    if (ch === '/' && next === '*') {
      let j = i + 2
      while (j < code.length && !(code[j] === '*' && code[j + 1] === '/')) j += 1
      j = Math.min(code.length, j + 2)
      html += wrap('comment', code.slice(i, j))
      i = j
      continue
    }

    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < code.length) {
        if (code[j] === '\\') {
          j += 2
          continue
        }
        if (code[j] === quote) {
          j += 1
          break
        }
        j += 1
      }
      html += wrap('string', code.slice(i, j))
      i = j
      continue
    }

    if (/[0-9]/.test(ch) && (i === 0 || !isIdentifierPart(code[i - 1]))) {
      let j = i
      while (j < code.length && /[0-9.xXeE+-]/.test(code[j])) j += 1
      html += wrap('number', code.slice(i, j))
      i = j
      continue
    }

    if (isIdentifierStart(ch)) {
      let j = i + 1
      while (j < code.length && isIdentifierPart(code[j])) j += 1
      const word = code.slice(i, j)
      let kind: HighlightKind = 'plain'
      if (KEYWORDS.has(word)) kind = 'keyword'
      else {
        let k = j
        while (k < code.length && /\s/.test(code[k])) k += 1
        if (code[k] === '(') kind = 'function'
      }
      html += wrap(kind, word)
      i = j
      continue
    }

    html += wrap('plain', ch)
    i += 1
  }

  return html
}
