import { beforeEach, describe, expect, test } from 'bun:test'
import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { type CatalogEntry, type OpeningEntry } from './game/inventory'
import { type Placement, useItems } from './game/item-place'
import { type PaintedNode, usePaintKeep } from './game/paint-keep'
import { type DestroyedNode, useDemolition } from './game/save-demolition'
import BootsPanel, {
  discardSessionChanges,
  nodeLabel,
  PendingChanges,
  type PendingGroup,
  pendingChangeGroups,
  type SaveBridges,
  saveSessionChanges,
} from './panel'
import { type BuildPiece, type PlacedPiece, useBoots } from './store'

/**
 * THE PENDING-CHANGES LIST — the sidebar between Esc and the decision.
 *
 * The panel used to print four counts ("You built 12 pieces"); it now lists
 * WHAT is pending, one row per thing, so the owner can see the ramps he placed
 * and the walls he sprayed before choosing Save or Discard. The rows are a
 * VIEW: no per-row toggle, and Save/Discard stay global.
 *
 * These tests pin behavior, not markup. `pendingChangeGroups` is the whole
 * decision — which rows exist, what they read, where the cap folds — so it is
 * asserted directly, and `PendingChanges` is rendered to prove the rows reach
 * the screen (including the paint swatch, which only exists as a color).
 *
 * The panel itself is only smoke-rendered: under `renderToString` zustand v5
 * serves its INITIAL state (getServerSnapshot === getInitialState), so a
 * server-rendered panel can never show seeded stores. That is an SSR artifact,
 * not the panel's behavior — don't chase it with a DOM.
 */

const nodes = (
  list: ReadonlyArray<{ id: string; type?: string; name?: string }>,
): Record<string, unknown> => {
  const record: Record<string, unknown> = {}
  for (const node of list) record[node.id] = node
  return record
}

const piece = (
  id: number,
  kind: BuildPiece,
  position: [number, number, number],
): PlacedPiece => ({ id, piece: kind, position, yaw: 0, mask: 0b111111111 })

const leveled = (nodeId: string, kind: 'wall' | 'volume' = 'wall'): DestroyedNode => ({
  nodeId,
  kind,
})

const coat = (nodeId: string, color: string, colorName: string): PaintedNode => ({
  nodeId,
  color,
  colorName,
  cells: 4,
})

const asset = (name: string): CatalogEntry => ({
  id: `asset-${name}`,
  category: 'furniture',
  name,
  thumbnail: 'https://cdn.test/thumb.png',
  src: 'https://cdn.test/model.glb',
  dimensions: [1, 1, 1],
  offset: [0, 0, 0],
})

const opening = (name: string): OpeningEntry => ({
  opening: true,
  id: `opening-${name}`,
  category: 'Openings',
  name,
  thumbnail: 'data:image/svg+xml,',
  node: 'door',
  doorType: 'double',
  width: 1.8,
  height: 2.1,
  sill: 0,
})

const furniture = (id: number, name: string, position: [number, number, number]): Placement => ({
  kind: 'item',
  id,
  asset: asset(name),
  position,
  yaw: 0,
})

const aperture = (id: number, name: string, wallId: string): Placement => ({
  kind: 'aperture',
  id,
  def: opening(name),
  wallId,
  u: 1,
  v: 1.05,
  width: 1.8,
  height: 2.1,
})

/** The four lanes, defaulting to empty — every test names only its own lane. */
const groupsOf = (input: {
  placed?: readonly PlacedPiece[]
  destroyed?: readonly DestroyedNode[]
  painted?: readonly PaintedNode[]
  items?: readonly Placement[]
  nodes?: Record<string, unknown>
}): PendingGroup[] =>
  pendingChangeGroups({
    placed: input.placed ?? [],
    destroyed: input.destroyed ?? [],
    painted: input.painted ?? [],
    items: input.items ?? [],
    nodes: input.nodes ?? {},
  })

const group = (all: PendingGroup[], key: PendingGroup['key']): PendingGroup => {
  const found = all.find((g) => g.key === key)
  if (!found) throw new Error(`no ${key} group`)
  return found
}

/** Every row of a group as the rail reads it: "Ramp x 4.5, z 1.5". */
const lines = (g: PendingGroup): string[] =>
  g.rows.map((row) => (row.detail ? `${row.label} ${row.detail}` : row.label))

/** Rendered rows as plain text — tags out (React's SSR comment markers with
 * them), whitespace collapsed. */
