import type { BatchProgress } from '@shared/batchScrapeTypes'
import type { ScraperPluginDelay, ScraperPluginDescriptor } from '@shared/scraperPluginTypes'
import type { WebAccessStatus } from '@shared/webTypes'

export function batchStatusLabel(status: BatchProgress['status'] | undefined): string {
  if (status === 'running') return '进行中'
  if (status === 'paused') return '已暂停'
  if (status === 'done') return '已完成'
  if (status === 'cancelled') return '已终止'
  return '空闲'
}

export function defaultPluginDelay(delay?: ScraperPluginDelay): ScraperPluginDelay {
  return delay ?? { minMs: 3000, maxMs: 5000 }
}

export function pluginSourceLabel(plugin: ScraperPluginDescriptor): string {
  if (plugin.source === 'builtin') return '内置'
  if (plugin.source === 'composite') return '组合'
  return '自定义'
}

/** Middle-ellipsis path for dense settings summaries. */
export function formatCompactPath(path: string, maxLen = 34): string {
  const normalized = path.trim().replace(/\\/g, '/')
  if (normalized.length <= maxLen) return normalized
  const head = Math.ceil((maxLen - 1) / 2)
  const tail = Math.floor((maxLen - 1) / 2)
  return `${normalized.slice(0, head)}…${normalized.slice(-tail)}`
}

export function formatMediaAssetsPathLabel(resolvedPath: string, usingDefault: boolean): string {
  const folder = resolvedPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? resolvedPath
  if (usingDefault) return `默认目录 · ${folder}`
  return formatCompactPath(resolvedPath)
}

export function preferredWebAccessUrl(urls: string[]): string {
  return urls.find((value) => !value.includes('127.0.0.1')) || urls[0] || ''
}

export function compactWebAccessUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const endpoint = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname
    const loopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
    return loopback ? `仅本机 · ${endpoint}` : endpoint
  } catch {
    return url.replace(/^https?:\/\//i, '')
  }
}

export function webAccessOverviewStatus(input: {
  status: WebAccessStatus | null
  error: string | null
}): { value: string; detail: string; attention: boolean; hint?: string } {
  if (!input.status) {
    if (input.error) {
      return { value: '读取失败', detail: input.error, attention: true }
    }
    return { value: '读取中…', detail: '正在读取服务状态', attention: false }
  }

  if (input.status.running) {
    const url = preferredWebAccessUrl(input.status.urls)
    return {
      value: '运行中',
      detail: url ? compactWebAccessUrl(url) : `端口 ${input.status.port}`,
      attention: false,
      hint: url || undefined
    }
  }

  if (input.status.error) {
    return { value: '启动失败', detail: input.status.error, attention: true }
  }

  if (input.status.enabled) {
    return { value: '已关闭', detail: '服务未运行', attention: true }
  }

  return { value: '已关闭', detail: '未启用', attention: false }
}
