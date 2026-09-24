import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'

const rendererRoot = path.resolve('apps/desktop/src/renderer/src')
const baselinePath = path.resolve('scripts/css-architecture-baseline.json')
const writeBaseline = process.argv.includes('--write-baseline')
const debtKeys = [
  'globalClassCount',
  'crossFileDuplicateClassCount',
  'descendantSelectorCount',
  'importantDeclarationCount',
  'hardcodedColorDeclarationCount',
  'globalStateClassCount',
  'rawButtonClassOccurrenceCount',
  'classNameBehaviorInferenceCount'
]

function walk(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) return walk(fullPath, predicate)
    return predicate(fullPath) ? [fullPath] : []
  })
}

function relative(filePath) {
  return path.relative(process.cwd(), filePath).replaceAll(path.sep, '/')
}

function selectorParts(selector) {
  return selector.split(',').map((part) => part.trim()).filter(Boolean)
}

function isDescendantSelector(selector) {
  return /[^>+~\s]\s+[^>+~\s]/.test(selector)
}

function collectMetrics() {
  const roots = [rendererRoot, path.resolve('packages/ui/src')]
  const cssFiles = roots.flatMap((root) => walk(root, (file) => file.endsWith('.css')))
  const sourceFiles = roots.flatMap((root) => walk(root, (file) => /\.tsx?$/.test(file)))
  const globalClasses = new Set()
  const classFiles = new Map()
  let descendantSelectorCount = 0
  let importantDeclarationCount = 0
  let hardcodedColorDeclarationCount = 0
  let globalStateClassCount = 0
  const violations = []

  for (const file of cssFiles) {
    const source = readFileSync(file, 'utf8')
    const isModule = file.endsWith('.module.css')
    const root = postcss.parse(source, { from: file })
    root.walkRules((rule) => {
      for (const selector of selectorParts(rule.selector)) {
        if (isDescendantSelector(selector)) descendantSelectorCount += 1
        for (const match of selector.matchAll(/\.([_a-zA-Z]+[\w-]*)/g)) {
          const className = match[1]
          if (!isModule) {
            globalClasses.add(className)
            if (className.startsWith('is-')) globalStateClassCount += 1
            const owners = classFiles.get(className) ?? new Set()
            owners.add(relative(file))
            classFiles.set(className, owners)
          }
        }
      }
    })
    root.walkDecls((declaration) => {
      if (declaration.important) importantDeclarationCount += 1
      if (/(?:#[\da-f]{3,8}\b|\b(?:rgb|hsl)a?\()/i.test(declaration.value)) {
        hardcodedColorDeclarationCount += 1
        if (isModule) {
          violations.push(`${relative(file)}:${declaration.source?.start?.line ?? 1} hardcodes a color`)
        }
      }
    })
  }

  let rawButtonClassOccurrenceCount = 0
  let classNameBehaviorInferenceCount = 0
  for (const file of sourceFiles) {
    const source = readFileSync(file, 'utf8')
    rawButtonClassOccurrenceCount += source.match(/['"`]btn(?:-[\w-]+)?\b/g)?.length ?? 0
    classNameBehaviorInferenceCount +=
      source.match(/className[^\n]{0,120}\.(?:includes|match|test)\s*\(/g)?.length ?? 0

    for (const match of source.matchAll(/import\s+['"]([^'"]+\.css)['"]/g)) {
      const importPath = match[1]
      const isMainGlobalEntry =
        relative(file) === 'apps/desktop/src/renderer/src/main.tsx' && importPath === './styles/global.css'
      if (!importPath.endsWith('.module.css') && !isMainGlobalEntry) {
        violations.push(`${relative(file)} imports global CSS directly: ${importPath}`)
      }
    }
  }

  const forbiddenStyles = walk(rendererRoot, (file) => /\.(?:scss|sass|less)$/.test(file))
  for (const file of forbiddenStyles) violations.push(`${relative(file)} uses a forbidden preprocessor`)

  return {
    metrics: {
      cssFileCount: cssFiles.length,
      globalClassCount: globalClasses.size,
      crossFileDuplicateClassCount: [...classFiles.values()].filter((files) => files.size > 1).length,
      descendantSelectorCount,
      importantDeclarationCount,
      hardcodedColorDeclarationCount,
      globalStateClassCount,
      rawButtonClassOccurrenceCount,
      classNameBehaviorInferenceCount
    },
    violations
  }
}

const result = collectMetrics()

if (writeBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(result.metrics, null, 2)}\n`)
  console.log(`Wrote CSS architecture baseline to ${relative(baselinePath)}`)
  console.table(result.metrics)
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
for (const key of debtKeys) {
  if (result.metrics[key] > baseline[key]) {
    result.violations.push(`${key} increased from ${baseline[key]} to ${result.metrics[key]}`)
  }
}

if (result.violations.length > 0) {
  console.error('CSS architecture checks failed:')
  for (const violation of result.violations) console.error(`- ${violation}`)
  process.exit(1)
}

console.log('CSS architecture checks passed.')
console.table(result.metrics)