const render = (all: PendingGroup[]): string =>
  renderToString(createElement(PendingChanges, { groups: all }))
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

describe('the Built lane', () => {
  test('every piece gets its own row, and the tilted plank reads as a ramp', () => {
    const all = groupsOf({
      placed: [
        piece(1, 'wall', [1.5, 0, 1.5]),
        piece(2, 'stairs', [4.5, 0, 1.5]),
        piece(3, 'stairs', [7.5, 2.8, 1.5]),
      ],
    })
    const built = group(all, 'built')

    expect(built.title).toBe('Built')
    expect(built.count).toBe(3)
    expect(lines(built)).toEqual([
      'Wall x 1.5, z 1.5',
      // The owner's word for the piece the store calls 'stairs'.
      'Ramp x 4.5, z 1.5',
      // Off the ground floor the row says so; on it, no third number.
      'Ramp x 7.5, z 1.5, y 2.8',
    ])
    expect(lines(built).join(' ')).not.toContain('Stairs')
  })

  test('floors and roofs get their own labels and the conversion caveat', () => {
    const built = group(
      groupsOf({ placed: [piece(1, 'floor', [1.5, 0, 1.5]), piece(2, 'roof', [1.5, 2.8, 1.5])] }),
      'built',
    )

    expect(lines(built)).toEqual(['Floor x 1.5, z 1.5', 'Roof x 1.5, z 1.5, y 2.8'])
    expect(built.caveat).toContain('Saving turns these into real nodes (undoable).')
    expect(built.caveat).toContain('Ramps and roofs try to become real roof segments')
    expect(built.caveat).toContain('floors try to become real slabs')
  })

  test('a wall-only session keeps the roof/slab small print out of the way', () => {
    const built = group(groupsOf({ placed: [piece(1, 'wall', [1.5, 0, 1.5])] }), 'built')

    expect(built.caveat).toBe('Saving turns these into real nodes (undoable).')
  })

  test('the cap folds a long lane and never hides a whole piece kind', () => {
    // Eight walls and two ramps: one chronological cap would have shown eight
    // walls and swallowed the ramps — the exact thing he asked to see.
    const walls = Array.from({ length: 8 }, (_, i) => piece(i + 1, 'wall', [i, 0, 0]))
    const built = group(
      groupsOf({
        placed: [...walls, piece(90, 'stairs', [100, 0, 0]), piece(91, 'stairs', [200, 0, 0])],
      }),
      'built',
    )

    expect(built.count).toBe(10)
    expect(lines(built)).toEqual([
      'Wall x 0, z 0',
      'Wall x 1, z 0',
      'Wall x 2, z 0',
      'Wall x 3, z 0',
      'Wall x 4, z 0',
      '+3 more walls',
      'Ramp x 100, z 0',
      'Ramp x 200, z 0',
    ])
    expect(built.rows.filter((row) => row.more)).toHaveLength(1)
  })
})

describe('the Leveled lane', () => {
  test('a named element shows its name and what saving does to it', () => {
    const leveledGroup = group(
      groupsOf({
        destroyed: [leveled('wall_1')],
        nodes: nodes([{ id: 'wall_1', type: 'wall', name: 'Garage wall' }]),
      }),
      'leveled',
    )

    expect(leveledGroup.count).toBe(1)
    expect(lines(leveledGroup)).toEqual(['Garage wall deleted'])
    expect(leveledGroup.caveat).toBe(
      'Saving deletes it from the building (undoable). Partially damaged walls always stay intact.',
    )
  })

  test('an unnamed element falls back to its type, read as words', () => {
    const leveledGroup = group(
      groupsOf({
        destroyed: [leveled('roof_1', 'volume')],
        nodes: nodes([{ id: 'roof_1', type: 'roof-segment' }]),
      }),
      'leveled',
    )

    expect(lines(leveledGroup)).toEqual(['Roof segment deleted'])
  })

  test('an element that is gone degrades to its kind and says so', () => {
    // Deleted between Esc and the click: Save has nothing left to delete there,
    // and a raw node id must never become the label.
    const all = groupsOf({ destroyed: [leveled('wall_ghost'), leveled('vol_ghost', 'volume')] })
    const leveledGroup = group(all, 'leveled')

    expect(lines(leveledGroup)).toEqual(['Wall already gone', 'Volume already gone'])
    // The id lives in the React key and nowhere the owner can read it.
    expect(render(all)).not.toContain('ghost')
    expect(leveledGroup.caveat).toContain('Saving deletes them from the building')
  })

  test('the overflow line counts the folded rows', () => {
    const leveledGroup = group(
      groupsOf({
        destroyed: Array.from({ length: 7 }, (_, i) => leveled(`wall_${i}`)),
        nodes: nodes(
          Array.from({ length: 7 }, (_, i) => ({
            id: `wall_${i}`,
            type: 'wall',
            name: `Wall ${i}`,
          })),
        ),
      }),
      'leveled',
    )

    expect(leveledGroup.count).toBe(7)
    expect(lines(leveledGroup)).toEqual([
      'Wall 0 deleted',
      'Wall 1 deleted',
      'Wall 2 deleted',
      'Wall 3 deleted',
      'Wall 4 deleted',
      '+2 more leveled',
    ])
  })
})

