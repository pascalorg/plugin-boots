import { describe, expect, test } from 'bun:test'
import { bootsPlugin } from './index'
import { bootsRenderPlugin } from './render'

/** Fields that only an editing host reads; a render definition must not carry them. */
const EDIT_ONLY_FIELDS = [
  'snapProfile',
  'parametrics',
  'system',
  'preview',
  'tool',
  'toolHints',
  'floorplanAffordances',
  'floorplanMoveTarget',
] as const

describe('render entry', () => {
  test('same manifest identity and kinds as the root plugin', () => {
    expect(bootsRenderPlugin.id).toBe(bootsPlugin.id)
    expect(bootsRenderPlugin.apiVersion).toBe(bootsPlugin.apiVersion)
    const rootNodes = bootsPlugin.nodes ?? []
    expect(bootsRenderPlugin.nodes.map((n) => n.kind)).toEqual(rootNodes.map((n) => n.kind))
    for (const [i, renderNode] of bootsRenderPlugin.nodes.entries()) {
      const rootNode = rootNodes[i]!
      expect(renderNode.schema).toBe(rootNode.schema)
      expect(renderNode.schemaVersion).toBe(rootNode.schemaVersion)
      expect(renderNode.defaults()).toEqual(rootNode.defaults())
      expect(renderNode.renderer).toBe(rootNode.renderer)
    }
  })

  test('render definitions carry no edit-only fields', () => {
    for (const node of bootsRenderPlugin.nodes) {
      for (const field of EDIT_ONLY_FIELDS) expect(node).not.toHaveProperty(field)
    }
  })

  test('the root definition keeps its editing contributions', () => {
    const job = bootsPlugin.nodes?.[0] as unknown as Record<string, unknown>
    expect(job.snapProfile).toBe('item')
    expect(job.parametrics).toBeDefined()
    expect(job.system).toBeDefined()
  })
})
