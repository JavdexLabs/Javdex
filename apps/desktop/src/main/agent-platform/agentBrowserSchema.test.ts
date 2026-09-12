import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createAgentBrowserSchema } from './agentBrowserSchema'

describe('createAgentBrowserSchema', () => {
  it('exposes strict bounded vertical scroll branches without enabling input actions', () => {
    for (const allowInputActions of [false, true]) {
      const schema = createAgentBrowserSchema({ allowInputActions })
      const branches = schema.oneOf ?? []
      const scrollBranches = branches.filter((branch) => {
        const action = branch.properties?.action as { enum?: string[] } | undefined
        return action?.enum?.includes('scroll')
      })

      assert.equal(scrollBranches.length, 2)
      assert.deepEqual(
        scrollBranches.map((branch) => (
          branch.properties?.direction as { enum?: string[] } | undefined
        )?.enum),
        [['up', 'down'], ['start']]
      )
      assert.deepEqual(
        (scrollBranches[0].properties?.amount as { enum?: string[] }).enum,
        ['eighth-viewport', 'quarter-viewport', 'half-viewport', 'viewport']
      )
      assert.equal(scrollBranches[1].properties?.amount, undefined)
      assert.equal(scrollBranches.every((branch) => branch.additionalProperties === false), true)
    }
  })

  it('explains the evaluate restrictions and their supported alternatives before invocation', () => {
    const schema = createAgentBrowserSchema()
    const evaluate = (schema.oneOf ?? []).find((branch) => {
      const action = branch.properties?.action as { enum?: string[] } | undefined
      return action?.enum?.includes('evaluate')
    })
    const expression = evaluate?.properties?.expression as { description?: string } | undefined
    const description = expression?.description ?? ''

    assert.match(description, /计算属性/)
    assert.match(description, /array\[index\]/)
    assert.match(description, /getAttribute/)
    assert.match(description, /innerHTML/)
    assert.match(description, /outerHTML/)
    assert.match(description, /html/)
    assert.match(description, /\.href/)
    assert.match(description, /\.at\(n\)/)
    assert.match(description, /直接返回对象或数组/)
  })
})
