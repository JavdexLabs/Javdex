/**
 * Shared Agent browser-evidence seam.
 *
 * The implementation currently lives beside PluginDeveloper for compatibility, but its Interface
 * is product-neutral and is also used by metadata collection. Keeping this indirection here avoids
 * coupling new Agent use cases to PluginDeveloper session state.
 */
export {
  PluginBrowserCapabilityModule as AgentBrowserEvidenceModule,
  boundedJson,
  browserCapabilityResultLimitBytes,
  readBrowserArtifactBundle,
  truncateUtf8,
  type BrowserCapabilityInput,
  type PluginBrowserAction as AgentEvidenceBrowserAction
} from '../services/pluginDevAgent/browserCapability'
