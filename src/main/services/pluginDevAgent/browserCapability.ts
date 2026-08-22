import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentBrowserObservation } from '../../scrapers/scrapeBrowserTypes'
import type { ToolExecutionResult } from './types'

export type PluginBrowserAction =
  | 'open'
  | 'snapshot'
  | 'find'
  | 'html'
  | 'evaluate'
  | 'click'
  | 'fill'
  | 'press'
  | 'wait'
  | 'status'

const BROWSER_CAPABILITY_RESULT_LIMITS: Readonly<Record<PluginBrowserAction, number>> = {
  status: 3_000,
  find: 12_000,
  evaluate: 16_000,
  html: 20_000,
  open: 64_000,
  click: 64_000,
  fill: 64_000,
  press: 64_000,
  wait: 64_000,
  snapshot: 64_000
}

export function browserCapabilityResultLimitBytes(action: PluginBrowserAction): number {
  return BROWSER_CAPABILITY_RESULT_LIMITS[action]
}

export interface BrowserCapabilityInput {
  sessionId: string
  workspaceDirectory: string
  action: PluginBrowserAction
  args: Record<string, unknown>
  run: () => Promise<ToolExecutionResult>
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return `${value.slice(0, Math.max(0, low - 3))}…`
}

/** Return valid JSON within a byte budget; full detail remains available through an artifact ref. */
export function boundedJson(
  value: unknown,
  maxBytes: number,
  fallback: Record<string, unknown> = {}
): string {
  const serialized = JSON.stringify(value, null, 2)
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return serialized
  let previewBytes = Math.max(64, Math.floor(maxBytes / 2))
  while (previewBytes > 0) {
    const candidate = JSON.stringify({
      ...fallback,
      truncated: true,
      preview: truncateUtf8(serialized, previewBytes)
    }, null, 2)
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) return candidate
    previewBytes = Math.floor(previewBytes * 0.7)
  }
  const minimal = JSON.stringify({ ...fallback, truncated: true })
  if (Buffer.byteLength(minimal, 'utf8') <= maxBytes) return minimal
  return '{"truncated":true}'
}

function safeArgs(action: PluginBrowserAction, args: Record<string, unknown>): Record<string, unknown> {
  if (action !== 'fill' || typeof args.text !== 'string') return args
  return { ...args, text: `[redacted ${args.text.length} chars]` }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function unwrapJsonContainer(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  const looksLikeContainer =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  if (!looksLikeContainer) return value
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : value
  } catch {
    return value
  }
}

function normalizeObservation(value: Record<string, unknown>): AgentBrowserObservation {
  return {
    ...value,
    action: typeof value.action === 'string'
      ? value.action as AgentBrowserObservation['action']
      : 'status',
    ...(Object.hasOwn(value, 'value') ? { value: unwrapJsonContainer(value.value) } : {})
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableJsonValue(value[key])])
  )
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(stableJsonValue(value))
}

interface BrowserObservationBaseline {
  documentRevision: string
  fullSnapshot: string
  pageFacts?: Record<string, unknown>
}

function pageFactsDelta(
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined
): AgentBrowserObservation['pageFactsDelta'] | undefined {
  if (!previous && !current) return undefined
  const changed: Record<string, unknown> = {}
  const removedKeys: string[] = []
  const previousRecord = previous ?? {}
  const currentRecord = current ?? {}
  for (const key of Object.keys(currentRecord).sort()) {
    if (sha256(stableSerialize(previousRecord[key])) !== sha256(stableSerialize(currentRecord[key]))) {
      changed[key] = currentRecord[key]
    }
  }
  for (const key of Object.keys(previousRecord).sort()) {
    if (!Object.hasOwn(currentRecord, key)) removedKeys.push(key)
  }
  if (Object.keys(changed).length === 0 && removedKeys.length === 0) return undefined
  return { changed, removedKeys }
}

function occurrenceTokens(lines: readonly string[]): string[] {
  const occurrences = new Map<string, number>()
  return lines.map((line) => {
    const occurrence = (occurrences.get(line) ?? 0) + 1
    occurrences.set(line, occurrence)
    return `${line}\u0000${occurrence}`
  })
}

interface AriaDeltaResult {
  value: string
}

