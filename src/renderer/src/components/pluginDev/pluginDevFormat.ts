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
    case 'browser_fetch_page':
      return '打开页面'
    case 'browser_inspect':
      return '检查结构'
    case 'browser_html':
      return '读取 HTML'
    case 'browser_evaluate':
      return '页面探测'
    case 'browser_click':
      return '点击页面'
    case 'browser_type':
      return '输入文本'
    case 'browser_press':
      return '按键'
    case 'browser_wait':
      return '等待页面'
    case 'browser_status':
      return '检查浏览器'
    case 'plugin_get_state':
      return '读取插件状态'
    case 'plugin_update_code':
      return '更新代码'
    case 'plugin_update_package':
      return '更新元数据'
    case 'plugin_dry_run':
      return '运行调试'
    case 'plugin_verify':
      return '语义验证'
    case 'plugin_install':
      return '安装插件'
    case 'plugin_finish':
      return '结束任务'
    case 'session_note':
      return '记录笔记'
    case 'session_request_user':
      return '请求用户操作'
    default:
      return tool
  }
}

export function toolCategory(tool?: string): 'browser' | 'plugin' | 'session' | 'other' {
  if (!tool) return 'other'
  if (tool.startsWith('browser_')) return 'browser'
  if (tool.startsWith('plugin_')) return 'plugin'
  if (tool.startsWith('session_')) return 'session'
  return 'other'
}
