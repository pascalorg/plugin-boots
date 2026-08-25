import { describe, expect, test } from 'bun:test'
import { jobDefinition } from './definition'
import { bootsHostPanel, bootsPlugin } from './index'
import { JobNode } from './schema'

describe('manifest', () => {
  test('plugin shape', () => {
    expect(bootsPlugin.id).toBe('pascal:boots')
    expect(bootsPlugin.apiVersion).toBe(1)
    expect(bootsPlugin.nodes).toHaveLength(1)
    expect(bootsPlugin.nodes?.[0]?.kind).toBe('boots:job')
  })

  test('host panel shape', () => {
    expect(bootsHostPanel.pluginId).toBe('pascal:boots')
    expect(bootsHostPanel.defaultInstalled).toBe(false)
    expect(typeof bootsHostPanel.component).toBe('function')
  })
})

describe('boots:job', () => {
  test('defaults parse through the schema', () => {
    const node = JobNode.parse(jobDefinition.defaults())
    expect(node.type).toBe('boots:job')
    expect(node.job).toBe('fix')
    expect(node.status).toBe('open')
    expect(node.id.startsWith('job')).toBe(true)
  })

  test('status round-trips', () => {
    const node = JobNode.parse({ status: 'done', job: 'paint' })
    expect(node.status).toBe('done')
    expect(node.job).toBe('paint')
  })

  test('footprint follows rotation', () => {
    const node = JobNode.parse({ rotation: [0, Math.PI / 4, 0] })
    const floorPlaced = jobDefinition.capabilities?.floorPlaced as {
      footprint: (n: unknown) => { dimensions: number[]; rotation: number[] }
    }
    const footprint = floorPlaced.footprint(node)
    expect(footprint.dimensions).toEqual([0.36, 0.55, 0.36])
    expect(footprint.rotation[1]).toBeCloseTo(Math.PI / 4)
  })
})
