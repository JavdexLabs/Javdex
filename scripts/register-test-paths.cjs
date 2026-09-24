const Module = require('node:module')
const path = require('node:path')

const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function resolveWithProjectAliases(request, parent, isMain, options) {
  if (request.startsWith('@pi-coding-agent-runtime/')) {
    return path.join(
      process.cwd(),
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      request.slice('@pi-coding-agent-runtime/'.length)
    )
  }
  if (request.startsWith('@shared/')) {
    return path.join(process.cwd(), 'packages', 'contracts', 'src', `${request.slice('@shared/'.length)}.ts`)
  }
  if (request.startsWith('@library/')) {
    return path.join(process.cwd(), 'packages', 'library', 'src', `${request.slice('@library/'.length)}.ts`)
  }
  if (request.startsWith('@http/')) {
    return path.join(process.cwd(), 'packages', 'http', 'src', `${request.slice('@http/'.length)}.ts`)
  }
  if (request.startsWith('@renderer/')) {
    return path.join(process.cwd(), 'apps', 'desktop', 'src', 'renderer', 'src', `${request.slice('@renderer/'.length)}.ts`)
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
