const CSS_MODULE_SUFFIX = '.module.css'
import { isPiGoogleAdapter, patchPiGoogleTransport } from './pi-google-transport.mjs'

export async function load(url, context, nextLoad) {
  if (isPiGoogleAdapter(url)) {
    const result = await nextLoad(url, context)
    return { ...result, source: patchPiGoogleTransport(String(result.source)) }
  }
  // Browser bundlers turn imported icons into URL strings; no pixels are mocked here.
  if (url.endsWith('.png') || url.endsWith('.svg')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(url)}`
    }
  }

  if (url.endsWith(CSS_MODULE_SUFFIX)) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        const classes = new Proxy(Object.create(null), {
          get: (_target, key) => typeof key === 'string' ? key : undefined
        })
        export default classes
      `
    }
  }

  if (url.endsWith('.css')) {
    return {
      format: 'module',
      shortCircuit: true,
      source: 'export default Object.create(null)'
    }
  }

  return nextLoad(url, context)
}
