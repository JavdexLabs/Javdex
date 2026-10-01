import fs from 'node:fs'
import path from 'node:path'
import postcss from 'postcss'
import { inspectConsumerStyles, inspectModuleStyles } from './lib/css-style-ownership.mjs'

const roots = ['apps/desktop/src/renderer/src', 'apps/web/src', 'packages/ui/src']
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
const files = roots.flatMap(walk)
const owners = new Map()
const stylesheets = []
for (const file of files.filter(file => file.endsWith('.css') && !file.endsWith('.module.css'))) {
  const source = fs.readFileSync(file, 'utf8')
  const classes = new Set()
  postcss.parse(source, { from: file }).walkRules(rule => {
    for (const match of rule.selector.matchAll(/\.([_a-zA-Z][\w-]*)/g)) {
      classes.add(match[1])
      const paths = owners.get(match[1]) ?? new Set()
      paths.add(file)
      owners.set(match[1], paths)
    }
  })
  stylesheets.push({ file, lines: source.split('\n').length - 1, classes: [...classes].sort() })
}
const consumers = []
for (const file of files.filter(file => file.endsWith('.tsx') && !/\.test\.tsx$/.test(file))) {
  consumers.push(inspectConsumerStyles({ file, source: fs.readFileSync(file, 'utf8'), owners }))
}
const moduleEscapes = files.filter(file => file.endsWith('.module.css'))
  .map(file => inspectModuleStyles({ file, source: fs.readFileSync(file, 'utf8') }))
  .filter(item => item.globalSelectors.length > 0)
const result = { note: 'Candidate inventory, not a completion verifier: literal inline objects, undefined classes, global escapes, dynamic class builders and transitive component dependencies require review.', stylesheets, moduleEscapes, consumers }
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`Global stylesheets: ${stylesheets.length}; global class names: ${owners.size}; TSX consumers: ${consumers.length}`)
  console.table(consumers.filter(item => item.file.includes('/pages/')).map(item => ({
    page: path.basename(item.file), modules: item.modules.length, globalReferences: item.globalReferences.length,
    undefinedClasses: item.unownedLiteralClasses.length, inlineStyles: item.inlineStyles.length
  })))
  console.log(`Module global-selector candidates: ${moduleEscapes.reduce((sum, item) => sum + item.globalSelectors.length, 0)}; inline-style candidates: ${consumers.reduce((sum, item) => sum + item.inlineStyles.length, 0)}`)
}
