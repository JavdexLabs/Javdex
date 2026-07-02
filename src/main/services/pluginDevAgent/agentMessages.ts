/** Protocol-neutral agent conversation model used by runner, compression, and session storage. */

export interface AgentToolCall {
  id: string
  name: string
  /** JSON object serialized as string. */
  arguments: string
}

export interface AgentToolResult {
  callId: string
  content: string
  isError?: boolean
}

export type AgentTurn =
  | { kind: 'system'; text: string }
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text?: string | null; toolCalls?: AgentToolCall[] }
  | { kind: 'toolResults'; results: AgentToolResult[] }

export type AgentTranscript = AgentTurn[]

export interface AgentLlmUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface AgentLlmResponse {
  text: string | null
  toolCalls?: AgentToolCall[]
  finishReason?: string
  usage?: AgentLlmUsage
}

export function systemTurn(text: string): AgentTurn {
  return { kind: 'system', text }
}

export function userTurn(text: string): AgentTurn {
  return { kind: 'user', text }
}

export function assistantTurn(
  text: string | null | undefined,
  toolCalls?: AgentToolCall[]
): AgentTurn {
  const normalized = toolCalls?.length ? toolCalls : undefined
  return {
    kind: 'assistant',
    ...(text != null ? { text } : {}),
    ...(normalized ? { toolCalls: normalized } : {})
  }
}

export function toolResultsTurn(results: AgentToolResult[]): AgentTurn {
  return { kind: 'toolResults', results }
}

export function singleToolResult(callId: string, content: string, isError?: boolean): AgentTurn {
  return toolResultsTurn([{ callId, content, ...(isError ? { isError: true } : {}) }])
}

/** Merge consecutive tool result turns into one batch per API round-trip. */
export function coalesceToolResultTurns(transcript: AgentTranscript): AgentTranscript {
  const out: AgentTranscript = []
  for (const turn of transcript) {
    if (turn.kind !== 'toolResults') {
      out.push(turn)
      continue
    }
    const prev = out[out.length - 1]
    if (prev?.kind === 'toolResults') {
      prev.results.push(...turn.results)
    } else {
      out.push({ kind: 'toolResults', results: [...turn.results] })
    }
  }
  return out
}

export function getSystemText(transcript: AgentTranscript): string {
  return transcript
    .filter((turn): turn is Extract<AgentTurn, { kind: 'system' }> => turn.kind === 'system')
    .map((turn) => turn.text)
    .join('\n\n')
}

export function collectToolNamesById(transcript: AgentTranscript): Map<string, string> {
  const names = new Map<string, string>()
  for (const turn of transcript) {
    if (turn.kind !== 'assistant' || !turn.toolCalls?.length) continue
    for (const call of turn.toolCalls) {
      names.set(call.id, call.name)
    }
  }
  return names
}

export function ensureToolResultResponses(transcript: AgentTranscript): AgentTranscript {
  const out: AgentTranscript = []
  let index = 0

  while (index < transcript.length) {
    const turn = transcript[index]
    if (turn.kind === 'assistant' && turn.toolCalls?.length) {
      out.push(turn)
      const pending = new Map(turn.toolCalls.map((call) => [call.id, call.name]))
      index += 1

      if (index < transcript.length && transcript[index].kind === 'toolResults') {
        const resultsTurn = transcript[index] as Extract<AgentTurn, { kind: 'toolResults' }>
        out.push(resultsTurn)
        for (const result of resultsTurn.results) {
          pending.delete(result.callId)
        }
        index += 1
      }

      if (pending.size > 0) {
        out.push(
          toolResultsTurn(
            [...pending.keys()].map((callId) => ({
              callId,
              content: '（工具未执行：会话在并行调用中提前结束）'
            }))
          )
        )
      }
      continue
    }

    out.push(turn)
    index += 1
  }

  return coalesceToolResultTurns(out)
}

export function appendSkippedToolResults(
  toolCalls: AgentToolCall[],
  startIndex: number,
  reason: string
): AgentTurn {
  return toolResultsTurn(
    toolCalls.slice(startIndex).map((call) => ({
      callId: call.id,
      content: reason
    }))
  )
}

export function countTranscriptChars(transcript: AgentTranscript): number {
  let total = 0
  for (const turn of transcript) {
    total += turn.kind.length
    if (turn.kind === 'system' || turn.kind === 'user') {
      total += turn.text.length
    } else if (turn.kind === 'assistant') {
      total += turn.text?.length ?? 0
      for (const call of turn.toolCalls ?? []) {
        total += call.id.length + call.name.length + call.arguments.length
      }
    } else {
      for (const result of turn.results) {
        total += result.callId.length + result.content.length
      }
    }
  }
  return total
}

export function turnWithCompactedText(
  turn: AgentTurn,
  limit: number,
  compact: (text: string, limit: number) => string
): AgentTurn {
  if (turn.kind === 'system' || turn.kind === 'user') {
    const text = compact(turn.text, limit)
    return text === turn.text ? turn : { ...turn, text }
  }
  if (turn.kind === 'assistant') {
    const text = turn.text != null ? compact(turn.text, limit) : turn.text
    return text === turn.text ? turn : { ...turn, text }
  }
  if (turn.kind === 'toolResults') {
    const results = turn.results.map((result) => {
      const content = compact(result.content, limit)
      return content === result.content ? result : { ...result, content }
    })
    return results.every((result, index) => result === turn.results[index])
      ? turn
      : { kind: 'toolResults', results }
  }
  return turn
}

export function compactAssistantToolArgs(
  turn: Extract<AgentTurn, { kind: 'assistant' }>,
  limit: number,
  compact: (text: string, limit: number) => string
): Extract<AgentTurn, { kind: 'assistant' }> {
  if (!turn.toolCalls?.length) return turn
  let changed = false
  const toolCalls = turn.toolCalls.map((call) => {
    if (call.arguments.length <= limit) return call
    changed = true
    return {
      ...call,
      arguments: JSON.stringify({
        _compressed: `arguments 已按上下文预算压缩，原始 ${call.arguments.length} 字符`,
        preview: compact(call.arguments, limit)
      })
    }
  })
  return changed ? { ...turn, toolCalls } : turn
}

export function responseToAssistantTurn(response: AgentLlmResponse): AgentTurn {
  return assistantTurn(response.text, response.toolCalls)
}
