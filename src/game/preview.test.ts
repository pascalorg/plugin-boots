import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { nodeRegistry, sceneRegistry, useScene } from '@pascal-app/core'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToString } from 'react-dom/server'
import {
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
} from 'three'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import { geometryForMask, WALL_H } from './builder'
import type { OpeningEntry } from './inventory'
import type { PlacedAperture, PlacedItem } from './item-place'
import { discardPlaced, keepPlaced } from './keep'
import type { PaintedNode } from './paint-keep'
import {
  applyNodePreview,
  PENDING_TINT,
  PreviewTree,
  previewPieceGeometry,
  previewPiecePose,
  restoreNodePreview,
  shouldPreview,
  wallFrameFromScene,
} from './preview'
import { cornerRoofGeometry } from './roof-corners'
import type { DestroyedNode } from './save-demolition'

/**
 * THE PENDING-CHANGES PREVIEW, pinned by its invariants rather than its call
 * sites (preview.tsx).
 *
 * Four things have to be true, and each of these tests fails if either of them
 * breaks — the preview vanishing AND the preview overreaching:
 *
 *  1. THE GATE. It shows exactly when the Boots menu is asking Save or
 *     Discard and there is something to decide about; never during play,
 *     never after the decision resolves, and it renders no objects for a lane
 *     that is empty. Save and Discard really do close it (both bridges clear
 *     `pendingDecision`) — asserted through the real bridges, not the store
 *     action they happen to call.
 *  2. THE ROUND-TRIP. Paint and demolition are the only lanes that touch host
 *     objects. Every flip is recorded before it happens and restored on
 *     teardown, so a torn-down preview leaves `visible` and material colour
 *     byte-identical — including the host's own material datablock, which is
 *     never mutated even WHILE the preview is up (the mesh wears a clone).
 *  3. ZERO SCENE WRITES. The product promise is that only the Save button
 *     writes the document. Pinned twice: structurally (the module's ONLY
 *     `useScene` contact is a `.nodes` read, and it names no bridge writer)
 *     and live (a full mount → teardown leaves the nodes map
 *     object-identical, in the spirit of shared-invariant.test.ts).
 *  4. RE-ENTRY. Mount → teardown → mount previews correctly the second time
 *     and leaks nothing: the ledger drains, geometry comes from the shared
 *     caches, and the pieces' material is one never-mutated singleton.
 */

// --- Fixtures ---------------------------------------------------------------

/** Register a root under a kind the way the host's useRegistry does. */
function register(id: string, kind: string, root: Object3D): () => void {
  sceneRegistry.nodes.set(id, root)
  sceneRegistry.byType[kind]!.add(id)
  return () => {
    sceneRegistry.nodes.delete(id)
    sceneRegistry.byType[kind]!.delete(id)
  }
}

const cleanups: Array<() => void> = []

/** A registered host node: one root group holding one paintable mesh.
 * `PlaneGeometry` has four vertices, so collectMeshes' degeneracy floor
 * (≥ 3 positions) accepts it. */
function hostNode(id: string, kind: string, color: string) {
  const root = new Group()
  const material = new MeshStandardMaterial({ color })
  // Typed as the wide Mesh so a test can hand it a material ARRAY: the ledger
  // has to round-trip both shapes.
  const mesh: Mesh = new Mesh(new PlaneGeometry(1, 1), material)
  root.add(mesh)
  cleanups.push(register(id, kind, root))
  return { root, mesh, material }
}

/** A registered host node with NO mesh of its own — the container shape (a
 * roof whose planes are separately registered segment children). */
function containerNode(id: string, kind: string) {
  const root = new Group()
  cleanups.push(register(id, kind, root))
  return root
}

const coat = (nodeId: string, color: string): PaintedNode => ({
  nodeId,
  color,
  colorName: 'test coat',
  cells: 7,
})

const levelled = (nodeId: string): DestroyedNode => ({ nodeId, kind: 'wall' })

