/**
 * PluginDeveloper compatibility surface for the shared Agent browser-evidence module.
 * Product-neutral implementation belongs to agent-platform so other Agent use cases do not
 * depend on PluginDeveloper internals.
 */
export {
  AgentBrowserEvidenceModule as PluginBrowserCapabilityModule,
  agentBrowserEvidence as pluginBrowserCapability,
  boundedJson,
  browserCapabilityResultLimitBytes,
  readBrowserArtifactBundle,
  truncateUtf8,
  type AgentEvidenceBrowserAction as PluginBrowserAction,
  type BrowserArtifactSectionInput,
  type BrowserCapabilityInput
} from '../../agent-platform/agentBrowserEvidence'