describe('the Painted lane', () => {
  test('each painted element shows its name, its coat and a swatch of it', () => {
    const painted = group(
      groupsOf({
        painted: [coat('wall_1', '#52b24c', 'GREEN')],
        nodes: nodes([{ id: 'wall_1', type: 'wall', name: 'Living room wall' }]),
      }),
      'painted',
    )

    expect(lines(painted)).toEqual(['Living room wall GREEN'])
    expect(painted.rows[0]?.swatch).toBe('#52b24c')
    expect(painted.caveat).toContain('Saving recolors it to its dominant coat (undoable)')
    expect(painted.caveat).toContain('splatter art itself stays in the game')
  })

  test('a painted element that is gone degrades gracefully', () => {
    const all = groupsOf({ painted: [coat('wall_ghost', '#3e7fe1', 'BLUE')] })

    expect(lines(group(all, 'painted'))).toEqual(['Building element already gone'])
    expect(render(all)).not.toContain('ghost')
  })

  test('the overflow line counts the folded rows', () => {
    const painted = group(
      groupsOf({
        painted: Array.from({ length: 6 }, (_, i) => coat(`wall_${i}`, '#f5c542', 'YELLOW')),
      }),
      'painted',
    )

    expect(painted.rows).toHaveLength(6)
    expect(painted.rows[5]).toEqual({ key: 'more-painted', label: '+1 more painted', more: true })
  })
})

describe('the Placed lane', () => {
  test('furniture shows its catalog name and where it stands', () => {
    const placedGroup = group(groupsOf({ items: [furniture(1, 'Couch', [3, 0, 5])] }), 'placed')

    expect(lines(placedGroup)).toEqual(['Couch x 3, z 5'])
    expect(placedGroup.caveat).toBe(
      'Saving adds it for real (furniture, doors and windows — undoable).',
    )
  })

  test('an opening shows the wall it will be cut into', () => {
    const placedGroup = group(
      groupsOf({
        items: [aperture(1, 'Double door', 'wall_1')],
        nodes: nodes([{ id: 'wall_1', type: 'wall', name: 'Front wall' }]),
      }),
      'placed',
    )

    expect(lines(placedGroup)).toEqual(['Double door on Front wall'])
  })

  test('an opening whose wall got leveled says the wall is gone', () => {
    const all = groupsOf({ items: [aperture(1, 'Double door', 'wall_ghost')] })

    expect(lines(group(all, 'placed'))).toEqual(['Double door wall is gone'])
    expect(render(all)).not.toContain('ghost')
  })

  test('an unnamed asset still gets a word, never a blank row', () => {
    const item = furniture(1, '', [0, 0, 0])
    expect(lines(group(groupsOf({ items: [item] }), 'placed'))).toEqual(['Item x 0, z 0'])
  })
})

