import type { PluginDevPageInsight } from '@shared/types'

export function formatPageDomForPrompt(page: PluginDevPageInsight): string {
  const sections: string[] = []

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
  const dom = formatPageDomForPrompt(page)
  const links = formatPageLinksForPrompt(page, options?.linkLimit ?? 30)

  return `【${page.label}】
URL: ${page.url}
TITLE: ${page.title}
TEXT: ${page.text.slice(0, textLimit)}
${dom ? `${dom}\n` : ''}FORMS_AND_INTERACTIVE_INPUTS:
${forms || '无'}
LINKS（含 region=breadcrumb|metadata|other，metadata 区链接优先用于字段解析）:
${links || '无'}`
}
