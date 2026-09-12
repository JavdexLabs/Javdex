import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { declarationsFor } from '../test/cssDeclarations'

const formCss = 'apps/desktop/src/renderer/src/components/FormPrimitives.module.css'
const settingsCss = 'apps/desktop/src/renderer/src/styles/plugin-development-shell.css'

describe('form hint styles', () => {
  it('keeps entity-edit and settings field hints muted and caption-sized', () => {
    const editHint = declarationsFor(formCss, '.editHint')
    const formHint = declarationsFor(formCss, '.formHint')
    const settingsHint = declarationsFor(settingsCss, '.settings-form-hint')

    assert.equal(editHint.get('color'), 'var(--text-muted)')
    assert.equal(editHint.get('font-size'), '11px')
    assert.equal(formHint.get('color'), 'var(--text-muted)')
    assert.equal(formHint.get('font-size'), 'var(--settings-fs-caption, 11px)')
    assert.equal(settingsHint.get('color'), 'var(--text-muted)')
    assert.equal(settingsHint.get('font-size'), 'var(--settings-fs-caption, 11px)')
  })

  it('routes entity-edit helper copy through EditFormField instead of a bare hint class', () => {
    const metadataModal = readFileSync(
      path.resolve('apps/desktop/src/renderer/src/components/EditMetadataModal.tsx'),
      'utf8'
    )
    const organizationPicker = readFileSync(
      path.resolve('apps/desktop/src/renderer/src/components/OrganizationPickerField.tsx'),
      'utf8'
    )

    assert.match(
      metadataModal,
      /hint="搜索已有制作商；输入新名称会在保存时创建。"/
    )
    assert.match(
      metadataModal,
      /hint="搜索已有发行商；输入新名称会在保存时创建。"/
    )
    assert.match(metadataModal, /hint="搜索已有系列；保留未选择的输入会新建未归属系列"/)
    assert.doesNotMatch(organizationPicker, /entity-edit-field-hint/)
    assert.doesNotMatch(metadataModal, /className="entity-edit-field-hint"/)
  })
})
