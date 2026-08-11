import { createRequire, register } from 'node:module'

register('./test-style-loader.mjs', import.meta.url)

const require = createRequire(import.meta.url)
require.extensions['.css'] = (module, filename) => {
  const classes = new Proxy(Object.create(null), {
    get: (_target, key) => (typeof key === 'string' ? key : undefined)
  })
  module.exports = {
    __esModule: true,
    default: filename.endsWith('.module.css') ? classes : Object.create(null)
  }
}
