import type { AgentRuntimePort } from '../agent-platform/types'

/** Pi is loaded only when an Agent run is opened, never on the default application startup path. */
export async function createPiRuntimePort(): Promise<AgentRuntimePort> {
  const module = await import('./pi/piRuntime')
  return module.createPiRuntimePort()
}
