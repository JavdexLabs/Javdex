// Pi 0.84.2's Google adapter rejects custom fetch; the pinned Google SDK uses
// global fetch in its internal ApiClient.apiCall transport seam.
// Keep Pi's native conversion, streaming, retries and tool handling; only forward
// the transport supplied by Javdex. Shared by the bundle and test module loader.
export function patchPiGoogleTransport(source) {
  const replacements = [
    ['            if (options?.fetch && options.fetch !== globalThis.fetch) {\n                throw new Error("Custom fetch is not supported by the Google Generative AI adapter");\n            }\n', ''],
    ['createClient(model, apiKey, options?.headers)', 'createClient(model, apiKey, options?.headers, options?.fetch)'],
    ['function createClient(model, apiKey, optionsHeaders)', 'function createClient(model, apiKey, optionsHeaders, fetch)'],
    ['    return new GoogleGenAI({', '    const client = new GoogleGenAI({'],
    ['        httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,\n    });',
      '        httpOptions: Object.keys(httpOptions).length > 0 ? httpOptions : undefined,\n    });\n' +
      '    if (fetch) {\n' +
      '        if (typeof client.apiClient?.apiCall !== "function") throw new Error("Google SDK transport seam changed");\n' +
      '        client.apiClient.apiCall = (url, init) => fetch(url, init);\n' +
      '    }\n' +
      '    return client;']
  ]
  let patched = source.replaceAll('\r\n', '\n')
  for (const [before, after] of replacements) {
    if (patched.split(before).length !== 2) throw new Error('Pi Google transport patch no longer matches pinned adapter')
    patched = patched.replace(before, after)
  }
  return patched
}

export function isPiGoogleAdapter(id) {
  return id.replaceAll('\\', '/').endsWith('/@earendil-works/pi-ai/dist/api/google-generative-ai.js')
}
