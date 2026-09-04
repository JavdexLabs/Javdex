import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

export function sourceFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(fullPath)
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [fullPath] : []
  })
}

export function importsOf(file) {
  const source = readFileSync(file, 'utf8')
  const specifiers = new Set()
  for (const match of source.matchAll(/\bimport\s+(?:[^'";]*?\s+from\s+)?(['"])([^'"]+)\1/g)) {
    specifiers.add(match[2])
  }
  for (const match of source.matchAll(/\bexport\s+(?:\*|\{[^}]*\})\s+from\s+(['"])([^'"]+)\1/g)) {
    specifiers.add(match[2])
  }
  for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*(['"])([^'"]+)\1\s*\)/g)) {
    specifiers.add(match[2])
  }
  return [...specifiers]
}
