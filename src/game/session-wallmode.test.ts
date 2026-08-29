import { beforeEach, describe, expect, test } from 'bun:test'
import { useViewer } from '@pascal-app/viewer'
import { Group, Mesh, type Object3D } from 'three'
import { forceFullHeightWallMode, planWallBatchSweep } from './session'

/**
 * Full-height presence (owner report 2026-08-29): the game always STARTS at
 * the host's 'up' (Full height) wall display mode — 'down' stipples every
 * wall, 'cutaway' glasses camera-facing exteriors, 'translucent' fades
 * everything, and dormant conforming-shell targets keep the HOST look, so
 * any of those would leak ghost walls into first person. enterGame must
 * force 'up' and the teardown must restore the EXACT prior mode.
 *
 * The companion bug: in 'up' mode the host merges each level's walls into
 * one `wall-batch` presentation mesh and takes the member walls off the
 * scene layer — destruction's host→voxel swap then hides a mesh that was
 * not the one drawing, and the merged copy renders the wall "forever up".
 * planWallBatchSweep is the pure planner behind the session's neutralizer.
 */

type ViewerStub = {
  getState: () => { wallMode: string }
  setState: (partial: Record<string, unknown>) => void
}
const viewer = useViewer as unknown as ViewerStub

const setMode = (mode: string) => viewer.setState({ wallMode: mode })

beforeEach(() => setMode('up'))

describe('forceFullHeightWallMode', () => {
  test.each(['cutaway', 'down', 'translucent'])(
    '%s → forced up, teardown restores it',
    (mode) => {
      setMode(mode)
      const teardown: Array<() => void> = []
      forceFullHeightWallMode(teardown)
      expect(viewer.getState().wallMode).toBe('up')
      expect(teardown).toHaveLength(1)
      for (const fn of teardown.splice(0)) fn()
      expect(viewer.getState().wallMode).toBe(mode)
    },
  )

  test('up → untouched, no teardown entry', () => {
    const teardown: Array<() => void> = []
    forceFullHeightWallMode(teardown)
    expect(viewer.getState().wallMode).toBe('up')
    expect(teardown).toHaveLength(0)
  })

  test('restore lands the prior mode even if the game changed it again', () => {
    setMode('down')
    const teardown: Array<() => void> = []
    forceFullHeightWallMode(teardown)
    setMode('translucent')
    for (const fn of teardown.splice(0)) fn()
    expect(viewer.getState().wallMode).toBe('down')
  })

  test('missing setWallMode on an older host is a no-op, never a throw', () => {
    const state = viewer.getState() as Record<string, unknown>
    const saved = state.setWallMode
    viewer.setState({ setWallMode: undefined, wallMode: 'down' })
    const teardown: Array<() => void> = []
    expect(() => forceFullHeightWallMode(teardown)).not.toThrow()
    expect(viewer.getState().wallMode).toBe('down')
    expect(teardown).toHaveLength(0)
    viewer.setState({ setWallMode: saved })
  })
})

// ── planWallBatchSweep ──────────────────────────────────────────────────────

const SCENE_BIT = 1 << 0
const BATCHED_BIT = 1 << 5

/** A level root with an optional live `wall-batch` presentation child. */
function level(withBatch: boolean): { root: Group; batch: Mesh | null } {
  const root = new Group()
  let batch: Mesh | null = null
  if (withBatch) {
    batch = new Mesh()
    batch.name = 'wall-batch'
    root.add(batch)
  }
  return { root, batch }
}

/** A wall mesh in one of the states the sweep must tell apart. */
function wallMesh(mask: number, visible = true): Mesh {
  const mesh = new Mesh()
  mesh.layers.mask = mask
  mesh.visible = visible
  return mesh
}

const plan = (roots: Object3D[], walls: Object3D[]) =>
  planWallBatchSweep(roots, walls, SCENE_BIT, BATCHED_BIT)

describe('planWallBatchSweep', () => {
  test('no live batch → nothing hidden, nothing revealed', () => {
    const { root } = level(false)
    const held = wallMesh(BATCHED_BIT)
    const out = plan([root], [held])
    expect(out.batches).toHaveLength(0)
    expect(out.reveals).toHaveLength(0)
  })

  test('live batch → batch listed, batch-held wall revealed onto the scene layer', () => {
    const { root, batch } = level(true)
    const held = wallMesh(BATCHED_BIT)
    const out = plan([root], [held])
    expect(out.batches).toEqual([batch!])
    expect(out.reveals).toEqual([{ mesh: held, from: BATCHED_BIT, to: BATCHED_BIT | SCENE_BIT }])
  })

  test('an already-hidden batch mesh is not re-collected', () => {
    const { root, batch } = level(true)
    batch!.visible = false
    const out = plan([root], [wallMesh(BATCHED_BIT)])
    expect(out.batches).toHaveLength(0)
    expect(out.reveals).toHaveLength(0)
  })

  test('game-hidden walls stay hidden: mask 0 (maskForGame) and visible=false (hideForGame)', () => {
    const { root } = level(true)
    const masked = wallMesh(0)
    const flipped = wallMesh(BATCHED_BIT, false)
    const out = plan([root], [masked, flipped])
    expect(out.reveals).toHaveLength(0)
  })

  test('walls already drawing themselves are untouched', () => {
    const { root } = level(true)
    const own = wallMesh(SCENE_BIT)
    const out = plan([root], [own])
    expect(out.reveals).toHaveLength(0)
  })

  test("scene-off WITHOUT the batched bit is the host's solo/isolation hold — not undone", () => {
    const { root } = level(true)
    const isolated = wallMesh(1 << 4) // shadow-only, no batched bit
    const out = plan([root], [isolated])
    expect(out.reveals).toHaveLength(0)
  })

  test('non-batch level children are never collected', () => {
    const { root } = level(false)
    const decoy = new Mesh()
    decoy.name = 'zone-fill'
    root.add(decoy)
    const out = plan([root], [wallMesh(BATCHED_BIT)])
    expect(out.batches).toHaveLength(0)
  })

  test('batches on any level are found; reveal preserves unrelated mask bits', () => {
    const a = level(false)
    const b = level(true)
    const held = wallMesh(BATCHED_BIT | (1 << 3))
    const out = plan([a.root, b.root], [held])
    expect(out.batches).toEqual([b.batch!])
    expect(out.reveals).toEqual([
      { mesh: held, from: BATCHED_BIT | (1 << 3), to: BATCHED_BIT | (1 << 3) | SCENE_BIT },
    ])
  })
})
