import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSemanticVerificationPrompt,
  collectMakerPublisherLinkTrapIssues,
  collectSiteUnsupportedSupportedFields,
  collectSupportedFieldsToAdd,
  collectStructuralVerificationIssues,
  filterVerificationItemsBySupportedFields,
  formatVerificationForPrompt,
  getResultValueForField,
  isBlockingVerificationFailure,
  normalizeAbsentFieldVerifications,
  noteSuggestsSiteUnsupportedField,
  pageLikelyHasFieldSignal,
  pageMatchesActressTarget,
  parseSemanticVerificationResponse,
  syncSupportedFieldsFromVerification,
  verifyDebugResultAgainstPages
} from './pluginDevVerification'
import type { ActressScrapeField, PluginDevDiscovery, VideoScrapeField } from '@shared/types'

const discovery: PluginDevDiscovery = {
  pages: [
    {
      label: '调试详情页',
      url: 'https://example.com/v/123',
      title: 'MUKD-573 示例',
      text: '番号 MUKD-573 标题 示例影片 制作商 Muku 发行商 無垢',
      forms: [],
      links: [
        { text: 'Muku', href: 'https://example.com/studio/muku' },
        { text: '無垢', href: 'https://example.com/label/muku' }
      ]
    }
  ],
  notes: []
}