describe('the list as a whole', () => {
  test('an empty lane produces no group at all', () => {
    const all = groupsOf({ painted: [coat('wall_1', '#52b24c', 'GREEN')] })

    expect(all.map((g) => g.key)).toEqual(['painted'])
  })

  test('all four lanes come out in reading order', () => {
    const all = groupsOf({
      placed: [piece(1, 'stairs', [4.5, 0, 1.5])],
      destroyed: [leveled('wall_1')],
      painted: [coat('wall_1', '#52b24c', 'GREEN')],
      items: [furniture(1, 'Couch', [3, 0, 5])],
    })

    expect(all.map((g) => g.key)).toEqual(['built', 'leveled', 'painted', 'placed'])
    expect(all.map((g) => g.title)).toEqual(['Built', 'Leveled', 'Painted', 'Placed'])
  })

  test('nothing pending, nothing to show — the panel keeps its own gate honest', () => {
    expect(groupsOf({})).toEqual([])
  })

  test('the rows reach the screen, swatch and all', () => {
    const all = groupsOf({
      placed: [piece(1, 'stairs', [4.5, 0, 1.5])],
      painted: [coat('wall_1', '#52b24c', 'GREEN')],
      nodes: nodes([{ id: 'wall_1', type: 'wall', name: 'Garage wall' }]),
    })
    const text = render(all)

    expect(text).toContain('Built · 1')
    expect(text).toContain('Ramp x 4.5, z 1.5')
    expect(text).toContain('Painted · 1')
    expect(text).toContain('Garage wall')
    expect(text).toContain('GREEN')
    expect(text).toContain('Saving turns these into real nodes')
    // The swatch is a color, so the color is the only place it can live.
    expect(renderToString(createElement(PendingChanges, { groups: all }))).toContain('#52b24c')
  })

  test('Share link sits under Jump in and under the Controls', () => {
    // Both placements were asked for by name, so both are pinned. The private
    // warning and the copy confirmation are CLICK state — they must not be on
    // screen before anyone touches the button (share-link.test.ts owns what
    // they then say).
    const text = renderToString(createElement(BootsPanel))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')

    expect(text.match(/Share link/g)).toHaveLength(2)
    expect(text.indexOf('Share link')).toBeGreaterThan(text.indexOf('Jump in'))
    expect(text.lastIndexOf('Share link')).toBeGreaterThan(text.indexOf('Controls'))
    expect(text).not.toContain('only you can join')
    expect(text).not.toContain('Link copied')
  })

  test('the panel still renders, and shows no decision before there is one', () => {
    const text = renderToString(createElement(BootsPanel))
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')

    expect(text).toContain('Jump in')
    expect(text).not.toContain('Built ·')
    // The counts-only sentences this list replaced are gone for good.
    expect(text).not.toContain('You built')
    expect(text).not.toContain('You fully leveled')
    expect(text).not.toContain('You painted')
    expect(text).not.toContain('You placed')
  })
})

describe('node labels', () => {
  test('a name beats a type, a type beats the caller, and an id is never shown', () => {
    const scene = nodes([
      { id: 'named', type: 'wall', name: 'Garage wall' },
      { id: 'blank', type: 'wall', name: '   ' },
      { id: 'typed', type: 'roof_segment' },
      { id: 'untyped' },
    ])

    expect(nodeLabel(scene, 'named', 'Wall')).toEqual({ label: 'Garage wall', missing: false })
    expect(nodeLabel(scene, 'blank', 'Wall')).toEqual({ label: 'Wall', missing: false })
    expect(nodeLabel(scene, 'typed', 'Wall')).toEqual({ label: 'Roof segment', missing: false })
    expect(nodeLabel(scene, 'untyped', 'Wall')).toEqual({ label: 'Wall', missing: false })
    expect(nodeLabel(scene, 'nowhere', 'Wall')).toEqual({ label: 'Wall', missing: true })
  })
})

