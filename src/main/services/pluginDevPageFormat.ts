import type { PluginDevPageInsight } from '@shared/pluginDevTypes'
import { truncateUnicode } from '@shared/unicodeText'

export function formatPageDomForPrompt(page: PluginDevPageInsight): string {
  const sections: string[] = []

  if (page.structuredData?.length) {
    sections.push(
      `STRUCTURED_DATA（JSON-LD）：\n${page.structuredData
        .map((item) => `- ${item.key} => ${item.value} selector=${item.selector}`)
        .join('\n')}`
    )
  }

  if (page.metadataTags?.length) {
    sections.push(
      `METADATA_TAGS（OpenGraph/Twitter/itemprop）：\n${page.metadataTags
        .map((item) => `- ${item.key} => ${item.content}`)
        .join('\n')}`
    )
  }

  if (page.labeledRows?.length) {
    sections.push(
      `LABELED_ROWS（页面标签行，含稳定 selector 与链接）：\n${page.labeledRows
        .map((row) => {
          const links = row.links.length ? ` links=${row.links.join(', ')}` : ''
          return `- ${row.label} => ${row.value} selector=${row.selector}${links}`
        })
        .join('\n')}`
    )
  }

  if (page.definitionLists?.length) {
    const lines = page.definitionLists.map((list) => {
      const items = list.items
        .map((item) => {
          const html = item.valueHtml ? `\n    html: ${item.valueHtml}` : ''
          return `  - ${item.term} => ${item.value}${html}`
        })
        .join('\n')
      return `${list.selector}:\n${items}`
    })
    sections.push(
      `DEFINITION_LISTS（dl/dd/dt 键值对，字段解析应优先依据此处，而非面包屑或正文搜索）：\n${lines.join('\n\n')}`
    )
  }

  if (page.domRegions?.length) {
    const lines = page.domRegions.map(
      (region) =>
        `[${region.label}] ${region.selector}\n${region.html}`
    )
    sections.push(
      `DOM_REGIONS（关键区域原始 HTML，保留标签层级；同路径链接在不同区域含义可能不同）：\n${lines.join('\n\n')}`
    )
  }

  return sections.join('\n\n')
}

export function formatPageLinksForPrompt(page: PluginDevPageInsight, limit = 30): string {
  return page.links
    .slice(0, limit)
    .map((link) => {
      const region = link.region ? ` region=${link.region}` : ''
      const parent = link.parentSelector ? ` parent=${link.parentSelector}` : ''
      return `- ${link.text || '(no text)'} -> ${link.href}${region}${parent}`
    })
    .join('\n')
}

export function formatPageInsightForPrompt(
  page: PluginDevPageInsight,
  options?: { textLimit?: number; linkLimit?: number }
): string {
  const textLimit =
    options?.textLimit ??
    (page.label.includes('详情') || page.label.includes('调试') ? 2800 : 1200)
  const forms = page.forms
    .map(
      (form) => {
        const kind = form.method === 'interactive' ? 'interactive-inputs' : 'form'
        const hint =
          form.method === 'interactive'
            ? ' hint=非表单输入，通常由脚本/AJAX 处理；操作后检查 DOM，不要只看 URL'
            : ''
        return `${kind} ${form.selector} method=${form.method || ''} action=${form.action || ''}${hint}\n` +
        `  inputs: ${form.inputs
          .map(
            (input) =>
              `${input.selector}{name=${input.name || ''},type=${input.type || ''},placeholder=${
                input.placeholder || ''
              }}`
          )
          .join(' | ')}\n` +
        `  buttons: ${form.buttons
          .map((button) => `${button.selector}{text=${button.text},type=${button.type || ''}}`)
          .join(' | ')}`
      }
    )
    .join('\n')
  const structuredDom = formatPageDomForPrompt({ ...page, domRegions: undefined })
  const regionDom = page.domRegions?.length
    ? formatPageDomForPrompt({
        ...page,
        metadataTags: undefined,
        structuredData: undefined,
        labeledRows: undefined,
        definitionLists: undefined
      })
    : ''
  const links = formatPageLinksForPrompt(page, options?.linkLimit ?? 30)

  return truncateUnicode(`【${page.label}】
URL: ${page.url}
TITLE: ${page.title}
TEXT: ${page.text.slice(0, textLimit)}
FORMS_AND_INTERACTIVE_INPUTS:
${truncateUnicode(forms || '无', 2400, '…')}
LINKS（含 region=breadcrumb|metadata|other，metadata 区链接优先用于字段解析）:
${truncateUnicode(links || '无', 3200, '…')}
${structuredDom ? `${truncateUnicode(structuredDom, 3600, '…')}\n` : ''}
${regionDom ? truncateUnicode(regionDom, 2400, '…') : ''}`, 12_000, '…')
}
