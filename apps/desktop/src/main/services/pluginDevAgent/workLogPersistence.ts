import type { PluginDevAgentWorkLogEntry } from '@shared/pluginDevTypes'
import { agentRunStore, type AgentRunStore } from '../../agent-platform/agentRunStore'

const EVENT_TYPE = 'plugin.work_log_entry'
export interface PluginWorkLogReference {
  format: 'journal-v1'
  afterSeq: number
  throughSeq: number
  count: number
}
export type PersistedPluginWorkLog = PluginDevAgentWorkLogEntry[] | PluginWorkLogReference

function validateReference(value: PluginWorkLogReference): void {
  if (value?.format !== 'journal-v1' ||
    ![value.afterSeq, value.throughSeq, value.count].every((number) => Number.isSafeInteger(number) && number >= 0) ||
    value.throughSeq < value.afterSeq ||
    (value.count === 0) !== (value.throughSeq === value.afterSeq)) {
    throw new Error('Invalid plugin work log reference')
  }
}

/** Must run inside the same transaction as the new product state. */
export function appendPluginWorkLog(
  runId: string,
  previous: PersistedPluginWorkLog | undefined,
  entries: readonly PluginDevAgentWorkLogEntry[],
  store: AgentRunStore = agentRunStore
): PluginWorkLogReference {
  const legacy = previous === undefined || Array.isArray(previous)
  const reference: PluginWorkLogReference = legacy
    ? { format: 'journal-v1', afterSeq: store.getProductJournalCursor(runId), throughSeq: 0, count: 0 }
    : { ...previous }
  if (legacy) {
    reference.throughSeq = reference.afterSeq
    if (Array.isArray(previous) && (entries.length < previous.length ||
      previous.some((entry, index) => JSON.stringify(entry) !== JSON.stringify(entries[index])))) {
      throw new Error('Legacy plugin work log prefix changed')
    }
  }
  validateReference(reference)
  if (entries.length < reference.count) throw new Error('Plugin work log cannot shrink')
  for (let index = reference.count; index < entries.length; index++) {
    reference.throughSeq = store.appendProductEvent(runId, undefined, EVENT_TYPE, { index, entry: entries[index] })
    reference.count++
  }
  validateReference(reference)
  return reference
}

export function readPluginWorkLog(
  runId: string,
  value: PersistedPluginWorkLog | undefined,
  store: AgentRunStore = agentRunStore
): PluginDevAgentWorkLogEntry[] {
  if (value === undefined) return []
  if (Array.isArray(value)) return structuredClone(value)
  validateReference(value)
  const entries: PluginDevAgentWorkLogEntry[] = []
  let cursor = value.afterSeq
  while (cursor < value.throughSeq) {
    const page = store.readProductJournal<{ index: number; entry: PluginDevAgentWorkLogEntry }>(runId, cursor, 500, value.throughSeq)
    if (page.length === 0) throw new Error('Plugin work log journal is incomplete')
    for (const record of page) {
      if (record.seq > value.throughSeq) break
      cursor = record.seq
      if (record.eventType !== EVENT_TYPE) continue
      if (record.payload.index !== entries.length || !record.payload.entry ||
        !['event', 'user_message'].includes(record.payload.entry.kind)) {
        throw new Error('Invalid plugin work log entry')
      }
      entries.push(record.payload.entry)
    }
    if (page.at(-1)!.seq > value.throughSeq && cursor !== value.throughSeq) {
      throw new Error('Plugin work log journal endpoint is missing')
    }
  }
  if (entries.length !== value.count) throw new Error('Plugin work log entry count mismatch')
  return entries
}
