import fs from 'node:fs'
import path from 'node:path'

const roots = ['README.md', 'docs', 'src', 'package.json']
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.md', '.css', '.html'])
const suspicious = /�|锟|ï¿½/

function* walk(target) {
  if (!fs.existsSync(target)) return
  const stat = fs.statSync(target)
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      yield* walk(path.join(target, entry))
    }
    return
  }
  if (extensions.has(path.extname(target))) yield target
}

const failures = []
for (const root of roots) {
  for (const file of walk(root)) {
    const text = fs.readFileSync(file, 'utf8')
    if (suspicious.test(text)) failures.push(file)
  }
}

if (failures.length) {
  console.error('Suspicious encoding markers found:')
  for (const file of failures) console.error(`- ${file}`)
  process.exit(1)
}

console.log('Encoding check passed')
