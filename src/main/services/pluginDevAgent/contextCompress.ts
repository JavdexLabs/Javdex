import type { AgentTranscript, AgentTurn } from './agentMessages'
import {
  collectToolNamesById,
  compactAssistantToolArgs,
  countTranscriptChars,
  ensureToolResultResponses,
  turnWithCompactedText,
  userTurn
} from './agentMessages'
import type { PluginDevAgentContextStats } from '@shared/types'

const HTML_TOOL_NAMES = new Set(['browser_html', 'browser_inspect'])

const SOFT_CONTEXT_RATIO = 0.72
const RECENT_MESSAGE_COUNT = 32

const TOOL_CONTENT_LIMITS: Record<string, { fresh: number; old: number }> = {
  browser_html: { fresh: 6000, old: 1800 },
  browser_inspect: { fresh: 7000, old: 3600 },
  browser_evaluate: { fresh: 4000, old: 1200 },
  plugin_dry_run: { fresh: 3200, old: 1400 },
  plugin_verify: { fresh: 4200, old: 2600 },
  plugin_get_state: { fresh: 16000, old: 4000 }
}

function compactText(content: string, limit: number): string {
  if (content.length <= limit) return content
  const headLength = Math.max(200, Math.floor(limit * 0.7))
  const tailLength = Math.max(120, limit - headLength - 80)
  return `${content.slice(0, headLength)}\n…（已压缩，原始 ${content.length} 字符）…\n${content.slice(-tailLength)}`
}

function estimateTokensForChars(chars: number): number {
  return Math.ceil(chars / 4)
}

function compactToolResultsTurn(
  turn: Extract<AgentTurn, { kind: 'toolResults' }>,
  toolNames: Map<string, string>,
  isTail: boolean
): Extract<AgentTurn, { kind: 'toolResults' }> {
  const results = turn.results.map((result) => {
    const toolName = toolNames.get(result.callId)
    const limits = toolName ? TOOL_CONTENT_LIMITS[toolName] : undefined
    const limit = limits ? (isTail ? limits.fresh : limits.old) : isTail ? 6000 : 1200
    const content = compactText(result.content, limit)
    return content === result.content ? result : { ...result, content }
  })
  return results.every((result, index) => result === turn.results[index])
    ? turn
    : { kind: 'toolResults', results }
}

export function compressTranscriptIfNeeded(transcript: AgentTranscript, step: number): AgentTranscript {
  const repaired = ensureToolResultResponses(transcript)
  const toolNames = collectToolNamesById(repaired)
  const keepTail = step <= 6 ? 18 : 24

  const compressed = repaired.map((turn, index) => {
    if (turn.kind !== 'toolResults') return turn
    const isTail = index >= repaired.length - keepTail
    return compactToolResultsTurn(turn, toolNames, isTail)
  })

  return ensureToolResultResponses(compressed)
}

function compactForBudget(transcript: AgentTranscript): AgentTranscript {
  const tailStart = Math.max(0, transcript.length - 12)
  return transcript.map((turn, index) => {
    const fresh = index >= tailStart
    if (turn.kind === 'system') return turnWithCompactedText(turn, fresh ? 12000 : 8000, compactText)
    if (turn.kind === 'assistant') {
      return compactAssistantToolArgs(
        turnWithCompactedText(turn, fresh ? 3000 : 900, compactText) as Extract<
          AgentTurn,
          { kind: 'assistant' }
        >,
        fresh ? 5000 : 800,
        compactText
      )
    }
    if (turn.kind === 'toolResults') {
      return turnWithCompactedText(turn, fresh ? 2500 : 600, compactText)
    }
    return turnWithCompactedText(turn, fresh ? 3000 : 1000, compactText)
  })
}

function compactForBalancedBudget(transcript: AgentTranscript): AgentTranscript {
  const toolNames = collectToolNamesById(transcript)
  const tailStart = Math.max(0, transcript.length - RECENT_MESSAGE_COUNT)
  return ensureToolResultResponses(
    transcript.map((turn, index) => {
      const fresh = index >= tailStart
      if (turn.kind === 'system') return turnWithCompactedText(turn, fresh ? 18000 : 12000, compactText)
      if (turn.kind === 'assistant') {
        return compactAssistantToolArgs(
          turnWithCompactedText(turn, fresh ? 6000 : 1800, compactText) as Extract<
            AgentTurn,
            { kind: 'assistant' }
          >,
          fresh ? 9000 : 2400,
          compactText
        )
      }
      if (turn.kind === 'toolResults') {
        return compactToolResultsTurn(turn, toolNames, fresh)
      }
      return turnWithCompactedText(turn, fresh ? 5000 : 1800, compactText)
    })
  )
}

type TurnGroup = {
  turns: AgentTranscript
  key: 'system' | 'initial' | 'normal'
}

function groupTurns(transcript: AgentTranscript): TurnGroup[] {
  const groups: TurnGroup[] = []
  let initialUserSeen = false

  for (let index = 0; index < transcript.length; index += 1) {
    const turn = transcript[index]
    if (turn.kind === 'assistant' && turn.toolCalls?.length) {
      const grouped: AgentTranscript = [turn]
      index += 1
      if (index < transcript.length && transcript[index].kind === 'toolResults') {
        grouped.push(transcript[index])
        index += 1
      }
      index -= 1
      groups.push({ key: 'normal', turns: grouped })
      continue
    }
    if (turn.kind === 'system') {
      groups.push({ key: 'system', turns: [turn] })
      continue
    }
    const key = turn.kind === 'user' && !initialUserSeen ? 'initial' : 'normal'
    if (turn.kind === 'user') initialUserSeen = true
    groups.push({ key, turns: [turn] })
  }

  return groups
}

