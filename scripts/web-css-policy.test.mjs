import assert from 'node:assert/strict'
import { test } from 'node:test'
import { allowedWebGlobalImport, allowedWebGlobalSelector } from './lib/web-css-policy.mjs'

test('Web global entry and preview vendor styles have exact owners', () => {
  assert.equal(allowedWebGlobalImport('apps/web/src/main.tsx', './styles.css'), true)
  assert.equal(allowedWebGlobalImport('apps/web/src/ResourceCard.tsx', './styles.css'), false)
  assert.equal(allowedWebGlobalImport('apps/web/src/ImagePreview.tsx', 'yet-another-react-lightbox/styles.css'), true)
  assert.equal(allowedWebGlobalImport('apps/web/src/ImagePreview.tsx', 'yet-another-react-lightbox/plugins/counter.css'), true)
  assert.equal(allowedWebGlobalImport('apps/web/src/main.tsx', 'yet-another-react-lightbox/styles.css'), false)
  assert.equal(allowedWebGlobalImport('apps/web/src/ImagePreview.tsx', './image-preview.css'), false)
})

test('only the preview adapter may scope the documented YARL parts', () => {
  const file = 'apps/web/src/ImagePreview.module.css'
  for (const selector of ['.root :global(.yarl__toolbar)', '.root :global(.yarl__button):focus-visible',
    '.root :global(.yarl__button):disabled', '.root :global(.yarl__button):hover',
    '.root :global(.yarl__button):where(:not(:disabled)):active',
    '.root :global(.yarl__navigation_prev), .root :global(.yarl__navigation_next)']) {
    assert.equal(allowedWebGlobalSelector(file, selector), true)
    assert.equal(allowedWebGlobalSelector('apps/web/src/ResourceCard.module.css', selector), false)
  }
})

test('Web modules cannot escape through application hosts or unscoped vendor selectors', () => {
  for (const selector of [':global(.yarl__button)', ':global(.image-preview) .root',
    '.root :global(.topbar)', '.root :global(.yarl__unknown)',
    '.root :global(.yarl__toolbar):hover', '.root :global(.yarl__button):where(.application):active',
    '.root :global(.yarl__button), :global(button)', '.root :global(.yarl__button) :global(svg)']) {
    assert.equal(allowedWebGlobalSelector('apps/web/src/ImagePreview.module.css', selector), false)
  }
})
