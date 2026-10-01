const previewFile = 'apps/web/src/ImagePreview.tsx'
const previewStyles = 'apps/web/src/ImagePreview.module.css'
const vendorImports = new Set([
  'yet-another-react-lightbox/styles.css',
  'yet-another-react-lightbox/plugins/counter.css'
])
const vendorSelector = /^\.root :global\(\.yarl__(?:toolbar|counter|button|slide|navigation_prev|navigation_next)\)(?::focus-visible)?$|^\.root :global\(\.yarl__button\)(?::disabled|:hover|:where\(:not\(:disabled\)\):active)$/

export function allowedWebGlobalImport(file, importPath) {
  return (file === 'apps/web/src/main.tsx' && importPath === './styles.css') ||
    (file === previewFile && vendorImports.has(importPath))
}

// Only this adapter may style these vendor parts, beneath its local root.
export function allowedWebGlobalSelector(file, selector) {
  return file === previewStyles && selector.split(',').every(part => vendorSelector.test(part.trim()))
}
