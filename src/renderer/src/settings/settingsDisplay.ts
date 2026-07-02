import type { BatchProgress, ScraperPluginDelay, ScraperPluginDescriptor } from '@shared/types'

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
