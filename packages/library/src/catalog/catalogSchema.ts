/** Ignore formatting and ALTER TABLE column order, preserving constraints and literals. */
export function schemaDeclaration(sql: string | null): string {
  if (sql === null) return ''
  const tokens = (sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|\d+|[^\s]/g) ?? [])
    .filter(token => !token.startsWith('--') && !token.startsWith('/*'))
    .map(token => /^[A-Za-z_]/.test(token) ? token.toUpperCase() : token)
  if (tokens[0] !== 'CREATE' || tokens[1] !== 'TABLE') return JSON.stringify(tokens)
  if (/^"[A-Za-z_][A-Za-z_0-9]*"$/.test(tokens[2])) tokens[2] = tokens[2].slice(1, -1).toUpperCase()
  const start = tokens.indexOf('(')
  if (start < 0) return JSON.stringify(tokens)
  const declarations: string[] = []
  let depth = 1; let from = start + 1; let end = from
  for (; end < tokens.length; end++) {
    const token = tokens[end]
    if (token === '(') depth++
    if (token === ')') depth--
    if ((token === ',' && depth === 1) || depth === 0) {
      declarations.push(JSON.stringify(tokens.slice(from, end))); from = end + 1
    }
    if (depth === 0) break
  }
  return JSON.stringify([tokens.slice(0, start), declarations.sort(), tokens.slice(end)])
}
