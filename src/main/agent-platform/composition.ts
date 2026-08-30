import { LIBRARY_CURATOR_TOOL_PACK } from './libraryCuratorToolPack'
import { toolHost } from './toolHost'
import { PLUGIN_DEVELOPER_TOOL_PACK } from '../services/pluginDevAgent/toolPack'
import { AGENT_METADATA_COLLECTOR_TOOL_PACK } from '../services/agentMetadata/toolPack'
import { PLAYLIST_IMPORTER_TOOL_PACK } from '../services/playlistImport/toolPack'

let initialized = false

export function initializeAgentPlatform(): void {
  if (initialized) return
  toolHost.registerToolPack(PLUGIN_DEVELOPER_TOOL_PACK)
  toolHost.registerToolPack(LIBRARY_CURATOR_TOOL_PACK)
  toolHost.registerToolPack(AGENT_METADATA_COLLECTOR_TOOL_PACK)
  toolHost.registerToolPack(PLAYLIST_IMPORTER_TOOL_PACK)
  initialized = true
}