function buildAriaDelta(previous: string, current: string): AriaDeltaResult {
  const previousLines = previous.split(/\r?\n/u)
  const currentLines = current.split(/\r?\n/u)
  const previousTokens = occurrenceTokens(previousLines)
  const currentTokens = occurrenceTokens(currentLines)
  const previousSet = new Set(previousTokens)
  const currentSet = new Set(currentTokens)
  const changedIndexes: number[] = []
  const removedLines: string[] = []
  for (let index = 0; index < currentTokens.length; index += 1) {
    if (!previousSet.has(currentTokens[index])) changedIndexes.push(index)
  }
  for (let index = 0; index < previousTokens.length; index += 1) {
    if (!currentSet.has(previousTokens[index])) removedLines.push(previousLines[index])
  }
  if (changedIndexes.length === 0 && removedLines.length === 0) {
    return { value: '' }
  }
  const contextIndexes = new Set<number>()
  for (const index of changedIndexes) {
    for (
      let neighbor = Math.max(0, index - 2);
      neighbor <= Math.min(currentLines.length - 1, index + 2);
      neighbor += 1
    ) {
      contextIndexes.add(neighbor)
    }
  }
  const changedSet = new Set(changedIndexes)
  const currentBlock = [...contextIndexes]
    .sort((left, right) => left - right)
    .map((index) => `${changedSet.has(index) ? '+' : ' '} ${currentLines[index]}`)
  const removedBlock = removedLines.map((line) => `- ${line}`)
  const sections = [
    ...(currentBlock.length > 0 ? ['[ARIA changed]', ...currentBlock] : []),
    ...(removedBlock.length > 0 ? ['[ARIA removed]', ...removedBlock] : [])
  ]
  return { value: sections.join('\n') }
}

function pageFactSectionSummary(pageFacts: Record<string, unknown> | undefined): NonNullable<
AgentBrowserObservation['pageFactsSummary']
> {
  if (!pageFacts) return []
  return Object.keys(pageFacts).sort().map((section) => {
    const value = pageFacts[section]
    return {
      section,
      byteLength: Buffer.byteLength(stableSerialize(value), 'utf8'),
      itemCount: Array.isArray(value)
        ? value.length
        : isRecord(value)
          ? Object.keys(value).length
          : value === undefined || value === null
            ? 0
            : 1
    }
  })
}

function observationJson(input: {
  observation: AgentBrowserObservation
  ok: boolean
  artifactRef: string
}): string {
  return JSON.stringify({
    ...input.observation,
    action: input.observation.action,
    ok: input.ok,
    artifactRef: input.artifactRef
  }, null, 2)
}

function transparentObservationResult(input: {
  observation: AgentBrowserObservation
  ok: boolean
  artifactRef: string
  maxBytes: number
}): { observation: AgentBrowserObservation; content: string } {
  const completeObservation: AgentBrowserObservation = {
    ...input.observation,
    inlineComplete: true
  }
  const completeContent = observationJson({ ...input, observation: completeObservation })
  if (Buffer.byteLength(completeContent, 'utf8') <= input.maxBytes) {
    return { observation: completeObservation, content: completeContent }
  }

  const pageFacts = isRecord(input.observation.pageFacts)
    ? input.observation.pageFacts
    : undefined
  const identity: AgentBrowserObservation = {
    action: input.observation.action,
    documentRevision: input.observation.documentRevision,
    actionSucceeded: input.observation.actionSucceeded,
    url: input.observation.url,
    title: input.observation.title,
    staleRefs: input.observation.staleRefs,
    evidenceIncomplete: input.observation.evidenceIncomplete,
    artifactComplete: input.observation.artifactComplete
  }
  const sourceByteLength = Buffer.byteLength(completeContent, 'utf8')
  const snapshot = typeof input.observation.snapshot === 'string'
    ? input.observation.snapshot
    : undefined
  const snapshotOnly: AgentBrowserObservation | undefined = snapshot && pageFacts
    ? {
        ...identity,
        observationMode: 'artifact',
        snapshot,
        inlineComplete: false,
        sourceByteLength,
        snapshotByteLength: Buffer.byteLength(snapshot, 'utf8'),
        pageFactsSummary: pageFactSectionSummary(pageFacts),
        omittedInlineSections: ['pageFacts'],
        nextActions: ['find', 'snapshot-target', 'html', 'read-artifact']
      }
    : undefined
  if (snapshotOnly) {
    const snapshotContent = observationJson({ ...input, observation: snapshotOnly })
    if (Buffer.byteLength(snapshotContent, 'utf8') <= input.maxBytes) {
      return { observation: snapshotOnly, content: snapshotContent }
    }
  }

  const artifactObservation: AgentBrowserObservation = {
    ...identity,
    observationMode: 'artifact',
    inlineComplete: false,
    sourceByteLength,
    ...(snapshot
      ? { snapshotByteLength: Buffer.byteLength(snapshot, 'utf8') }
      : {}),
    ...(pageFacts
      ? { pageFactsSummary: pageFactSectionSummary(pageFacts) }
      : {}),
    omittedInlineSections: [
      ...(snapshot ? ['snapshot'] : []),
      ...(pageFacts ? ['pageFacts'] : []),
      ...(input.observation.ariaDelta ? ['ariaDelta'] : []),
      ...(input.observation.pageFactsDelta ? ['pageFactsDelta'] : []),
      ...(input.observation.html ? ['html'] : []),
      ...(Object.hasOwn(input.observation, 'value') ? ['value'] : []),
      ...(input.observation.matches ? ['matches'] : [])
    ],
    nextActions: snapshot || pageFacts
      ? ['find', 'snapshot-target', 'html', 'read-artifact']
      : ['read-artifact']
  }
  const artifactContent = observationJson({ ...input, observation: artifactObservation })
  if (Buffer.byteLength(artifactContent, 'utf8') <= input.maxBytes) {
    return { observation: artifactObservation, content: artifactContent }
  }
  const minimalObservation: AgentBrowserObservation = {
    action: input.observation.action,
    documentRevision: input.observation.documentRevision,
    observationMode: 'artifact',
    actionSucceeded: input.observation.actionSucceeded,
    url: input.observation.url,
    title: input.observation.title,
    staleRefs: input.observation.staleRefs,
    inlineComplete: false,
    artifactComplete: input.observation.artifactComplete,
    sourceByteLength,
    omittedInlineSections: ['observation'],
    nextActions: ['read-artifact']
  }
  return {
    observation: minimalObservation,
    content: observationJson({ ...input, observation: minimalObservation })
  }
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(temporary, content, 'utf8')
  fs.renameSync(temporary, filePath)
}

