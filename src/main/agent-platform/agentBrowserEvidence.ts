import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { AgentBrowserObservation } from '../scrapers/scrapeBrowserTypes'

export interface AgentBrowserEvidenceResult {
  ok: boolean
  content: string
  structured?: Record<string, unknown>
}

export type AgentEvidenceBrowserAction =
  | 'open'
  | 'snapshot'
  | 'find'
  | 'html'
  | 'evaluate'
  | 'click'
  | 'fill'
  | 'press'
  | 'scroll'
  | 'wait'
  | 'status'

const BROWSER_CAPABILITY_RESULT_LIMITS: Readonly<Record<AgentEvidenceBrowserAction, number>> = {
  status: 3_000,
  find: 12_000,
  evaluate: 16_000,
  html: 20_000,
  open: 64_000,
  click: 64_000,
  fill: 64_000,
  press: 64_000,
  scroll: 64_000,
  wait: 64_000,
  snapshot: 64_000
}

export function browserCapabilityResultLimitBytes(action: AgentEvidenceBrowserAction): number {
  return BROWSER_CAPABILITY_RESULT_LIMITS[action]
}

export interface BrowserCapabilityInput {
  sessionId: string
  workspaceDirectory: string
  action: AgentEvidenceBrowserAction
  args: Record<string, unknown>
  run: () => Promise<AgentBrowserEvidenceResult>
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

function safeArgs(action: AgentEvidenceBrowserAction, args: Record<string, unknown>): Record<string, unknown> {
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
  if (value === undefined) return 'null'
  return JSON.stringify(stableJsonValue(value)) ?? 'null'
}

interface BrowserObservationBaseline {
  documentRevision: string
  viewRevision: string
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
    if (
      !Object.hasOwn(previousRecord, key) ||
      stableSerialize(previousRecord[key]) !== stableSerialize(currentRecord[key])
    ) {
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

interface PackableObservationSection {
  name: string
  bytes: number
  apply: (target: AgentBrowserObservation) => void
}

const TARGETED_NEXT_ACTIONS: NonNullable<AgentBrowserObservation['nextActions']> = [
  'find',
  'html',
  'read-section'
]

function collectPackableSections(observation: AgentBrowserObservation): PackableObservationSection[] {
  const sections: PackableObservationSection[] = []
  if (typeof observation.snapshot === 'string') {
    sections.push({
      name: 'snapshot',
      bytes: Buffer.byteLength(observation.snapshot, 'utf8'),
      apply: (target) => {
        target.snapshot = observation.snapshot
      }
    })
  }
  if (isRecord(observation.pageFacts)) {
    for (const key of Object.keys(observation.pageFacts).sort()) {
      const value = observation.pageFacts[key]
      sections.push({
        name: key,
        bytes: Buffer.byteLength(stableSerialize(value), 'utf8'),
        apply: (target) => {
          target.pageFacts = { ...target.pageFacts, [key]: value }
        }
      })
    }
  }
  if (typeof observation.ariaDelta === 'string' && observation.ariaDelta) {
    sections.push({
      name: 'ariaDelta',
      bytes: Buffer.byteLength(observation.ariaDelta, 'utf8'),
      apply: (target) => {
        target.ariaDelta = observation.ariaDelta
      }
    })
  }
  if (observation.pageFactsDelta) {
    sections.push({
      name: 'pageFactsDelta',
      bytes: Buffer.byteLength(stableSerialize(observation.pageFactsDelta), 'utf8'),
      apply: (target) => {
        target.pageFactsDelta = observation.pageFactsDelta
      }
    })
  }
  if (typeof observation.html === 'string') {
    sections.push({
      name: 'html',
      bytes: Buffer.byteLength(observation.html, 'utf8'),
      apply: (target) => {
        target.html = observation.html
      }
    })
  }
  if (observation.matches) {
    sections.push({
      name: 'matches',
      bytes: Buffer.byteLength(stableSerialize(observation.matches), 'utf8'),
      apply: (target) => {
        target.matches = observation.matches
      }
    })
  }
  if (Object.hasOwn(observation, 'value')) {
    sections.push({
      name: 'value',
      bytes: Buffer.byteLength(stableSerialize(observation.value), 'utf8'),
      apply: (target) => {
        target.value = observation.value
      }
    })
  }
  return sections
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
  const snapshot = typeof input.observation.snapshot === 'string'
    ? input.observation.snapshot
    : undefined
  const sourceByteLength = Buffer.byteLength(completeContent, 'utf8')
  const identity: AgentBrowserObservation = {
    action: input.observation.action,
    documentRevision: input.observation.documentRevision,
    viewRevision: input.observation.viewRevision,
    actionSucceeded: input.observation.actionSucceeded,
    url: input.observation.url,
    title: input.observation.title,
    staleRefs: input.observation.staleRefs,
    scrollState: input.observation.scrollState,
    evidenceIncomplete: input.observation.evidenceIncomplete,
    artifactComplete: input.observation.artifactComplete
  }
  const packable = collectPackableSections(input.observation)
  const sortedAscending = [...packable].sort((left, right) => (
    left.bytes - right.bytes || left.name.localeCompare(right.name)
  ))

  const buildPacked = (
    keptNames: ReadonlySet<string>,
    includeOmittedSummary: boolean
  ): AgentBrowserObservation => {
    const packed: AgentBrowserObservation = {
      ...identity,
      observationMode: 'artifact',
      inlineComplete: false,
      sourceByteLength,
      ...(snapshot
        ? { snapshotByteLength: Buffer.byteLength(snapshot, 'utf8') }
        : {}),
      nextActions: TARGETED_NEXT_ACTIONS
    }
    const omitted: string[] = []
    for (const section of packable) {
      if (keptNames.has(section.name)) section.apply(packed)
      else omitted.push(section.name)
    }
    packed.omittedInlineSections = omitted.sort()
    if (includeOmittedSummary && pageFacts) {
      const omittedFacts = Object.fromEntries(
        Object.entries(pageFacts).filter(([key]) => omitted.includes(key))
      )
      const summary = pageFactSectionSummary(omittedFacts)
      if (summary.length > 0) packed.pageFactsSummary = summary
    }
    return packed
  }

  const tryPacked = (
    keptCount: number,
    includeOmittedSummary: boolean
  ): { observation: AgentBrowserObservation; content: string } | null => {
    const keptNames = new Set(sortedAscending.slice(0, keptCount).map((section) => section.name))
    const observation = buildPacked(keptNames, includeOmittedSummary)
    const content = observationJson({ ...input, observation })
    return Buffer.byteLength(content, 'utf8') <= input.maxBytes
      ? { observation, content }
      : null
  }

  let bestKeptCount = -1
  let bestWithoutSummary: { observation: AgentBrowserObservation; content: string } | null = null
  let low = 0
  let high = sortedAscending.length
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const candidate = tryPacked(middle, false)
    if (candidate) {
      bestKeptCount = middle
      bestWithoutSummary = candidate
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  if (bestWithoutSummary && bestKeptCount >= 0) {
    return tryPacked(bestKeptCount, true) ?? bestWithoutSummary
  }

  const minimalObservation: AgentBrowserObservation = {
    action: input.observation.action,
    documentRevision: input.observation.documentRevision,
    viewRevision: input.observation.viewRevision,
    observationMode: 'artifact',
    actionSucceeded: input.observation.actionSucceeded,
    url: input.observation.url,
    title: input.observation.title,
    staleRefs: input.observation.staleRefs,
    scrollState: input.observation.scrollState,
    inlineComplete: false,
    artifactComplete: input.observation.artifactComplete,
    sourceByteLength,
    omittedInlineSections: ['observation'],
    nextActions: ['read-section']
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
    const browserRoot = path.resolve(root, '.javdex', 'browser')
    const partPath = path.resolve(root, ref)
    if (partPath !== browserRoot && !partPath.startsWith(`${browserRoot}${path.sep}`)) {
      throw new Error('browser artifact part escapes the browser artifact directory')
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
  const browserRoot = path.resolve(root, '.javdex', 'browser')
  const artifactPath = path.resolve(root, artifactRef)
  if (artifactPath !== browserRoot && !artifactPath.startsWith(`${browserRoot}${path.sep}`)) {
    throw new Error('browser artifact escapes the browser artifact directory')
  }
  const value = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>
  return resolveArtifactTextReferences(root, value) as Record<string, unknown>
}

export interface BrowserArtifactSectionInput {
  workspaceDirectory: string
  artifactRef: string
  section: string
  cursor?: string
}

interface BrowserArtifactSectionCursor {
  version: 1
  artifactRef: string
  section: string
  offset: number
  textOffset: number
}

const BROWSER_ARTIFACT_SECTION_RESULT_BYTES = 18_000
const BROWSER_ARTIFACT_SECTION_MAX_ENTRIES = 200

function artifactSectionError(code: string, message: string): AgentBrowserEvidenceResult {
  return {
    ok: false,
    content: JSON.stringify({ code, message }, null, 2),
    structured: { code }
  }
}

function encodeSectionCursor(cursor: BrowserArtifactSectionCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url')
}

function decodeSectionCursor(
  raw: string | undefined,
  artifactRef: string,
  section: string
): BrowserArtifactSectionCursor {
  if (!raw) {
    return { version: 1, artifactRef, section, offset: 0, textOffset: 0 }
  }
  let value: unknown
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
  } catch {
    throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
  }
  if (!isRecord(value) ||
      value.version !== 1 ||
      value.artifactRef !== artifactRef ||
      value.section !== section ||
      !Number.isSafeInteger(value.offset) || Number(value.offset) < 0 ||
      !Number.isSafeInteger(value.textOffset) || Number(value.textOffset) < 0) {
    throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
  }
  return {
    version: 1,
    artifactRef,
    section,
    offset: Number(value.offset),
    textOffset: Number(value.textOffset)
  }
}

function readBrowserArtifactIndex(
  workspaceDirectory: string,
  artifactRef: string
): Record<string, unknown> {
  const root = path.resolve(workspaceDirectory)
  const browserRoot = path.resolve(root, '.javdex', 'browser')
  const artifactPath = path.resolve(root, artifactRef)
  if (artifactPath !== browserRoot && !artifactPath.startsWith(`${browserRoot}${path.sep}`)) {
    throw new Error('BROWSER_ARTIFACT_PATH_INVALID')
  }
  if (!fs.existsSync(artifactPath)) throw new Error('BROWSER_ARTIFACT_NOT_FOUND')
  const value = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.observation)) {
    throw new Error('BROWSER_ARTIFACT_INVALID')
  }
  return value
}

function sectionValueSummary(section: string, value: unknown): Record<string, unknown> {
  const external = isRecord(value) && typeof value.$artifactTextRef === 'string'
  const byteLength = external && typeof value.byteLength === 'number'
    ? value.byteLength
    : Buffer.byteLength(stableSerialize(value), 'utf8')
  return {
    section,
    byteLength,
    itemCount: Array.isArray(value)
      ? value.length
      : typeof value === 'string'
        ? Array.from(value).length
        : isRecord(value)
          ? Object.keys(value).length
          : value === undefined || value === null
            ? 0
            : 1
  }
}

function artifactSectionCatalog(observation: Record<string, unknown>): Array<Record<string, unknown>> {
  const sections = new Map<string, unknown>()
  for (const key of ['snapshot', 'ariaDelta', 'pageFactsDelta', 'html', 'matches', 'value']) {
    if (Object.hasOwn(observation, key)) sections.set(key, observation[key])
  }
  if (isRecord(observation.pageFacts)) {
    for (const [key, value] of Object.entries(observation.pageFacts)) sections.set(key, value)
  }
  return [...sections.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([section, value]) => sectionValueSummary(section, value))
}

function rawArtifactSection(
  artifact: Record<string, unknown>,
  section: string
): unknown {
  const observation = artifact.observation as Record<string, unknown>
  if (section === 'observation') return artifactSectionCatalog(observation)
  if (Object.hasOwn(observation, section) && section !== 'pageFacts') return observation[section]
  if (isRecord(observation.pageFacts) && Object.hasOwn(observation.pageFacts, section)) {
    return observation.pageFacts[section]
  }
  throw new Error('BROWSER_ARTIFACT_SECTION_NOT_FOUND')
}

function contentFits(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8') <=
    BROWSER_ARTIFACT_SECTION_RESULT_BYTES
}

function scalarChunk(value: string, offset: number, build: (chunk: string, complete: boolean) => unknown): {
  chunk: string
  nextOffset: number
  complete: boolean
} {
  const scalars = Array.from(value)
  if (offset >= scalars.length) return { chunk: '', nextOffset: scalars.length, complete: true }
  let low = 1
  let high = scalars.length - offset
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const chunk = scalars.slice(offset, offset + middle).join('')
    const complete = offset + middle >= scalars.length
    if (contentFits(build(chunk, complete))) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  if (best === 0) throw new Error('BROWSER_ARTIFACT_SECTION_ITEM_TOO_LARGE')
  return {
    chunk: scalars.slice(offset, offset + best).join(''),
    nextOffset: offset + best,
    complete: offset + best >= scalars.length
  }
}

function buildSectionPage(input: {
  artifactRef: string
  section: string
  value: unknown
  cursor: BrowserArtifactSectionCursor
}): Record<string, unknown> {
  const base = {
    action: 'read-section',
    artifactRef: input.artifactRef,
    section: input.section
  }
  if (typeof input.value === 'string') {
    if (input.cursor.offset !== 0) throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
    const page = scalarChunk(input.value, input.cursor.textOffset, (text, complete) => ({
      ...base,
      kind: 'text',
      text,
      complete,
      ...(complete ? {} : { nextCursor: 'cursor' })
    }))
    const nextCursor = page.complete
      ? undefined
      : encodeSectionCursor({ ...input.cursor, textOffset: page.nextOffset })
    return {
      ...base,
      kind: 'text',
      text: page.chunk,
      complete: page.complete,
      ...(nextCursor ? { nextCursor } : {})
    }
  }

  const entries = Array.isArray(input.value)
    ? input.value.map((value, index) => ({ index, value }))
    : isRecord(input.value)
      ? Object.entries(input.value).map(([key, value]) => ({ key, value }))
      : undefined
  if (!entries) {
    if (input.cursor.offset !== 0 || input.cursor.textOffset !== 0) {
      throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
    }
    return { ...base, kind: 'value', value: input.value, complete: true }
  }
  if (input.cursor.offset > entries.length) throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
  if (input.cursor.textOffset > 0 && (
    input.cursor.offset >= entries.length ||
    typeof entries[input.cursor.offset]?.value !== 'string'
  )) {
    throw new Error('BROWSER_ARTIFACT_CURSOR_INVALID')
  }
  const pageEntries: Array<Record<string, unknown>> = []
  let offset = input.cursor.offset
  while (offset < entries.length && pageEntries.length < BROWSER_ARTIFACT_SECTION_MAX_ENTRIES) {
    const entry = entries[offset]
    if (typeof entry.value === 'string' && input.cursor.textOffset > 0) {
      const textPage = scalarChunk(entry.value, input.cursor.textOffset, (text, valueComplete) => ({
        ...base,
        kind: 'entries',
        entries: [{ ...entry, value: text, valueComplete }],
        complete: false,
        nextCursor: 'cursor'
      }))
      const nextOffset = textPage.complete ? offset + 1 : offset
      const complete = nextOffset >= entries.length
      const nextCursor = complete
        ? undefined
        : encodeSectionCursor({
            ...input.cursor,
            offset: nextOffset,
            textOffset: textPage.complete ? 0 : textPage.nextOffset
          })
      return {
        ...base,
        kind: 'entries',
        entries: [{ ...entry, value: textPage.chunk, valueComplete: textPage.complete }],
        complete,
        ...(nextCursor ? { nextCursor } : {})
      }
    }
    const candidate = [...pageEntries, { ...entry, valueComplete: true }]
    const complete = offset + 1 >= entries.length
    if (!contentFits({
      ...base,
      kind: 'entries',
      entries: candidate,
      complete,
      ...(complete ? {} : { nextCursor: 'cursor' })
    })) {
      if (pageEntries.length > 0) break
      if (typeof entry.value !== 'string') {
        throw new Error('BROWSER_ARTIFACT_SECTION_ITEM_TOO_LARGE')
      }
      const textPage = scalarChunk(entry.value, 0, (text, valueComplete) => ({
        ...base,
        kind: 'entries',
        entries: [{ ...entry, value: text, valueComplete }],
        complete: false,
        nextCursor: 'cursor'
      }))
      const nextOffset = textPage.complete ? offset + 1 : offset
      const complete = nextOffset >= entries.length
      const nextCursor = complete
        ? undefined
        : encodeSectionCursor({
            ...input.cursor,
            offset: nextOffset,
            textOffset: textPage.complete ? 0 : textPage.nextOffset
          })
      return {
        ...base,
        kind: 'entries',
        entries: [{ ...entry, value: textPage.chunk, valueComplete: textPage.complete }],
        complete,
        ...(nextCursor ? { nextCursor } : {})
      }
    }
    pageEntries.push(...candidate.slice(pageEntries.length))
    offset += 1
  }
  const complete = offset >= entries.length
  return {
    ...base,
    kind: 'entries',
    entries: pageEntries,
    complete,
    ...(complete
      ? {}
      : { nextCursor: encodeSectionCursor({ ...input.cursor, offset, textOffset: 0 }) })
  }
}

/**
 * Stable browser Interface used by the bundled Skill. Full observations stay in the workspace;
 * the model receives complete captured evidence when it fits, otherwise an explicit artifact-backed
 * observation. This Module never guesses which page facts are semantically important.
 */
export class AgentBrowserEvidenceModule {
  private readonly baselines = new Map<string, BrowserObservationBaseline>()

  reset(sessionId: string): void {
    this.baselines.delete(sessionId)
  }

  readSection(input: BrowserArtifactSectionInput): AgentBrowserEvidenceResult {
    try {
      const artifact = readBrowserArtifactIndex(input.workspaceDirectory, input.artifactRef)
      const cursor = decodeSectionCursor(input.cursor, input.artifactRef, input.section)
      const raw = rawArtifactSection(artifact, input.section)
      const value = resolveArtifactTextReferences(path.resolve(input.workspaceDirectory), raw)
      const page = buildSectionPage({
        artifactRef: input.artifactRef,
        section: input.section,
        value,
        cursor
      })
      return {
        ok: true,
        content: JSON.stringify(page, null, 2),
        structured: {
          action: 'read-section',
          artifactRef: input.artifactRef,
          section: input.section,
          complete: page.complete,
          ...(typeof page.nextCursor === 'string' ? { nextCursor: page.nextCursor } : {})
        }
      }
    } catch (error) {
      const code = error instanceof Error && error.message.startsWith('BROWSER_ARTIFACT_')
        ? error.message
        : 'BROWSER_ARTIFACT_READ_FAILED'
      const messages: Record<string, string> = {
        BROWSER_ARTIFACT_PATH_INVALID: 'artifactRef 必须指向当前工作区 .javdex/browser 内的 artifact。',
        BROWSER_ARTIFACT_NOT_FOUND: 'browser artifact 不存在或已失效。',
        BROWSER_ARTIFACT_INVALID: 'browser artifact 格式无效。',
        BROWSER_ARTIFACT_SECTION_NOT_FOUND: 'browser artifact 中不存在请求的 section。',
        BROWSER_ARTIFACT_CURSOR_INVALID: 'read-section cursor 无效、已过期或属于其他 section。',
        BROWSER_ARTIFACT_SECTION_ITEM_TOO_LARGE: '该 section 的单项过大；请改用 browser find 或局部 html。'
      }
      return artifactSectionError(
        code,
        messages[code] ?? (error instanceof Error ? error.message : String(error))
      )
    }
  }

  async execute(input: BrowserCapabilityInput): Promise<AgentBrowserEvidenceResult> {
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
    const pageObservation = ['open', 'snapshot', 'click', 'fill', 'press', 'scroll', 'wait'].includes(input.action)
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
      schemaVersion: 1,
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
      const currentViewRevision = observation.viewRevision ?? revision
      const baseline = this.baselines.get(input.sessionId)
      const currentSnapshot = fullSnapshot ?? String(observation.snapshot ?? '')
      const currentFacts = hasPageFacts
        ? observation.pageFacts as Record<string, unknown>
        : baseline?.viewRevision === currentViewRevision
          ? baseline.pageFacts
          : undefined
      const newView = !baseline || baseline.viewRevision !== currentViewRevision
      if (newView) {
        agentObservation = {
          ...stableObservation,
          documentRevision: revision,
          viewRevision: currentViewRevision,
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
            viewRevision: currentViewRevision,
            observationMode: 'unchanged',
            actionSucceeded: observation.actionSucceeded,
            url: observation.url,
            title: observation.title,
            scrollState: observation.scrollState,
            staleRefs: false,
            evidenceIncomplete: sourceEvidenceIncomplete === true,
            artifactComplete: fullObservation.artifactComplete
          }
        } else {
          maxBytes = 12_000
          agentObservation = {
            action: observation.action,
            documentRevision: revision,
            viewRevision: currentViewRevision,
            observationMode: 'delta',
            actionSucceeded: observation.actionSucceeded,
            url: observation.url,
            title: observation.title,
            scrollState: observation.scrollState,
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
        viewRevision: currentViewRevision,
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

export const agentBrowserEvidence = new AgentBrowserEvidenceModule()