function flattenGroups(groups: TurnGroup[]): AgentTranscript {
  return groups.flatMap((group) => group.turns)
}

function groupChars(group: TurnGroup): number {
  return countTranscriptChars(group.turns)
}

function makeBudgetSummary(droppedGroups: number, droppedMessages: number): AgentTurn {
  return userTurn(
    `较早上下文已按最大上下文预算裁剪：移除 ${droppedGroups} 组 / ${droppedMessages} 条旧消息。` +
      '请优先依据当前插件状态、最近页面探测、最近 dry-run 和 verify 继续。必要时调用 plugin_get_state。'
  )
}

export function fitTranscriptToContextBudget(
  transcript: AgentTranscript,
  step: number,
  maxTokens: number,
  totalTokens = 0
): { transcript: AgentTranscript; stats: PluginDevAgentContextStats } {
  const budgetTokens = Math.max(8000, Math.round(maxTokens))
  const budgetChars = budgetTokens * 4
  const lightlyCompressed = compressTranscriptIfNeeded(transcript, step)
  const lightTokens = estimateTokensForChars(countTranscriptChars(lightlyCompressed))

  if (lightTokens <= budgetTokens * SOFT_CONTEXT_RATIO) {
    return {
      transcript: lightlyCompressed,
      stats: summarizeContextStats(transcript, lightlyCompressed, budgetTokens, totalTokens)
    }
  }

  const balanced = compactForBalancedBudget(lightlyCompressed)
  if (countTranscriptChars(balanced) <= budgetChars) {
    return {
      transcript: balanced,
      stats: summarizeContextStats(transcript, balanced, budgetTokens, totalTokens)
    }
  }

  const compressed = compactForBudget(balanced)
  if (countTranscriptChars(compressed) <= budgetChars) {
    return {
      transcript: compressed,
      stats: summarizeContextStats(transcript, compressed, budgetTokens, totalTokens)
    }
  }

  const groups = groupTurns(compressed)
  const systemGroups = groups.filter((group) => group.key === 'system')
  const initialGroup = groups.find((group) => group.key === 'initial')
  const normalGroups = groups.filter((group) => group.key === 'normal')
  const keptTail: TurnGroup[] = []
  const baseGroups: TurnGroup[] = [
    ...systemGroups,
    ...(initialGroup
      ? [{
          key: 'initial' as const,
          turns: initialGroup.turns.map((turn) => turnWithCompactedText(turn, 1600, compactText))
        }]
      : [])
  ]
  const summaryReserve = 600
  let usedChars = baseGroups.reduce((sum, group) => sum + groupChars(group), 0) + summaryReserve

  for (let index = normalGroups.length - 1; index >= 0; index -= 1) {
    const group = normalGroups[index]
    const chars = groupChars(group)
    if (usedChars + chars > budgetChars && keptTail.length > 0) break
    if (usedChars + chars > budgetChars) {
      const compacted: TurnGroup = {
        key: 'normal',
        turns: group.turns.map((turn) => turnWithCompactedText(turn, 800, compactText))
      }
      const compactedChars = groupChars(compacted)
      if (usedChars + compactedChars <= budgetChars) {
        keptTail.unshift(compacted)
        usedChars += compactedChars
      }
      break
    }
    keptTail.unshift(group)
    usedChars += chars
  }

  const keptSet = new Set<TurnGroup>([...systemGroups, ...(initialGroup ? [initialGroup] : []), ...keptTail])
  const droppedGroups = groups.filter((group) => !keptSet.has(group))
  const summary = makeBudgetSummary(
    droppedGroups.length,
    droppedGroups.reduce((sum, group) => sum + group.turns.length, 0)
  )
  let fitted = ensureToolResultResponses(
    flattenGroups([...baseGroups, { key: 'normal', turns: [summary] }, ...keptTail])
  )

  if (estimateTokensForChars(countTranscriptChars(fitted)) > budgetTokens) {
    fitted = fitted.map((turn, index) =>
      index === 0 ? turnWithCompactedText(turn, budgetChars - 800, compactText) : turnWithCompactedText(turn, 600, compactText)
    )
    fitted = ensureToolResultResponses(fitted)
  }

  return {
    transcript: fitted,
    stats: summarizeContextStats(transcript, fitted, budgetTokens, totalTokens)
  }
}

export function summarizeContextStats(
  original: AgentTranscript,
  compressed: AgentTranscript,
  maxTokens = 128000,
  totalTokens = 0
): PluginDevAgentContextStats {
  const originalChars = countTranscriptChars(original)
  const compressedChars = countTranscriptChars(compressed)
  const estimatedTokens = estimateTokensForChars(compressedChars)
  return {
    messageCount: compressed.length,
    originalChars,
    compressedChars,
    savedChars: Math.max(0, originalChars - compressedChars),
    estimatedTokens,
    totalTokens,
    maxTokens,
    overBudget: estimatedTokens > maxTokens
  }
}

export function summarizeToolForProgress(
  toolName: string,
  args: Record<string, unknown>
): string {
  if (toolName === 'browser_html') {
    const selector = typeof args.selector === 'string' ? args.selector : 'body'
    return `browser_html(${selector})`
  }
  if (toolName === 'plugin_update_code') {
    if (args.mode === 'replace_snippet') {
      const oldLen = typeof args.oldText === 'string' ? args.oldText.length : 0
      const newLen = typeof args.newText === 'string' ? args.newText.length : 0
      return `plugin_update_code(replace_snippet ${oldLen}→${newLen})`
    }
    return `plugin_update_code(${args.mode ?? 'replace_all'})`
  }
  if (HTML_TOOL_NAMES.has(toolName)) return toolName
  return toolName
}
