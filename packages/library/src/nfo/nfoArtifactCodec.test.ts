import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import {
  MAX_NFO_BYTES,
  NfoArtifactError,
  parseNfoArtifact,
  renderNfoArtifact
} from './nfoArtifactCodec'

function xml(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

describe('NFO artifact codec', () => {
  it('accepts the four synthetic third-party dialect fixtures', () => {
    const directory = path.resolve('test-fixtures/nfo/third-party')
    const expected = [
      ['mdc.nfo', 'mdc', 'MDC-001'],
      ['mdcx.nfo', 'mdcx', 'MDX-002'],
      ['javinizer.nfo', 'javinizer', 'JAV-003'],
      ['javsp.nfo', 'javsp', 'JSP-004']
    ] as const

    assert.deepEqual(
      expected.map(([file]) => {
        const model = parseNfoArtifact(fs.readFileSync(path.join(directory, file))).model
        return [file, model.dialect, model.code]
      }),
      expected
    )
  })

  it('round-trips five canonical Javdex fixtures with stable UTF-8 and LF output', () => {
    const directory = path.resolve('test-fixtures/nfo/javdex-roundtrip')
    const fixtures = fs.readdirSync(directory).filter((file) => file.endsWith('.nfo')).sort()
    assert.equal(fixtures.length, 5)

    for (const fixture of fixtures) {
      const golden = fs.readFileSync(path.join(directory, fixture))
      const first = parseNfoArtifact(golden).model
      const rendered = renderNfoArtifact(first)
      assert.equal(rendered.toString('utf8'), golden.toString('utf8').replace(/\r\n/gu, '\n'), fixture)
      assert.equal(rendered.toString('utf8').includes('\r'), false)
      const second = parseNfoArtifact(rendered).model
      assert.deepEqual(second, first)
      assert.deepEqual(renderNfoArtifact(second), rendered)
    }
  })

  it('normalizes the MDC dialect and prefers structured ratings over its scalar duplicate', () => {
    const parsed = parseNfoArtifact(
      xml(`<?xml version="1.0"?>
        <movie>
          <num>abc-001</num><title>MDC title</title><plot>Plot</plot>
          <maker>Maker</maker><label>Publisher</label><release>2026/09/04</release>
          <runtime>120</runtime><rating>8.8</rating>
          <ratings><rating name="jdb" max="5"><value>4.2</value><votes>12</votes></rating></ratings>
          <actor><name>Alice</name><gender>female</gender><thumb>actors/alice.jpg</thumb></actor>
          <thumb aspect="poster">poster.jpg</thumb><fanart><thumb>fanart.jpg</thumb></fanart>
        </movie>`)
    )

    assert.equal(parsed.model.dialect, 'mdc')
    assert.equal(parsed.model.code, 'ABC-001')
    assert.equal(parsed.model.title, 'MDC title')
    assert.equal(parsed.model.summary, 'Plot')
    assert.equal(parsed.model.maker, 'Maker')
    assert.equal(parsed.model.publisher, 'Publisher')
    assert.equal(parsed.model.releaseDate, '2026-09-04')
    assert.equal(parsed.model.durationSeconds, 7200)
    assert.equal(parsed.model.ratingAverage, 4.2)
    assert.equal(parsed.model.ratingCount, 12)
    assert.deepEqual(parsed.model.actors, [
      { name: 'Alice', declaredGender: 'female', thumbReferences: ['actors/alice.jpg'] }
    ])
    assert.deepEqual(parsed.model.coverReferences, ['poster.jpg'])
    assert.deepEqual(parsed.model.sampleReferences, ['fanart.jpg'])
  })

  it('normalizes MDCx, Javinizer, and JavSP field variants', () => {
    const mdcx = parseNfoArtifact(
      xml(`<movie><num>MDX-002</num><originaltitle>MDCx</originaltitle>
        <originalplot>Original plot</originalplot><publisher>Pub</publisher>
        <series>Series</series><actor><name>Bob</name></actor></movie>`)
    ).model
    assert.equal(mdcx.dialect, 'mdcx')
    assert.equal(mdcx.title, 'MDCx')
    assert.equal(mdcx.summary, 'Original plot')
    assert.equal(mdcx.publisher, 'Pub')
    assert.equal(mdcx.series, 'Series')

    const javinizer = parseNfoArtifact(
      xml(`<movie><id>JAV-003</id><title>Javinizer</title><set>Collection</set>
        <actor><name>Carol</name><altname>C</altname><role>Lead</role></actor></movie>`)
    ).model
    assert.equal(javinizer.dialect, 'javinizer')
    assert.equal(javinizer.code, 'JAV-003')
    assert.equal(javinizer.series, 'Collection')

    const javsp = parseNfoArtifact(
      xml(`<movie><uniqueid type="num">JSP-004</uniqueid><title>JavSP</title>
        <premiered>2026-09-04</premiered><studio>Studio</studio>
        <set><name>Structured</name></set><genre>Drama</genre><tag>drama</tag>
        <actor><name>Dave</name><gender>male</gender></actor></movie>`)
    ).model
    assert.equal(javsp.dialect, 'javsp')
    assert.equal(javsp.code, 'JSP-004')
    assert.equal(javsp.maker, 'Studio')
    assert.equal(javsp.series, 'Structured')
    assert.deepEqual(javsp.tags, ['Drama'])
    assert.equal(javsp.actors[0].declaredGender, 'male')
  })

  it('reports unknown legal tags and remote artwork without retaining remote URLs as assets', () => {
    const parsed = parseNfoArtifact(
      xml(`<movie><title>Unknown</title><custom>ignored</custom>
        <actor><name>Alice</name><mystery>ignored</mystery></actor>
        <thumb>https://example.test/poster.jpg?secret=1</thumb>
        <fanart><thumb>http://example.test/fanart.jpg</thumb></fanart></movie>`)
    )

    assert.equal(parsed.model.dialect, 'unknown')
    assert.deepEqual(parsed.model.coverReferences, [])
    assert.deepEqual(parsed.model.sampleReferences, [])
    assert.deepEqual(
      parsed.warnings.map((warning) => warning.code),
      [
        'unknown-dialect',
        'unknown-tag',
        'unknown-tag',
        'remote-image-ignored',
        'remote-image-ignored'
      ]
    )
    assert.equal(JSON.stringify(parsed).includes('secret=1'), false)
  })

  it('rejects DTD, entities, oversized input, excessive depth, node count, and field size', () => {
    const cases: Array<{ content: Buffer; code: NfoArtifactError['code'] }> = [
      { content: xml('<!DOCTYPE movie><movie/>'), code: 'unsafe-xml' },
      { content: xml('<!ENTITY x "boom"><movie><title>&x;</title></movie>'), code: 'unsafe-xml' },
      { content: xml('<movie><title>broken</movie>'), code: 'invalid-xml' },
      { content: Buffer.alloc(MAX_NFO_BYTES + 1, 0x20), code: 'too-large' },
      { content: xml(`<movie>${'<set>'.repeat(64)}x${'</set>'.repeat(64)}</movie>`), code: 'too-deep' },
      { content: xml(`<movie>${'<tag>x</tag>'.repeat(50_000)}</movie>`), code: 'too-many-nodes' },
      { content: xml(`<movie><title>${'x'.repeat(256 * 1024 + 1)}</title></movie>`), code: 'field-too-large' }
    ]

    for (const testCase of cases) {
      assert.throws(
        () => parseNfoArtifact(testCase.content),
        (error: unknown) => error instanceof NfoArtifactError && error.code === testCase.code
      )
    }
  })
})
