import type { ModelManagementSnapshot } from '@shared/modelManagementTypes'

export function modelConnectionName(
  snapshot: ModelManagementSnapshot,
  connectionId: string
): string {
  return snapshot.connections.find((item) => item.id === connectionId)?.name ?? '未知提供商'
}
