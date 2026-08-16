const CSS_MODULE_SUFFIX = '.module.css'

export async function load(url, context, nextLoad) {
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