const piece = (over: Partial<PlacedPiece> = {}): PlacedPiece => ({
  id: 1,
  piece: 'wall',
  position: [1.5, 0, 3],
  yaw: 0,
  mask: FULL_MASK,
  ...over,
})

const NO_LANES = { pieces: 0, items: 0, destroyed: 0, painted: 0 }

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

// --- 1. The gate ------------------------------------------------------------

describe('the mount condition', () => {
  test('in the editor + any one lane — and nothing when every lane is empty', () => {
    expect(shouldPreview('editor', NO_LANES)).toBe(false)
    for (const lane of ['pieces', 'items', 'destroyed', 'painted'] as const) {
      expect(shouldPreview('editor', { ...NO_LANES, [lane]: 1 }), lane).toBe(true)
    }
  })

  test('never during play', () => {
    const busy = { pieces: 3, items: 2, destroyed: 1, painted: 4 }
    // The game renders the real thing; a preview on top would be a second,
    // stale copy of every piece.
    expect(shouldPreview('game', busy)).toBe(false)
  })

  test('a lane that outlives its session still shows', () => {
    // The regression this replaces: the gate used to need a `pendingDecision`
    // flag that only Esc set and re-entry cleared, so pieces the player had
    // never decided about became invisible — after a re-entry, and after every
    // reload once the lanes became durable (pending-store.ts). Non-empty lanes
    // in the editor IS the condition.
    expect(shouldPreview('editor', { ...NO_LANES, pieces: 7 })).toBe(true)
  })
})

describe('Save and Discard close the preview', () => {
  beforeEach(() => {
    useBoots.getState().resolvePlaced()
    useScene.getState().setScene({}, [])
  })

  /** The pieces lane as the gate sees it. */
  const gate = () =>
    shouldPreview(useBoots.getState().phase, {
      ...NO_LANES,
      pieces: useBoots.getState().placed.length,
    })

  test('discardPlaced empties the lane', () => {
    useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    expect(gate()).toBe(true)
    discardPlaced()
    expect(useBoots.getState().placed).toEqual([])
    expect(gate()).toBe(false)
  })

  test('keepPlaced empties the lane', () => {
    // The registry-less give-up path (keep.ts) — it resolves the session
    // exactly like the schema path does, and writes no nodes, so this pins
    // the lifecycle without a host schema fixture (keep.test.ts owns those).
    nodeRegistry._reset()
    useBoots.getState().addPlaced({ piece: 'wall', position: [0, 0, 0], yaw: 0 })
    expect(gate()).toBe(true)
    keepPlaced()
    expect(useBoots.getState().placed).toEqual([])
    expect(gate()).toBe(false)
  })
})

// --- 2. The restore ledger --------------------------------------------------

