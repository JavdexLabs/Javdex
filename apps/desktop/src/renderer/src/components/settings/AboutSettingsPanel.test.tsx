import assert from 'node:assert/strict'
import { it } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

Object.defineProperty(globalThis, 'React', { configurable: true, value: React })

it('shows GPL v3-or-later licensing, redistribution and warranty notices', async () => {
  const previousWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { api: {} } })
  try {
    const { default: AboutSettingsPanel } = await import('./AboutSettingsPanel')
    const markup = renderToStaticMarkup(<AboutSettingsPanel />)
    assert.match(markup, /GPL-3\.0-or-later/)
    assert.match(markup, /GPL v3 或后续版本/)
    assert.match(markup, /可按许可再分发/)
    assert.match(markup, /不提供任何保证/)
    assert.match(markup, /查看 GPL 许可证/)
    assert.doesNotMatch(markup, /MIT License/)
  } finally {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow })
  }
})