const ARTIFACT_EXTERNAL_STRING_BYTES = 24 * 1024
const ARTIFACT_TEXT_CHUNK_BYTES = 4 * 1024

interface BrowserArtifactPart {
  path: string
  byteLength: number
  sha256: string
  content: string
}

function splitUtf8(value: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  for (const scalar of value) {
    const scalarBytes = Buffer.byteLength(scalar, 'utf8')
    if (current && currentBytes + scalarBytes > maxBytes) {
      chunks.push(current)
      current = ''
      currentBytes = 0
    }
    current += scalar
    currentBytes += scalarBytes
  }
  if (current || chunks.length === 0) chunks.push(current)
  return chunks
}

function externalizeArtifactStrings(input: {
  value: unknown
  artifactId: string
  parts: BrowserArtifactPart[]
}): unknown {
  if (typeof input.value === 'string') {
    const byteLength = Buffer.byteLength(input.value, 'utf8')
    const serializedByteLength = Buffer.byteLength(JSON.stringify(input.value), 'utf8')
    if (serializedByteLength <= ARTIFACT_EXTERNAL_STRING_BYTES) return input.value
    const partNumber = input.parts.length + 1
    const relativePath = path.join(
      '.javdex',
      'browser',
      `${input.artifactId}.part-${String(partNumber).padStart(3, '0')}.json`
    )
    const contentHash = sha256(input.value)
    const content = `${JSON.stringify({
      schemaVersion: 1,
      kind: 'browser-artifact-text',
      encoding: 'utf8-chunks',
      byteLength,
      sha256: contentHash,
      chunks: splitUtf8(input.value, ARTIFACT_TEXT_CHUNK_BYTES)
    }, null, 2)}\n`
    input.parts.push({ path: relativePath, byteLength, sha256: contentHash, content })
    return {
      $artifactTextRef: relativePath,
      encoding: 'utf8-chunks',
      byteLength,
      sha256: contentHash
    }
  }
  if (Array.isArray(input.value)) {
    return input.value.map((value) => externalizeArtifactStrings({ ...input, value }))
  }
  if (!isRecord(input.value)) return input.value
  return Object.fromEntries(
    Object.entries(input.value).map(([key, value]) => [
      key,
      externalizeArtifactStrings({ ...input, value })
    ])
  )
}