describe('the restore ledger round-trips', () => {
  test('visible and material colour are byte-identical after teardown', () => {
    const wall = hostNode('rt-wall', 'wall', '#c0ffee')
    const doomed = hostNode('rt-doomed', 'wall', '#123456')

    const beforeVisible = doomed.root.visible
    const beforeMaterial = wall.mesh.material
    const beforeHex = wall.material.color.getHexString()

    const ledger = applyNodePreview([levelled('rt-doomed')], [coat('rt-wall', '#ff0000')])

    // The preview must actually DO something, or the round-trip below is
    // vacuous: this is the half of the test that fails the other way.
    expect(doomed.root.visible).toBe(false)
    expect(wall.mesh.material).not.toBe(beforeMaterial)
    expect((wall.mesh.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000')
    // And the host's own datablock is untouched even WHILE the preview is up
    // — the mesh wears a clone, so nothing has to be un-edited.
    expect(wall.material.color.getHexString()).toBe(beforeHex)

    restoreNodePreview(ledger)

    expect(doomed.root.visible).toBe(beforeVisible)
    expect(wall.mesh.material).toBe(beforeMaterial)
    expect(wall.material.color.getHexString()).toBe(beforeHex)
    expect(ledger.hidden).toHaveLength(0)
    expect(ledger.tinted).toHaveLength(0)
  })

  test('a multi-material mesh gets its exact array instance back', () => {
    const wall = hostNode('rt-multi', 'wall', '#ffffff')
    const materials: Material[] = [
      new MeshStandardMaterial({ color: '#111111' }),
      new MeshStandardMaterial({ color: '#222222' }),
    ]
    wall.mesh.material = materials

    const ledger = applyNodePreview([], [coat('rt-multi', '#00ff00')])
    const previewed = wall.mesh.material as Material[]
    expect(Array.isArray(previewed)).toBe(true)
    expect(previewed).not.toBe(materials)
    expect(previewed).toHaveLength(2)
    for (const material of previewed) {
      expect((material as MeshStandardMaterial).color.getHexString()).toBe('00ff00')
    }

    restoreNodePreview(ledger)
    expect(wall.mesh.material).toBe(materials)
    expect((materials[0] as MeshStandardMaterial).color.getHexString()).toBe('111111')
    expect((materials[1] as MeshStandardMaterial).color.getHexString()).toBe('222222')
  })

  test('restoring twice is a no-op — the ledger owns each value exactly once', () => {
    const wall = hostNode('rt-twice', 'wall', '#abcdef')
    const original = wall.mesh.material
    const ledger = applyNodePreview([levelled('rt-twice')], [])
    restoreNodePreview(ledger)
    expect(wall.root.visible).toBe(true)
    // A teardown racing a re-entry must not re-apply anything.
    wall.root.visible = false
    restoreNodePreview(ledger)
    expect(wall.root.visible).toBe(false)
    expect(wall.mesh.material).toBe(original)
  })

  test('an already-invisible node records no flip (restoring it would be a change)', () => {
    const wall = hostNode('rt-hidden', 'wall', '#ffffff')
    wall.root.visible = false
    const ledger = applyNodePreview([levelled('rt-hidden')], [])
    expect(ledger.hidden).toHaveLength(0)
    restoreNodePreview(ledger)
    expect(wall.root.visible).toBe(false)
  })

  test('a node the registry does not know is skipped, not thrown on', () => {
    const ledger = applyNodePreview([levelled('rt-ghost')], [coat('rt-ghost-2', '#ff0000')])
    expect(ledger.hidden).toHaveLength(0)
    expect(ledger.tinted).toHaveLength(0)
  })
})

describe('the paint lane tints the node Save would patch, and nothing else', () => {
  test('the sweep fences at the door hosted inside the wall', () => {
    const wall = hostNode('fence-wall', 'wall', '#ffffff')
    const doorMaterial = new MeshStandardMaterial({ color: '#00ff00' })
    const doorMesh = new Mesh(new PlaneGeometry(1, 1), doorMaterial)
    const doorRoot = new Group()
    doorRoot.add(doorMesh)
    wall.root.add(doorRoot)
    cleanups.push(register('fence-door', 'door', doorRoot))

    const ledger = applyNodePreview([], [coat('fence-wall', '#ff0000')])
    expect((wall.mesh.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000')
    // The door is its own node — Save patches it separately, or not at all.
    expect(doorMesh.material).toBe(doorMaterial)
    restoreNodePreview(ledger)
  })

  test('a CONTAINER node with no mesh of its own falls back to the unfenced sweep', () => {
    // A roof's planes are registered roof-segment children: the fenced sweep
    // stops at every one of them and finds nothing, yet Save patches the
    // container and the host propagates the coat down.
    const roof = containerNode('fb-roof', 'roof')
    const segment = hostNode('fb-segment', 'roof-segment', '#ffffff')
    roof.add(segment.root)

    const ledger = applyNodePreview([], [coat('fb-roof', '#0000ff')])
    expect(ledger.tinted).toHaveLength(1)
    expect((segment.mesh.material as MeshStandardMaterial).color.getHexString()).toBe('0000ff')
    restoreNodePreview(ledger)
    expect(segment.mesh.material).toBe(segment.material)
  })

  test('demolition beats paint on the same node — the Save order', () => {
    // deleteDestroyed() runs before applyPaint() precisely so a node deleted
    // above is not patched below; the preview mirrors it.
    const wall = hostNode('both-wall', 'wall', '#ffffff')
    const original = wall.mesh.material
    const ledger = applyNodePreview([levelled('both-wall')], [coat('both-wall', '#ff0000')])
    expect(wall.root.visible).toBe(false)
    expect(wall.mesh.material).toBe(original)
    expect(ledger.tinted).toHaveLength(0)
    restoreNodePreview(ledger)
    expect(wall.root.visible).toBe(true)
  })
})

// --- 3. Zero scene writes ---------------------------------------------------

const previewSource = (): Promise<string> =>
  Bun.file(new URL('./preview.tsx', import.meta.url).pathname).text()

/** Source with comments stripped — the header essay discusses the writes it
 * refuses to make at length, and the scan must read code, not prose. */
const codeOf = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('the preview cannot write the scene', () => {
  test('its only useScene contact is the import and one .nodes read', async () => {
    const code = codeOf(await previewSource())
    const contacts = [...code.matchAll(/useScene(\.getState\(\)\.nodes)?/g)].map((m) => m[0])
    expect(contacts).toEqual(['useScene', 'useScene.getState().nodes'])
  })

  test('it names no store mutator and no Save bridge writer', async () => {
    const code = codeOf(await previewSource())
    for (const banned of [
      'updateNodes',
      'updateNode(',
      'deleteNodes',
      'setScene',
      'markDirty',
      'createNode',
      'addNodes',
      'setState(',
      // The four Save bridges' write entry points — shared-invariant.test.ts
      // declares them the only scene writers in the plugin, and the preview
      // must not become a fifth by calling one.
      'keepPlaced',
      'applyPaint',
      'applyItems',
      'deleteDestroyed',
    ]) {
      expect(code, banned).not.toContain(banned)
    }
  })

  test('a full mount → teardown leaves the nodes map object-identical', () => {
    const seeded = {
      'wall_zwa': {
        id: 'wall_zwa',
        type: 'wall',
        start: [0, 0],
        end: [4, 0],
        height: 2.5,
        thickness: 0.15,
      },
      'wall_zwb': { id: 'wall_zwb', type: 'wall', start: [0, 2], end: [4, 2] },
    }
    useScene.getState().setScene(seeded as never, ['wall_zwa', 'wall_zwb'])
    const wall = hostNode('wall_zwa', 'wall', '#ffffff')
    hostNode('wall_zwb', 'wall', '#ffffff')

    const before = useScene.getState().nodes
    const beforeJson = JSON.stringify(before)

    // The whole tree: pieces, an item, a pending door on a real wall, plus
    // both ledger lanes applied and torn down.
    const html = renderQuietly(
      createElement(PreviewTree, {
        destroyed: [levelled('wall_zwb')],
        items: [ITEM, aperture('wall_zwa')],
        painted: [coat('wall_zwa', '#ff0000')],
        placed: [piece(), piece({ id: 2, piece: 'stairs' })],
      }),
    )
    expect(html.length).toBeGreaterThan(0)
    // The door frame really was posed off the scene wall — the read happened.
    expect(wallFrameFromScene('wall_zwa')?.length).toBeCloseTo(4, 6)

    const ledger = applyNodePreview([levelled('wall_zwb')], [coat('wall_zwa', '#ff0000')])
    expect(ledger.hidden.length + ledger.tinted.length).toBeGreaterThan(0)
    restoreNodePreview(ledger)

    const after = useScene.getState().nodes
    // Object identity: not even a defensive re-spread of the nodes map.
    expect(after).toBe(before)
    expect(JSON.stringify(after)).toBe(beforeJson)
    expect(wall.mesh.material).toBe(wall.material)
  })
})

// --- 4. The tree, and re-entry ----------------------------------------------

/** react-dom/server doesn't know r3f host tags — it renders them fine but
 * logs casing/attribute warnings. Silence console.error for the duration
 * (the weapon-models.test.ts idiom). */
function renderQuietly(element: ReactElement): string {
  const original = console.error
  console.error = () => {}
  try {
    return renderToString(element)
  } finally {
    console.error = original
  }
}

/** Every host tag and component name in a rendered element tree. */
function tags(node: ReactNode, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) tags(child, out)
    return out
  }
  if (!isValidElement(node)) return out
  const element = node as ReactElement<{ children?: ReactNode }>
  out.push(
    typeof element.type === 'string'
      ? element.type
      : ((element.type as { name?: string }).name ?? '?'),
  )
  tags(element.props.children, out)
  return out
}

const OPENING: OpeningEntry = {
  opening: true,
  id: 'test-door',
  category: 'doors',
  name: 'Test door',
  thumbnail: '',
  node: 'door',
  doorType: 'hinged',
  width: 0.9,
  height: 2.05,
  sill: 0,
}

const aperture = (wallId: string): PlacedAperture => ({
  kind: 'aperture',
  id: 91,
  def: OPENING,
  wallId,
  u: 1,
  v: 1.025,
  width: 0.9,
  height: 2.05,
})

const ITEM: PlacedItem = {
  kind: 'item',
  id: 92,
  asset: { id: 'test-crate', name: 'Crate', width: 0.6, depth: 0.6, height: 0.6 } as never,
  position: [2, 0, 2],
  yaw: 0,
}

describe('the tree renders one object per pending thing, and none per empty lane', () => {
  test('every lane empty: the root group and the ledger, nothing else', () => {
    const props = { destroyed: [], items: [], painted: [], placed: [] }
    // The root group plus the ledger lane — and not one object more.
    expect(tags(PreviewTree(props))).toEqual(['group', 'NodeLedger'])
    const html = renderQuietly(createElement(PreviewTree, props))
    expect(html).toContain('<group')
    expect(html).not.toContain('<mesh')
  })

  test('pieces become meshes, items and apertures their own subtrees', () => {
    const props = {
      destroyed: [],
      items: [ITEM, aperture('missing-wall')],
      painted: [],
      placed: [piece(), piece({ id: 2, piece: 'floor' }), piece({ id: 3, piece: 'stairs' })],
    }
    const named = tags(PreviewTree(props))
    expect(named.filter((t) => t === 'PreviewPiece')).toHaveLength(3)
    expect(named.filter((t) => t === 'PreviewItem')).toHaveLength(1)
    expect(named.filter((t) => t === 'PreviewAperture')).toHaveLength(1)
    expect(named).toContain('NodeLedger')
    // Rendered for real: three pieces → three meshes. The aperture's wall is
    // not in the scene, so it poses against nothing and renders null.
    const html = renderQuietly(createElement(PreviewTree, props))
    expect(html.split('<mesh').length - 1).toBe(3)
  })

  test('a piece whose every cell was edited out renders nothing', () => {
    expect(previewPieceGeometry(piece({ mask: 0 }))).toBeNull()
    const html = renderQuietly(
      createElement(PreviewTree, {
        destroyed: [],
        items: [],
        painted: [],
        placed: [piece({ mask: 0 })],
      }),
    )
    expect(html).not.toContain('<mesh')
  })
})

describe('pieces preview through builder.tsx own seams', () => {
  test('geometry is the shared cached instance — a re-mount allocates nothing', () => {
    const first = previewPieceGeometry(piece())
    const second = previewPieceGeometry(piece({ id: 77 }))
    expect(first).not.toBeNull()
    // Same instance across mounts AND across piece objects of the same shape:
    // the second Esc previews from exactly what the first one used.
    expect(second).toBe(first)
    expect(first).toBe(geometryForMask('wall', FULL_MASK, WALL_H))
  })

  test('a corner roof takes the bilinear patch, not the mask box', () => {
    const corners: [number, number, number, number] = [1, 0, 1, 0]
    const roof = piece({ piece: 'roof', corners, height: 2.5 })
    expect(previewPieceGeometry(roof)).toBe(cornerRoofGeometry(corners, 2.5))
    // …and sits flat at its base elevation: the heights are IN the geometry.
    const pose = previewPiecePose(roof)
    expect(pose.position[1]).toBe(roof.position[1])
    expect(pose.rotation[0]).toBe(0)
  })

  test('walls centre on their storey span, the stairs plank tilts', () => {
    const wall = previewPiecePose(piece({ position: [0, 3, 0], height: 2.5 }))
    expect(wall.position[1]).toBeCloseTo(3 + 2.5 / 2, 10)
    expect(wall.rotation[0]).toBe(0)
    const stairs = previewPiecePose(piece({ piece: 'stairs' }))
    expect(stairs.rotation[0]).toBeLessThan(0)
    // Yaw always rides through untouched.
    expect(previewPiecePose(piece({ yaw: Math.PI / 2 })).rotation[1]).toBeCloseTo(Math.PI / 2, 10)
  })

  test('the pending tint is one never-mutated singleton', () => {
    const hex = PENDING_TINT.color.getHexString()
    renderQuietly(
      createElement(PreviewTree, {
        destroyed: [],
        items: [],
        painted: [],
        placed: [piece(), piece({ id: 2 })],
      }),
    )
    expect(PENDING_TINT.color.getHexString()).toBe(hex)
    // Distinct from the game's own placed-piece grey (#9aa8b5): the viewport
    // has to say these are not real nodes yet.
    expect(hex).not.toBe('9aa8b5')
  })
})

describe('re-entry: mount → teardown → mount previews again and leaks nothing', () => {
  test('the second cycle flips the same objects and restores them the same way', () => {
    const wall = hostNode('re-wall', 'wall', '#c0ffee')
    const doomed = hostNode('re-doomed', 'wall', '#123456')
    const pristine = {
      material: wall.mesh.material,
      hex: wall.material.color.getHexString(),
      visible: doomed.root.visible,
    }
    const destroyed = [levelled('re-doomed')]
    const painted = [coat('re-wall', '#ff0000')]

    const seen: Array<{ hidden: number; tinted: number }> = []
    for (let cycle = 0; cycle < 2; cycle++) {
      const ledger = applyNodePreview(destroyed, painted)
      seen.push({ hidden: ledger.hidden.length, tinted: ledger.tinted.length })
      expect(doomed.root.visible).toBe(false)
      expect((wall.mesh.material as MeshStandardMaterial).color.getHexString()).toBe('ff0000')
      restoreNodePreview(ledger)
      expect(wall.mesh.material).toBe(pristine.material)
      expect(wall.material.color.getHexString()).toBe(pristine.hex)
      expect(doomed.root.visible).toBe(pristine.visible)
    }
    // Identical work both times: no accumulation, no ledger that grew.
    expect(seen[1]).toEqual(seen[0]!)
    // And no orphan children were left hanging off the host objects.
    expect(wall.root.children).toHaveLength(1)
    expect(doomed.root.children).toHaveLength(1)
  })

  test('nested apply/restore pairs unwind to the pristine material', () => {
    const wall = hostNode('sm-wall', 'wall', '#ffffff')
    const original = wall.mesh.material
    // The strictest ordering a remount can produce: apply, apply again, then
    // the two teardowns in reverse. Each ledger owns only what IT swapped.
    const first = applyNodePreview([], [coat('sm-wall', '#ff0000')])
    const second = applyNodePreview([], [coat('sm-wall', '#00ff00')])
    restoreNodePreview(second)
    restoreNodePreview(first)
    expect(wall.mesh.material).toBe(original)
    expect((original as MeshStandardMaterial).color.getHexString()).toBe('ffffff')
  })
})