describe('Save', () => {
  const stub = (calls: string[]): SaveBridges => ({
    keepPlaced: () => {
      calls.push('keepPlaced')
      return { kept: 2, skipped: 0, windows: 0, doors: 0, roofs: 1, floors: 0 }
    },
    deleteDestroyed: () => {
      calls.push('deleteDestroyed')
      return 1
    },
    applyPaint: () => {
      calls.push('applyPaint')
      return 3
    },
    applyItems: () => {
      calls.push('applyItems')
      return { kept: 1, skipped: 0, doors: 0, windows: 0 }
    },
    runStep: (run) => {
      calls.push('step opens')
      const out = run()
      calls.push('step closes')
      return out
    },
    persist: () => {
      calls.push('persist')
    },
    writable: () => true,
  })

  test('the four bridges run in order, all inside one history step', () => {
    // Paint MUST apply after the demolition delete (nodes removed above are
    // skipped instead of patched), and a bridge that escaped the step would cost
    // the owner a second Cmd+Z — both show up here as a different sequence.
    //
    // `persist` is the fifth bridge and it sits OUTSIDE the step on purpose:
    // it writes browser storage (pending-store.ts), which has no business in
    // an undo batch. It runs LAST and unconditionally — a Save that left the
    // stored pending window behind would offer the decision again, on top of
    // the very nodes it just created.
    const calls: string[] = []
    saveSessionChanges(stub(calls))

    expect(calls).toEqual([
      'step opens',
      'keepPlaced',
      'deleteDestroyed',
      'applyPaint',
      'applyItems',
      'step closes',
      'persist',
    ])
  })

  test('the receipt still reports every lane', () => {
    expect(saveSessionChanges(stub([]))).toBe(
      'Kept 1 wall + 1 roof · deleted 1 leveled element · repainted 3 · placed 1 item(s)',
    )
  })

  test('the receipt still owns up to pieces it could not convert', () => {
    const receipt = saveSessionChanges({
      ...stub([]),
      keepPlaced: () => ({ kept: 0, skipped: 2, windows: 0, doors: 0, roofs: 0, floors: 0 }),
      deleteDestroyed: () => 0,
      applyPaint: () => 0,
      applyItems: () => ({ kept: 0, skipped: 1, doors: 0, windows: 0 }),
    })

    expect(receipt).toBe('Kept 0 walls — 3 piece(s) had no node type yet')
  })

  test('a read-only document is refused, not silently reported as saved', () => {
    // Every bridge no-ops on `readOnly` and then clears its captures, so the
    // old shape printed a full receipt for a scene that changed in no way and
    // threw the session's work away with it. No bridge may even run.
    const calls: string[] = []
    const receipt = saveSessionChanges({ ...stub(calls), writable: () => false })

    expect(calls).toEqual([])
    expect(receipt).toBe(
      'Nothing saved — this project is read-only right now. Your changes are still pending.',
    )
  })
})

describe('the live Save and Discard paths', () => {
  beforeEach(() => {
    useBoots.setState({ placed: [], phase: 'editor' })
    useDemolition.getState().clear()
    usePaintKeep.getState().clear()
    useItems.getState().resolveItems()
    useScene.getState().setScene({}, [])
  })

  /** A session with something pending in all four lanes. */
  const seedSession = () => {
    // A wall node with only the fields this lane reads — the full host schema
    // is beside the point here, so the cast is the honest way to say so.
    const wall = { id: 'wall_1', type: 'wall', name: 'Garage wall', parentId: null }
    useScene.getState().setScene({ wall_1: wall } as unknown as Record<AnyNodeId, AnyNode>, [])
    useBoots.getState().addPlaced({ piece: 'stairs', position: [4.5, 0, 1.5], yaw: 0 })
    useDemolition.getState().setDestroyed([leveled('wall_1')], ['wall_1'], 0)
    usePaintKeep.getState().setPainted([coat('wall_1', '#52b24c', 'GREEN')])
    useItems.getState().addItem(asset('Couch'), [3, 0, 5], 0)
  }

  test('Save empties all four lanes', () => {
    // Emptying the lanes IS closing the offer: the sidebar's decision section
    // and the viewport preview both mount on `phase === 'editor'` + a
    // non-empty lane, so a lane left behind would offer the same decision
    // again on top of the nodes Save just wrote.
    seedSession()

    saveSessionChanges()

    expect(useBoots.getState().placed).toEqual([])
    expect(useDemolition.getState().destroyed).toEqual([])
    expect(usePaintKeep.getState().painted).toEqual([])
    expect(useItems.getState().items).toEqual([])
  })

  test('Discard empties the lanes and writes nothing', () => {
    seedSession()
    const before = useScene.getState().nodes

    expect(discardSessionChanges()).toBe('Discarded — your building is exactly as it was')
    expect(useBoots.getState().placed).toEqual([])
    expect(useDemolition.getState().destroyed).toEqual([])
    expect(usePaintKeep.getState().painted).toEqual([])
    expect(useItems.getState().items).toEqual([])
    // The document is untouched — same object, not merely equal.
    expect(useScene.getState().nodes).toBe(before)
  })

  test('drawing the list writes nothing to the document', () => {
    seedSession()
    const before = useScene.getState().nodes

    render(
      pendingChangeGroups({
        placed: useBoots.getState().placed,
        destroyed: useDemolition.getState().destroyed,
        painted: usePaintKeep.getState().painted,
        items: useItems.getState().items,
        nodes: useScene.getState().nodes,
      }),
    )

    expect(useScene.getState().nodes).toBe(before)
  })
})