function writeReadableBrowserArtifact(input: {
  workspaceDirectory: string
  relativePath: string
  artifactId: string
  artifact: Record<string, unknown>
  logicalSerialized: string
}): void {
  const artifactPath = path.join(path.resolve(input.workspaceDirectory), input.relativePath)
  if (fs.existsSync(artifactPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>
      if ((existing.artifactTransport as Record<string, unknown> | undefined)?.format === 'segmented-json-v1') {
        return
      }
    } catch {
      // Replace an incomplete or legacy artifact at the same logical content address.
    }
  }
  const parts: BrowserArtifactPart[] = []
  const readableArtifact = externalizeArtifactStrings({
    value: input.artifact,
    artifactId: input.artifactId,
    parts
  }) as Record<string, unknown>
  const index = {
    ...readableArtifact,
    artifactTransport: {
      format: 'segmented-json-v1',
      logicalSha256: sha256(input.logicalSerialized),
      parts: parts.map(({ path: partPath, byteLength, sha256: contentHash }) => ({
        path: partPath,
        byteLength,
        sha256: contentHash
      }))
    }
  }
  for (const part of parts) {
    const partPath = path.join(path.resolve(input.workspaceDirectory), part.path)
    atomicWrite(partPath, part.content)
  }
  atomicWrite(artifactPath, `${JSON.stringify(index, null, 2)}\n`)
}

function resolveArtifactTextReferences(workspaceDirectory: string, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveArtifactTextReferences(workspaceDirectory, item))
  }
  if (!isRecord(value)) return value
  const ref = value.$artifactTextRef
  if (typeof ref === 'string') {
    const root = path.resolve(workspaceDirectory)
    const partPath = path.resolve(root, ref)
    if (partPath !== root && !partPath.startsWith(`${root}${path.sep}`)) {
      throw new Error('browser artifact part escapes the workspace')
    }
    const part = JSON.parse(fs.readFileSync(partPath, 'utf8')) as Record<string, unknown>
    if (part.kind !== 'browser-artifact-text' || !Array.isArray(part.chunks)) {
      throw new Error(`invalid browser artifact part: ${ref}`)
    }
    const content = part.chunks.map((chunk) => String(chunk)).join('')
    const contentHash = sha256(content)
    const byteLength = Buffer.byteLength(content, 'utf8')
    if (
      contentHash !== value.sha256 ||
      contentHash !== part.sha256 ||
      byteLength !== value.byteLength ||
      byteLength !== part.byteLength
    ) {
      throw new Error(`browser artifact part integrity check failed: ${ref}`)
    }
    return content
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resolveArtifactTextReferences(workspaceDirectory, item)
    ])
  )
}

/** Resolve a browser artifact bundle to its original logical observation. */
export function readBrowserArtifactBundle(
  workspaceDirectory: string,
  artifactRef: string
): Record<string, unknown> {
  const root = path.resolve(workspaceDirectory)
  const artifactPath = path.resolve(root, artifactRef)
  if (artifactPath !== root && !artifactPath.startsWith(`${root}${path.sep}`)) {
    throw new Error('browser artifact escapes the workspace')
  }
  const value = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>
  return resolveArtifactTextReferences(root, value) as Record<string, unknown>
}

/**
 * Stable browser Interface used by the bundled Skill. Full observations stay in the workspace;
 * the model receives complete captured evidence when it fits, otherwise an explicit artifact-backed
 * observation. This Module never guesses which page facts are semantically important.
 */
export class PluginBrowserCapabilityModule {
  private readonly baselines = new Map<string, BrowserObservationBaseline>()

  reset(sessionId: string): void {
    this.baselines.delete(sessionId)
  }

