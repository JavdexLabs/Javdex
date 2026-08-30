export function formatDebugJson(value: unknown): string {
  if (value === undefined || value === null) return '无'
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function formatToolLabel(tool?: string): string {
  if (!tool) return '工具'
  switch (tool) {
    case 'browser':
      return '浏览器操作'
    case 'plugin_dry_run':
      return '试运行'
    case 'workspace_validate':
      return '工作区校验'
    case 'ask_user':
      return '请求用户决定'
    case 'read':
      return '读取文件'
    case 'write':
      return '写入文件'
    case 'edit':
      return '编辑文件'
    case 'grep':
    case 'find':
    case 'ls':
      return '查找文件'
    default:
      return tool
  }
}

export function toolCategory(tool?: string): 'browser' | 'plugin' | 'session' | 'other' {
  if (!tool) return 'other'
  if (tool === 'browser') return 'browser'
  if (
    tool === 'plugin_dry_run' ||
    tool === 'workspace_validate' ||
    ['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(tool)
  ) {
    return 'plugin'
  }
  if (tool === 'ask_user') return 'session'
  return 'other'
}
