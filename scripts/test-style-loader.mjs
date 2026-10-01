const CSS_MODULE_SUFFIX = '.module.css'

export async function load(url, context, nextLoad) {
  // Browser bundlers turn imported icons into URL strings; no pixels are mocked here.
  if (url.endsWith('.png')) {
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