  async execute(input: BrowserCapabilityInput): Promise<ToolExecutionResult> {
    const result = await input.run()
    const structured = result.structured
    const rawObservation = isRecord(structured?.observation)
      ? structured.observation
      : undefined
    if (!rawObservation) return result

    const observation = normalizeObservation(rawObservation)
    const fullSnapshot = typeof structured?.fullSnapshot === 'string'
      ? structured.fullSnapshot
      : undefined
    const hasPageFacts = isRecord(observation.pageFacts)
    const pageObservation = ['open', 'snapshot', 'click', 'fill', 'press', 'wait'].includes(input.action)
    const sourceCapped = observation.fullSnapshotTruncated === true ||
      (observation.truncated === true && !fullSnapshot)
    const sourceEvidenceIncomplete = observation.evidenceIncomplete
    const stableObservation = { ...observation }
    delete stableObservation.truncated
    delete stableObservation.snapshotExcerpted
    delete stableObservation.evidenceIncomplete
    const fullObservation = {
      ...stableObservation,
      ...(fullSnapshot ? { snapshot: fullSnapshot } : {}),
      snapshotExcerpted: observation.fullSnapshotTruncated === true,
      evidenceIncomplete: observation.observationMode === 'pending' ||
        sourceEvidenceIncomplete === true ||
        sourceCapped ||
        (pageObservation && !hasPageFacts),
      artifactComplete: observation.observationMode !== 'pending' &&
        sourceEvidenceIncomplete !== true &&
        !sourceCapped &&
        (!pageObservation || hasPageFacts)
    }
    const artifact = {
      schemaVersion: 2,
      action: input.action,
      args: safeArgs(input.action, input.args),
      ok: result.ok,
      observation: fullObservation
    }
    const serialized = `${JSON.stringify(artifact, null, 2)}\n`
    const id = sha256(serialized).slice(0, 24)
    const relativePath = path.join('.javdex', 'browser', `${id}.json`)
    writeReadableBrowserArtifact({
      workspaceDirectory: input.workspaceDirectory,
      relativePath,
      artifactId: id,
      artifact,
      logicalSerialized: serialized
    })

    let maxBytes = browserCapabilityResultLimitBytes(input.action)
    let agentObservation: AgentBrowserObservation
    if (!pageObservation || observation.observationMode === 'pending') {
      maxBytes = observation.observationMode === 'pending' ? 3_000 : maxBytes
      agentObservation = {
        ...stableObservation,
        ...(observation.observationMode === 'pending'
          ? { observationMode: 'pending' as const }
          : {}),
        ...(sourceEvidenceIncomplete === true ? { evidenceIncomplete: true } : {}),
        artifactComplete: fullObservation.artifactComplete
      }
    } else {
      const revision = observation.documentRevision ?? `legacy:${observation.url ?? ''}`
      const baseline = this.baselines.get(input.sessionId)
      const currentSnapshot = fullSnapshot ?? String(observation.snapshot ?? '')
      const currentFacts = hasPageFacts
        ? observation.pageFacts as Record<string, unknown>
        : baseline?.documentRevision === revision
          ? baseline.pageFacts
          : undefined
      const newDocument = !baseline || baseline.documentRevision !== revision
      if (newDocument) {
        agentObservation = {
          ...stableObservation,
          documentRevision: revision,
          observationMode: 'full',
          ...(currentSnapshot ? { snapshot: currentSnapshot } : {}),
          ...(baseline ? { staleRefs: true } : {}),
          evidenceIncomplete: Boolean(
            sourceEvidenceIncomplete ||
            sourceCapped ||
            !hasPageFacts
          ),
          artifactComplete: fullObservation.artifactComplete
        }
      } else {
        const aria = buildAriaDelta(baseline.fullSnapshot, currentSnapshot)
        const factsDelta = pageFactsDelta(baseline.pageFacts, currentFacts)
        if (!aria.value && !factsDelta) {
          maxBytes = 3_000
          agentObservation = {
            action: observation.action,
            documentRevision: revision,
            observationMode: 'unchanged',
            actionSucceeded: observation.actionSucceeded,
            url: observation.url,
            title: observation.title,
            staleRefs: false,
            evidenceIncomplete: sourceEvidenceIncomplete === true,
            artifactComplete: fullObservation.artifactComplete
          }
        } else {
          maxBytes = 12_000
          agentObservation = {
            action: observation.action,
            documentRevision: revision,
            observationMode: 'delta',
            actionSucceeded: observation.actionSucceeded,
            url: observation.url,
            title: observation.title,
            ...(aria.value ? { ariaDelta: aria.value } : {}),
            ...(factsDelta ? { pageFactsDelta: factsDelta } : {}),
            staleRefs: false,
            evidenceIncomplete: sourceEvidenceIncomplete === true,
            artifactComplete: fullObservation.artifactComplete
          }
        }
      }
      this.baselines.set(input.sessionId, {
        documentRevision: revision,
        fullSnapshot: currentSnapshot,
        ...(currentFacts ? { pageFacts: currentFacts } : {})
      })
    }

    const delivered = transparentObservationResult({
      observation: agentObservation,
      ok: result.ok,
      artifactRef: relativePath,
      maxBytes
    })
    return {
      ...result,
      content: delivered.content,
      structured: {
        observation: { ...delivered.observation, artifactRef: relativePath },
        artifactRef: relativePath,
        action: input.action
      }
    }
  }
}

export const pluginBrowserCapability = new PluginBrowserCapabilityModule()
