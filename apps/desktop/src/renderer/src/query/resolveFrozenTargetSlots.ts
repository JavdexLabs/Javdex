export type FrozenTargetSlot<T extends { id: number }> =
  | { id: number; status: 'ready'; value: T }
  | { id: number; status: 'missing' }
  | { id: number; status: 'error'; message: string }

/** Keep frozen ids in place. Deleted rows become missing slots instead of compacting the page. */
export async function resolveFrozenTargetSlots<T extends { id: number }>(
  ids: number[],
  readOne: (id: number) => Promise<T | null>
): Promise<Array<FrozenTargetSlot<T>>> {
  const slots: Array<FrozenTargetSlot<T>> = []
  for (const id of ids) {
    try {
      const value = await readOne(id)
      slots.push(value == null ? { id, status: 'missing' } : { id, status: 'ready', value })
    } catch (error) {
      slots.push({
        id,
        status: 'error',
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return slots
}