describe('pluginDevVerification', () => {
  it('collects invalid result keys structurally', () => {
    const items = collectStructuralVerificationIssues('video', {
      code: 'MUKD-573',
      title: '示例影片',
      releasedDate: '2026-04-16'
    })

    assert.equal(items.find((item) => item.field === 'releasedDate')?.status, 'invalid_key')
  })

  it('builds semantic prompt with user feedback and field glossary', () => {
    const prompt = buildSemanticVerificationPrompt(
      {
        kind: 'video',
        lastResult: { code: 'MUKD-573', maker: '無垢', publisher: 'MUKD' },
        discovery,
        supportedFields: ['maker', 'publisher'],
        userFeedback: '制作商和发行商错了',
        testTarget: 'MUKD-573'
      },
      discovery.pages[0]
    )

    assert.match(prompt, /用户反馈（最高优先级/)
    assert.match(prompt, /制作商和发行商错了/)
    assert.match(prompt, /maker：制作商/)
    assert.match(prompt, /publisher：发行商/)
    assert.match(prompt, /不要把“字符串出现在页面某处”等同于“字段正确”/)
    assert.match(prompt, /站点无此字段/)
    assert.match(prompt, /页面无此字段/)
  })

  it('marks template-missing fields as site unsupported in absent-field normalization', () => {
    const referencePage = {
      label: '详情页',
      url: 'https://www.javlibrary.com/?v=javme4ieru',
      title: 'MUKD-573 示例',
      text: '番号 MUKD-573 标题 示例影片 制作商 Muku 发行商 無垢 发行日期 2021-01-01 标签 单体作品 女优 示例演员',
      forms: [],
      links: [
        { text: 'Muku', href: '/studio/muku' },
        { text: '無垢', href: '/label/muku' }
      ]
    }
    const items = normalizeAbsentFieldVerifications(
      [{ field: 'summary', status: 'missing_in_result', note: '未返回简介' }],
      {
        kind: 'video',
        supportedFields: ['summary', 'title', 'maker'],
        lastResult: { code: 'MUKD-573', title: '示例影片', maker: 'Muku' }
      },
      referencePage
    )
    assert.equal(items[0]?.status, 'ok')
    assert.match(items[0]?.note ?? '', /站点详情页模板无此字段标签/)
    assert.equal(noteSuggestsSiteUnsupportedField(items[0]?.note), true)
  })

  it('collects site-unsupported fields from verification notes', () => {
    const removed = collectSiteUnsupportedSupportedFields(
      'video',
      ['title', 'summary', 'actressesMale', 'series'],
      [
        { field: 'summary', status: 'ok', note: '站点详情页模板无此字段标签，插件留空正确' },
        { field: 'actressesMale', status: 'ok', note: '站点无此字段' },
        { field: 'series', status: 'ok', note: '页面无此字段' }
      ]
    )
    assert.deepEqual(removed, ['summary', 'actressesMale'])
  })

  it('collects supported fields to add from verified parse results', () => {
    const added = collectSupportedFieldsToAdd(
      'video',
      ['title'],
      [{ field: 'maker', status: 'ok', note: '制作商与页面一致' }],
      [{ code: 'ABC-123', title: 'T', maker: 'Studio X' }]
    )
    assert.deepEqual(added, ['maker'])
  })

  it('syncSupportedFieldsFromVerification adds and removes in create mode', () => {
    const sync = syncSupportedFieldsFromVerification({
      mode: 'create',
      kind: 'video',
      supportedFields: ['title', 'summary', 'actressesMale'],
      verificationItems: [
        { field: 'maker', status: 'ok', note: '制作商正确' },
        { field: 'summary', status: 'ok', note: '站点无此字段' },
        { field: 'actressesMale', status: 'ok', note: '站点详情页模板无此字段标签' }
      ],
      lastResults: [{ code: 'ABC-123', title: 'T', maker: 'Studio X' }]
    })
    assert.deepEqual(sync.added, ['maker'])
    assert.deepEqual(sync.removed, ['summary', 'actressesMale'])
    assert.deepEqual(sync.supportedFields, ['title', 'maker'])
  })

  it('syncSupportedFieldsFromVerification only adds in debug mode', () => {
    const sync = syncSupportedFieldsFromVerification({
      mode: 'debug',
      kind: 'video',
      supportedFields: ['title', 'summary', 'actressesMale'],
      verificationItems: [
        { field: 'maker', status: 'ok', note: '制作商正确' },
        { field: 'summary', status: 'ok', note: '站点无此字段' },
        { field: 'actressesMale', status: 'ok', note: '站点详情页模板无此字段标签' }
      ],
      lastResults: [{ code: 'ABC-123', title: 'T', maker: 'Studio X' }]
    })
    assert.deepEqual(sync.added, ['maker'])
    assert.deepEqual(sync.removed, [])
    assert.deepEqual(sync.supportedFields, ['title', 'summary', 'actressesMale', 'maker'])
  })

  it('detects breadcrumb maker/publisher link trap', () => {
    const tokyolibLinks = [
      { text: '無垢', href: '/studio/2130' },
      { text: 'MUKD', href: '/label/2992' },
      { text: 'Muku', href: '/studio/2130' },
      { text: '無垢', href: '/label/2992' }
    ]
    const items = collectMakerPublisherLinkTrapIssues(
      { maker: '無垢', publisher: 'MUKD' },
      {
        label: '调试详情页',
        url: 'https://www.tokyolib.com/v/541125',
        title: 'MUKD-573',
        text: '片商 Muku 厂牌 無垢',
        forms: [],
        links: tokyolibLinks
      }
    )

    assert.equal(items.length, 2)
    assert.equal(items.find((item) => item.field === 'maker')?.pageHint, 'Muku')
    assert.equal(items.find((item) => item.field === 'publisher')?.pageHint, '無垢')
    assert.match(items[0]?.note ?? '', /面包屑/)
  })

  it('parses semantic verification response', () => {
    const parsed = parseSemanticVerificationResponse({
      summary: '制作商和发行商语义填反',
      items: [
        {
          field: 'maker',
          status: 'suspicious',
          actual: '無垢',
          expected: 'Muku',
          note: '制作商不应取发行商名称'
        },
        {
          field: 'publisher',
          status: 'suspicious',
          actual: 'MUKD',
          expected: '無垢',
          note: '发行商不应取番号前缀'
        }
      ]
    })

    assert.equal(parsed.items.length, 2)
    assert.equal(parsed.items[0]?.pageHint, 'Muku')
    assert.match(formatVerificationForPrompt({
      referencePage: discovery.pages[0],
      items: parsed.items,
      summary: parsed.summary
    }), /用户反馈与语义不一致的字段不得视为通过/)
  })

  it('tolerates non-string actual values from semantic model', () => {
    const parsed = parseSemanticVerificationResponse({
      summary: '字段值类型不规范',
      items: [
        {
          field: 'maker',
          status: 'suspicious',
          actual: 123 as unknown as string,
          expected: 'Muku',
          note: '制作商不正确'
        }
      ]
    })

    assert.equal(parsed.items[0]?.actual, '123')
    assert.equal(parsed.items[0]?.pageHint, 'Muku')
  })

  it('drops verification failures for fields removed from supportedFields', () => {
    const items = filterVerificationItemsBySupportedFields(
      [
        { field: 'title', status: 'ok', note: '标题正确' },
        { field: 'duration', status: 'missing_in_result', note: '页面无时长' },
        { field: 'rating', status: 'missing_in_result', note: '页面无评分' },
        { field: 'series', status: 'missing_in_result', note: '页面无系列' },
        { field: 'maker', status: 'suspicious', note: '制作商疑似错误' }
      ],
      ['title', 'maker', 'cover'] as VideoScrapeField[],
      'video'
    )

    assert.equal(items.length, 2)
    assert.equal(items[0]?.field, 'title')
    assert.equal(items[1]?.field, 'maker')
  })

  it('keeps invalid_key issues even when field is not in supportedFields', () => {
    const items = filterVerificationItemsBySupportedFields(
      [{ field: 'releasedDate', status: 'invalid_key', note: '应使用 releaseDate' }],
      ['title'] as VideoScrapeField[],
      'video'
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]?.status, 'invalid_key')
  })

  it('accepts empty optional fields when reference page lacks field signals', () => {
    const page = {
      label: '调试详情页',
      url: 'https://example.com/v/123',
      title: 'MUKD-573 示例',
      text: '番号 MUKD-573 标题 示例影片 制作商 Muku 女优 皆月光',
      forms: [],
      links: [{ text: 'Muku', href: 'https://example.com/studio/muku' }]
    }

    assert.equal(pageLikelyHasFieldSignal('video', 'series', page), false)
    assert.equal(pageLikelyHasFieldSignal('video', 'director', page), false)
    assert.equal(pageLikelyHasFieldSignal('video', 'maker', page), true)

    const items = normalizeAbsentFieldVerifications(
      [
        { field: 'series', status: 'missing_in_result', note: '结果无系列' },
        { field: 'director', status: 'missing_in_result', note: '结果无导演' },
        { field: 'maker', status: 'missing_in_result', note: '结果无制作商' }
      ],
      {
        kind: 'video',
        supportedFields: ['title', 'maker', 'series', 'director'] as VideoScrapeField[],
        lastResult: { code: 'MUKD-573', title: '示例影片' }
      },
      page
    )

    assert.equal(items.find((item) => item.field === 'series')?.status, 'ok')
    assert.equal(items.find((item) => item.field === 'director')?.status, 'ok')
    assert.equal(items.find((item) => item.field === 'maker')?.status, 'missing_in_result')
    assert.equal(isBlockingVerificationFailure(items.find((item) => item.field === 'maker')!), true)
  })

  it('clears false missing_in_result when debug result already contains the field', () => {
    const page = {
      label: '调试详情页',
      url: 'https://example.com/v/123',
      title: 'MUKD-573 示例',
      text: '番号 MUKD-573 标题 示例影片 制作商 Muku',
      forms: [],
      links: [{ text: 'Muku', href: 'https://example.com/studio/muku' }]
    }

    const items = normalizeAbsentFieldVerifications(
      [{ field: 'maker', status: 'missing_in_result', note: '结果无制作商' }],
      {
        kind: 'video',
        supportedFields: ['maker'] as VideoScrapeField[],
        lastResult: { code: 'MUKD-573', maker: 'Muku' }
      },
      page
    )

    assert.equal(items[0]?.status, 'ok')
    assert.equal(isBlockingVerificationFailure(items[0]!), false)
  })

  it('still flags missing fields when page shows the field label', () => {
    const page = {
      label: '调试详情页',
      url: 'https://example.com/v/123',
      title: 'MUKD-573 示例',
      text: '番号 MUKD-573 标题 示例影片 系列 某系列名 导演 张三',
      forms: [],
      links: []
    }

    const items = normalizeAbsentFieldVerifications(
      [{ field: 'series', status: 'missing_in_result', note: '结果无系列' }],
      {
        kind: 'video',
        supportedFields: ['series'] as VideoScrapeField[],
        lastResult: { code: 'MUKD-573', title: '示例影片' }
      },
      page
    )

    assert.equal(items[0]?.status, 'missing_in_result')
  })

  it('maps actress supported field ids to parse result keys', () => {
    const result = {
      mainName: 'Alice',
      avatarUrl: 'https://example.com/a.jpg',
      heightCm: 160,
      profileSummary: 'Bio'
    }

    assert.equal(getResultValueForField('actress', 'profileSummary', result), 'Bio')
    assert.equal(getResultValueForField('actress', 'avatar', result), 'https://example.com/a.jpg')
    assert.equal(getResultValueForField('actress', 'heightCm', result), 160)
  })

  it('keeps actress debut date under the debutDate supported field', () => {
    const items = filterVerificationItemsBySupportedFields(
      [{ field: 'debutDate', status: 'missing_in_result', note: '结果无出道日期' }],
      ['debutDate'] as ActressScrapeField[],
      'actress'
    )

    assert.equal(items.length, 1)
    assert.equal(items[0]?.field, 'debutDate')
  })

  it('does not clear a missing concrete actress profile field with mainName only', () => {
    const page = {
      label: '资料页',
      url: 'https://example.com/actress/alice',
      title: 'Alice 资料',
      text: 'Alice 个人简介 出道日期 2020-01-02',
      forms: [],
      links: []
    }

    const items = normalizeAbsentFieldVerifications(
      [
        { field: 'profileSummary', status: 'missing_in_result', note: '结果无简介' },
        { field: 'debutDate', status: 'missing_in_result', note: '结果无出道日期' }
      ],
      {
        kind: 'actress',
        supportedFields: ['profileSummary', 'debutDate'] as ActressScrapeField[],
        lastResult: { mainName: 'Alice' }
      },
      page
    )

    assert.equal(items.find((item) => item.field === 'profileSummary')?.status, 'missing_in_result')
    assert.equal(items.find((item) => item.field === 'debutDate')?.status, 'missing_in_result')
  })

  it('accepts empty actress optional fields when reference page lacks field signals', () => {
    const page = {
      label: '资料页',
      url: 'https://example.com/actress/alice',
      title: 'Alice 资料',
      text: 'Alice 简介 个人资料',
      forms: [],
      links: []
    }

    assert.equal(pageLikelyHasFieldSignal('actress', 'gallery', page), false)
    assert.equal(pageLikelyHasFieldSignal('actress', 'profileSummary', page), true)

    const items = normalizeAbsentFieldVerifications(
      [
        { field: 'gallery', status: 'missing_in_result', note: '结果无写真' },
        { field: 'profileSummary', status: 'missing_in_result', note: '结果无简介' }
      ],
      {
        kind: 'actress',
        supportedFields: ['profileSummary', 'gallery'] as ActressScrapeField[],
        lastResult: { mainName: 'Alice', profileSummary: 'Bio' }
      },
      page
    )

    assert.equal(items.find((item) => item.field === 'gallery')?.status, 'ok')
    assert.equal(items.find((item) => item.field === 'profileSummary')?.status, 'ok')
    assert.equal(
      isBlockingVerificationFailure(items.find((item) => item.field === 'profileSummary')!),
      false
    )
  })

  it('pageMatchesActressTarget matches target or result names in page text', () => {
    const page = {
      label: '资料页',
      url: 'https://example.com/model/123',
      title: '河北彩花 - 资料',
      text: '河北彩花 生日 1998',
      forms: [],
      links: []
    }
    assert.equal(pageMatchesActressTarget(page, '河北彩花'), true)
    assert.equal(
      pageMatchesActressTarget(page, '三上悠亚', { mainName: '三上悠亚', nameZh: '三上悠亚' }),
      false
    )
  })

  it('skips semantic field compare when actress reference page does not match target', async () => {
    const report = await verifyDebugResultAgainstPages({
      kind: 'actress',
      testTarget: '三上悠亚',
      supportedFields: ['gallery', 'profileSummary'] as ActressScrapeField[],
      lastResult: {
        mainName: '三上悠亚',
        galleryImageUrls: ['https://example.com/a.jpg']
      },
      discovery: {
        pages: [
          {
            label: '验证参考页',
            url: 'https://example.com/model/kawakita',
            title: '河北彩花 - 资料',
            text: '河北彩花 写真',
            forms: [],
            links: []
          }
        ],
        notes: []
      }
    })

    assert.equal(report.items.length, 1)
    assert.equal(report.items[0]?.field, 'reference_page')
    assert.match(report.summary, /不匹配/)
    assert.doesNotMatch(report.summary, /gallery/)
  })

  it('actress semantic prompt warns against using wrong actress reference page', () => {
    const prompt = buildSemanticVerificationPrompt(
      {
        kind: 'actress',
        testTarget: '三上悠亚',
        supportedFields: ['gallery'],
        lastResult: { mainName: '三上悠亚' },
        discovery: {
          pages: [
            {
              label: '资料页',
              url: 'https://example.com/a',
              title: '三上悠亚',
              text: '写真',
              forms: [],
              links: []
            }
          ],
          notes: []
        }
      },
      {
        label: '资料页',
        url: 'https://example.com/a',
        title: '三上悠亚',
        text: '写真',
        forms: [],
        links: []
      }
    )
    assert.match(prompt, /参考页面必须是上述测试演员的资料页/)
  })
})
