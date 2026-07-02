const Module = require('node:module')
const path = require('node:path')

const originalResolveFilename = Module._resolveFilename

Module._resolveFilename = function resolveWithProjectAliases(request, parent, isMain, options) {
  if (request.startsWith('@shared/')) {
    return path.join(process.cwd(), 'src', 'shared', `${request.slice('@shared/'.length)}.ts`)
  }
  if (request.startsWith('@renderer/')) {
    return path.join(process.cwd(), 'src', 'renderer', 'src', `${request.slice('@renderer/'.length)}.ts`)
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
