import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { AgentBrowserEvidenceModule } from '../../agent-platform/agentBrowserEvidence'
import {
  assertAgentMetadataPublicHttpUrl,
  assertBrowserArtifactMatchesObservation,
  sanitizeAgentMetadataUrl
} from './browserAdapter'

async function generateArtifact(
  root: string,
  observation: Record<string, unknown> = {}
): Promise<string> {
  const module = new AgentBrowserEvidenceModule()
  const result = await module.execute({
    sessionId: 'browser-evidence-test',
    workspaceDirectory: root,
    action: 'snapshot',
    args: {},
    run: async () => ({
      ok: true,
      content: '{}',
      structured: {
        observation: {
          action: 'snapshot',
          actionSucceeded: true,
          url: 'https://example.test/list',
          documentRevision: 'document-1',
          viewRevision: 'view-1',
          snapshot: 'complete snapshot',
          pageFacts: { headings: ['List'], links: [] },
          evidenceIncomplete: false,
          ...observation
        }
      }
    })
  })
  assert.equal(result.ok, true)
  assert.equal(typeof result.structured?.artifactRef, 'string')
  return String(result.structured?.artifactRef)
}

describe('Agent metadata browser URL policy', () => {
  it('allows a public hostname when a system proxy maps it to the RFC 2544 fake-IP range', async () => {
    const url = await assertAgentMetadataPublicHttpUrl(
      'https://www.javlibrary.com/cn/javli43h2m.html',
      async () => [{ address: '198.18.0.22' }]
    )

    assert.equal(url.hostname, 'www.javlibrary.com')
  })

  it('still rejects direct benchmark-range IPs and hostnames resolving to private networks', async () => {
    await assert.rejects(
      assertAgentMetadataPublicHttpUrl('https://198.18.0.22/detail'),
      /不允许访问本机或局域网地址/
    )
    await assert.rejects(
      assertAgentMetadataPublicHttpUrl(
        'https://public-looking.example/detail',
        async () => [{ address: '192.168.1.20' }]
      ),
      /不允许访问本机或局域网地址/
    )
  })

  it('keeps identity query parameters while removing credentials and fragments from display URLs', () => {
    assert.equal(
      sanitizeAgentMetadataUrl('https://example.test/detail?id=123&token=secret#cast'),
      'https://example.test/detail?id=123'
    )
  })
})

describe('Agent metadata browser evidence binding', () => {
  it('accepts a production artifact only for its captured document and view', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-evidence-'))
    try {
      const ref = await generateArtifact(root)
      assert.doesNotThrow(() => assertBrowserArtifactMatchesObservation(root, ref, {
        documentRevision: 'document-1',
        viewRevision: 'view-1'
      }))
      assert.throws(() => assertBrowserArtifactMatchesObservation(root, ref, {
        documentRevision: 'document-1',
        viewRevision: 'view-2'
      }), /PLAYLIST_IMPORT_BROWSER_EVIDENCE_STALE/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects incomplete, tampered, and corrupt segmented production artifacts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'javdex-browser-evidence-'))
    try {
      const expected = { documentRevision: 'document-1', viewRevision: 'view-1' }
      const incompleteRef = await generateArtifact(root, { evidenceIncomplete: true })
      assert.throws(
        () => assertBrowserArtifactMatchesObservation(root, incompleteRef, expected),
        /PLAYLIST_IMPORT_BROWSER_EVIDENCE_INCOMPLETE/
      )

      const intactRef = await generateArtifact(root)
      const intactPath = path.join(root, intactRef)
      const tampered = JSON.parse(fs.readFileSync(intactPath, 'utf8')) as Record<string, unknown>
      ;(tampered.observation as Record<string, unknown>).title = 'tampered after capture'
      fs.writeFileSync(intactPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8')
      assert.throws(
        () => assertBrowserArtifactMatchesObservation(root, intactRef, expected),
        /PLAYLIST_IMPORT_BROWSER_EVIDENCE_INVALID/
      )

      const segmentedRef = await generateArtifact(root, { snapshot: 'x'.repeat(30_000) })
      const segmentedIndex = JSON.parse(
        fs.readFileSync(path.join(root, segmentedRef), 'utf8')
      ) as { artifactTransport: { parts: Array<{ path: string }> } }
      assert.ok(segmentedIndex.artifactTransport.parts.length > 0)
      const partPath = path.join(root, segmentedIndex.artifactTransport.parts[0]!.path)
      const part = JSON.parse(fs.readFileSync(partPath, 'utf8')) as Record<string, unknown>
      part.sha256 = createHash('sha256').update('corrupt').digest('hex')
      fs.writeFileSync(partPath, JSON.stringify(part), 'utf8')
      assert.throws(
        () => assertBrowserArtifactMatchesObservation(root, segmentedRef, expected),
        /PLAYLIST_IMPORT_BROWSER_EVIDENCE_INVALID/
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
