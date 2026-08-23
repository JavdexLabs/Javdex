import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatPageDomForPrompt,
  formatPageInsightForPrompt,
  formatPageLinksForPrompt
} from './pluginDevPageFormat'
import type { PluginDevPageInsight } from '@shared/pluginDevTypes'

const tokyolibPage: PluginDevPageInsight = {
  label: '调试详情页',
  url: 'https://www.tokyolib.com/v/541125',
  title: 'MUKD-573',
  text: 'MUKD-573 示例页面',
  forms: [],
  links: [
    { text: '無垢', href: '/studio/2130', region: 'breadcrumb' },
    { text: 'MUKD', href: '/label/2992', region: 'breadcrumb' },
    { text: 'Muku', href: '/studio/2130', region: 'metadata' },
    { text: '無垢', href: '/label/2992', region: 'metadata' }
  ],
  domRegions: [
    {
      label: '面包屑导航',
      selector: 'nav.breadcrumb',
      html: '<nav class="breadcrumb"><a href="/studio/2130">無垢</a><a href="/label/2992">MUKD</a></nav>'
    },
    {
      label: '元数据属性区',
      selector: 'div.attributes > dl',
      html: '<dl><dd>🎥 片商</dd><dt><a href="/studio/2130">Muku</a></dt><dd>🔖 厂牌</dd><dt><a href="/label/2992">無垢</a></dt></dl>'
    }
  ],
  definitionLists: [
    {
      selector: 'div.attributes > dl',
      items: [
        { term: '🎥 片商', value: 'Muku', valueHtml: '<a href="/studio/2130">Muku</a>' },
        { term: '🔖 厂牌', value: '無垢', valueHtml: '<a href="/label/2992">無垢</a>' }
      ]
    }
  ]
}

describe('pluginDevPageFormat', () => {
  it('formats definition lists and dom regions for prompts', () => {
    const dom = formatPageDomForPrompt(tokyolibPage)
    assert.match(dom, /DEFINITION_LISTS/)
    assert.match(dom, /片商 => Muku/)
    assert.match(dom, /厂牌 => 無垢/)
    assert.match(dom, /DOM_REGIONS/)
    assert.match(dom, /面包屑导航/)
    assert.match(dom, /元数据属性区/)
  })

  it('formats inspect locale anchors without treating them as a language API', () => {
    const dom = formatPageDomForPrompt({
      ...tokyolibPage,
      localeLinks: [
        { text: '简体中文', href: 'https://www.tokyolib.com/cn', rawHref: '/cn' }
      ]
    })
    assert.match(dom, /LOCALE_LINKS/)
    assert.match(dom, /不是页面语言 API/)
    assert.match(dom, /简体中文 -> https:\/\/www\.tokyolib\.com\/cn rawHref=\/cn/)
  })

  it('includes link region markers', () => {
    const links = formatPageLinksForPrompt(tokyolibPage)
    assert.match(links, /region=breadcrumb/)
    assert.match(links, /region=metadata/)
  })

  it('builds full page insight prompt', () => {
    const prompt = formatPageInsightForPrompt(tokyolibPage)
    assert.match(prompt, /DEFINITION_LISTS/)
    assert.match(prompt, /metadata 区链接优先/)
  })

  it('keeps forms and prioritized links when raw DOM regions are very large', () => {
    const prompt = formatPageInsightForPrompt({
      ...tokyolibPage,
      forms: [{
        selector: '#search',
        method: 'get',
        action: '/search',
        inputs: [{ selector: '#keyword', name: 'q', type: 'text' }],
        buttons: []
      }],
      links: [{ text: 'MILK-295', href: '/videos/milk-295', region: 'other' }],
      domRegions: [{ label: '巨型主区块', selector: 'main', html: 'x'.repeat(20_000) }]
    })

    assert.match(prompt, /#keyword/)
    assert.match(prompt, /MILK-295 -> \/videos\/milk-295/)
    assert.ok(Array.from(prompt).length <= 12_000)
  })
})
