import { readFileSync } from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

export function declarationsFor(
  cssPath: string,
  selector: string,
  options?: { rootRulesOnly?: boolean }
): Map<string, string> {
  const source = readFileSync(path.resolve(cssPath), 'utf8')
  const declarations = new Map<string, string>()
  const root = postcss.parse(source)

  root.walkRules((rule) => {
    if (options?.rootRulesOnly && rule.parent?.type !== 'root') return
    if (!rule.selector.split(',').map((item) => item.trim()).includes(selector)) return
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value)
    })
  })

  return declarations
}
