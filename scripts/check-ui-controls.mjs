import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const root = path.resolve('apps/desktop/src/renderer/src')
const primitiveFiles = new Set(['components/Switch.tsx', 'components/Checkbox.tsx'])
const violations = []

function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) { inspect(file); continue }
    if (!file.endsWith('.tsx') || file.endsWith('.test.tsx')) continue
    const relative = path.relative(root, file).replaceAll(path.sep, '/')
    if (primitiveFiles.has(relative) || file === path.resolve('packages/ui/src/Checkbox.tsx')) continue
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    function visit(node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source)
        const attributes = new Map(node.attributes.properties
          .filter(ts.isJsxAttribute)
          .map((attribute) => [attribute.name.getText(source), attribute.initializer]))
        const literal = (value) => {
          if (value && ts.isStringLiteral(value)) return value.text
          if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteral(value.expression)) return value.expression.text
          return null
        }
        if ((tag === 'input' && literal(attributes.get('type')) === 'checkbox') ||
            (/^[a-z]/.test(tag) && literal(attributes.get('role')) === 'switch')) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
          violations.push(`${relative}:${line} 请使用 Switch（启用/关闭）或 Checkbox（多项选择）`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
}

inspect(root)
inspect(path.resolve('packages/ui/src'))
if (violations.length) {
  console.error(violations.join('\n'))
  process.exitCode = 1
} else {
  console.log('UI control checks passed: shared Switch / Checkbox only.')
}
