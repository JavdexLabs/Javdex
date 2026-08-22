import { LIBRARY_CURATOR_TOOL_PACK } from './libraryCuratorToolPack'
import { toolHost } from './toolHost'
import { PLUGIN_DEVELOPER_TOOL_PACK } from '../services/pluginDevAgent/toolPack'

let initialized = false

export function initializeAgentPlatform(): void {
  if (initialized) return
  toolHost.registerToolPack(PLUGIN_DEVELOPER_TOOL_PACK)
  toolHost.registerToolPack(LIBRARY_CURATOR_TOOL_PACK)
  initialized = true
}
