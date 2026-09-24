import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ACTRESS_FIELD_SEMANTICS,
  PLUGIN_FIELD_SEMANTICS_VERSION,
  VIDEO_FIELD_SEMANTICS,
  assertCompleteFieldSemantics,
  projectPluginResultField
} from './pluginFieldSemantics'
import { buildPluginFieldSemanticsPrompt } from './scrapeFieldPromptDocs'

describe('plugin field semantics registry', () => {
  it('covers every video and actress field with valid symmetric conflicts', () => {
    assert.equal(PLUGIN_FIELD_SEMANTICS_VERSION, 1)
    assert.doesNotThrow(() => assertCompleteFieldSemantics())
    assert.equal(new Set(VIDEO_FIELD_SEMANTICS.map((item) => item.id)).size, VIDEO_FIELD_SEMANTICS.length)
    assert.equal(new Set(ACTRESS_FIELD_SEMANTICS.map((item) => item.id)).size, ACTRESS_FIELD_SEMANTICS.length)
    for (const definition of [...VIDEO_FIELD_SEMANTICS, ...ACTRESS_FIELD_SEMANTICS]) {
      assert.ok(definition.description.length > 0)
      assert.ok(definition.resultKeys.length > 0)
      assert.ok(definition.labels.canonical.length > 0)
      for (const conflict of definition.conflictsWith) {
        const peer = [...VIDEO_FIELD_SEMANTICS, ...ACTRESS_FIELD_SEMANTICS].find(
          (candidate) => candidate.kind === definition.kind && candidate.id === conflict
        )
        assert.ok(peer, `${definition.kind}.${definition.id} conflict ${conflict} exists`)
        assert.ok(peer!.conflictsWith.includes(definition.id), `${conflict} points back to ${definition.id}`)
      }
    }
  })

  it('generates the Agent glossary from the selected registry fields', () => {
    const prompt = buildPluginFieldSemanticsPrompt('video', ['maker', 'publisher'])
    assert.match(prompt, new RegExp(`registry v${PLUGIN_FIELD_SEMANTICS_VERSION}`))
    assert.match(prompt, /maker（制作商）/)
    assert.match(prompt, /publisher（发行商）/)
    assert.doesNotMatch(prompt, /duration（时长）/)
  })

  it('projects female and male performers independently', () => {
    const result = {
      actresses: [
        { name: 'Alice', gender: 'female' },
        { name: 'Bob', gender: 'male' },
        { name: 'Unknown' }
      ]
    }
    assert.deepEqual(projectPluginResultField('video', 'actressesFemale', result), [
      { name: 'Alice', gender: 'female' },
      { name: 'Unknown' }
    ])
    assert.deepEqual(projectPluginResultField('video', 'actressesMale', result), [
      { name: 'Bob', gender: 'male' }
    ])
  })

  it('projects composite rating and measurements without collapsing their parts', () => {
    assert.deepEqual(projectPluginResultField('video', 'rating', {
      ratingAverage: 4.2,
      ratingCount: 100
    }), { average: 4.2, count: 100 })
    assert.deepEqual(projectPluginResultField('actress', 'measurements', {
      bustCm: 88,
      waistCm: 58,
      hipCm: 86
    }), { bustCm: 88, waistCm: 58, hipCm: 86 })
  })
})
