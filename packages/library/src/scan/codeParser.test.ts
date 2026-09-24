import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCode } from './codeParser'

describe('parseCode', () => {
  it('parses standard codes', () => {
    assert.equal(parseCode('IPX-535'), 'IPX-535')
    assert.equal(parseCode('MUKD-501'), 'MUKD-501')
    assert.equal(parseCode('T28-581'), 'T28-581')
    assert.equal(parseCode('ipx-535 Sakura'), 'IPX-535')
  })

  it('parses 規格品番 ADV-R and ADV-SR', () => {
    assert.equal(parseCode('ADV-R0484'), 'ADV-R0484')
    assert.equal(parseCode('ADV-SR0196'), 'ADV-SR0196')
    assert.equal(parseCode('ADV-368'), 'ADV-368')
    assert.equal(parseCode('ADVVSR-486'), 'ADVVSR-486')
  })

  it('does not mis-parse ADV-R0484 as R0-484', () => {
    assert.notEqual(parseCode('ADV-R0484'), 'R0-484')
  })

  it('parses FC2 and Heyzo', () => {
    assert.equal(parseCode('FC2-PPV-1234567'), 'FC2-1234567')
    assert.equal(parseCode('HEYZO-1234'), 'HEYZO-1234')
  })

  it('parses DMM h_ prefix', () => {
    assert.equal(parseCode('h_1472smkcx003'), 'H_1472SMKCX003')
  })

  it('parses date-based uncensored ids', () => {
    assert.equal(parseCode('020326_001-1PON'), '020326_001-1PON')
  })

  it('extracts code after @ in filename', () => {
    assert.equal(parseCode('site.com@ADV-R0484'), 'ADV-R0484')
  })

  it('returns null for noise-only names', () => {
    assert.equal(parseCode('random_movie'), null)
    assert.equal(parseCode('12345'), null)
  })

  it('rejects no-hyphen and short-prefix patterns', () => {
    assert.equal(parseCode('DFE052'), null)
    assert.equal(parseCode('ORECO183'), null)
    assert.equal(parseCode('N1234'), null)
  })
})
