import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import { FULL_MASK } from '../store'
import {
  BUILD_CYCLE,
  CELLS,
  DOOR_MASK,
  geometryForMask,
  HALF_WALL_MASK,
  maskBit,
  nextBuildSelection,
  nextWallVariant,
  OPENING_COL,
  PIECE_DIMS,
  planWallMask,
  WALL_H,
  wallOpeningMask,
  WINDOW_MASK,
} from './builder'
import { clearPassages, EYE_HEIGHT, passageCount, PLAYER_CAPSULE } from './collision'
import { resetDestruction } from './destruction'
import { fittingNodeId, planFitting } from './fittings'
import { buildSelectionLabel } from './hud'
import {
  advanceOperables,
  mountInteract,
  nearestDoorFallback,
  type OperableState,
  registerGameOperable,
  resetGameOperables,
  toggleOperable,
  unmountInteract,
  unregisterGameOperable,
} from './interact'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE DOOR AND THE WINDOW THE PLAYER BUILT (owner ask 2026-09-01: "in the
 * build menu make sure I could place windows and doors as well… and that I
 * could use them by pressing E afterward").
 *
 * The design under test: an aperture is NOT a new piece. It is a wall whose
 * middle column is pocketed in the 9-bit cell mask that already existed, and
 * the leaf you swing with E is DERIVED from that mask, never stored. So the
 * contract splits in two, and this file asserts both halves:
 *
 *   1. the masks and the menu — pure: the presets are the exact patterns Keep
 *      already maps to real host door/window nodes, they ride the piece record
 *      that already replicates, and no other piece can carry one;
 *   2. planFitting → the E lane — where the leaf hangs, and that a built
 *      doorway opens into a prism the PLAYER'S CAPSULE actually fits through
 *      (the lintel case, which is why passageTop exists).
 */

const cellW = PIECE_DIMS.wall[0] / CELLS

// ── 1. The masks and the menu ──────────────────────────────────────────────

describe('the wall family — door/window are mask presets, nothing more', () => {
  test('each preset kills EXACTLY its pocket cells in the middle column', () => {
    const doorBits = (1 << maskBit(OPENING_COL, 0)) | (1 << maskBit(OPENING_COL, 1))
    expect(DOOR_MASK).toBe(FULL_MASK & ~doorBits)
    expect(WINDOW_MASK).toBe(FULL_MASK & ~(1 << maskBit(OPENING_COL, 1)))
    // Documented values — a change here changes what every peer receives.
    expect(DOOR_MASK).toBe(493)
    expect(WINDOW_MASK).toBe(495)
  })

  test("Keep reads them as REAL pockets, exactly (the whole reason it's a mask)", () => {
    // planWallMask's `exact` is Keep's "I can build this from nodes with no
    // approximation" — a preset that fell into the best-effort path would save
    // as a solid wall and the player's door would vanish on exit.
    const door = planWallMask(DOOR_MASK)
    expect(door).toMatchObject({ kind: 'wall', pocket: 'door', pocketCol: OPENING_COL, exact: true })
    const window = planWallMask(WINDOW_MASK)
    expect(window).toMatchObject({
      kind: 'wall',
      pocket: 'window',
      pocketCol: OPENING_COL,
      exact: true,
    })
  })

  test('the hole is real in the geometry — mesh, collider and ghost preview', () => {
    // Placed pieces, their colliders AND the ghost's fill all come out of
    // geometryForMask, so one assertion covers "you see the hole before you
    // place it" and "you can walk through it after".
    const solid = geometryForMask('wall', FULL_MASK, WALL_H)!
    const door = geometryForMask('wall', DOOR_MASK, WALL_H)!
    const window = geometryForMask('wall', WINDOW_MASK, WALL_H)!
    // One merged box per live cell: 7 for a doorway, 8 for a window.
    expect(door.getAttribute('position').count / 24).toBe(7)
    expect(window.getAttribute('position').count / 24).toBe(8)
    // The pocket is INTERIOR: the wall still spans its full 3 m × storey.
    door.computeBoundingBox()
    solid.computeBoundingBox()
    expect(door.boundingBox!.max.x).toBeCloseTo(solid.boundingBox!.max.x, 5)
    expect(door.boundingBox!.max.y).toBeCloseTo(solid.boundingBox!.max.y, 5)
  })

  test('only a WALL can carry an aperture', () => {
    expect(wallOpeningMask('wall', null)).toBe(FULL_MASK)
    expect(wallOpeningMask('wall', 'door')).toBe(DOOR_MASK)
    expect(wallOpeningMask('wall', 'window')).toBe(WINDOW_MASK)
    for (const piece of ['floor', 'stairs', 'roof'] as const) {
      expect(wallOpeningMask(piece, 'door')).toBe(FULL_MASK)
      expect(wallOpeningMask(piece, 'window')).toBe(FULL_MASK)
      expect(wallOpeningMask(piece, null)).toBe(FULL_MASK)
    }
  })
})

describe('the build menu — every selection is reachable', () => {
  test('the cycle lists all four pieces plus the two wall variants, once each', () => {
    expect(BUILD_CYCLE.map((s) => `${s.piece}:${s.opening ?? '-'}`)).toEqual([
      'wall:-',
      'wall:door',
      'wall:window',
      'floor:-',
      'stairs:-',
      'roof:-',
    ])
  })

  test('Q walks the whole menu and wraps in exactly one lap', () => {
    let at = BUILD_CYCLE[0]!
    const seen = [`${at.piece}:${at.opening ?? '-'}`]
    for (let i = 0; i < BUILD_CYCLE.length - 1; i++) {
      at = nextBuildSelection(at.piece, at.opening)
      seen.push(`${at.piece}:${at.opening ?? '-'}`)
    }
    expect(new Set(seen).size).toBe(BUILD_CYCLE.length)
    // One more press is back to the start.
    expect(nextBuildSelection(at.piece, at.opening)).toEqual(BUILD_CYCLE[0]!)
  })

  test('an impossible selection falls back to the plain wall, never off the end', () => {
    // setBuildPiece clears the opening, so 'floor' + 'door' cannot happen —
    // but a stale save or a future piece must not index BUILD_CYCLE[-1 + 1]
    // into undefined.
    expect(nextBuildSelection('floor', 'door')).toEqual(BUILD_CYCLE[0]!)
  })

  test('Z cycles the wall family in place', () => {
    expect(nextWallVariant(null)).toBe('door')
    expect(nextWallVariant('door')).toBe('window')
    expect(nextWallVariant('window')).toBe(null)
  })

  test('the HUD names the aperture, not the wall carrying it', () => {
    expect(buildSelectionLabel('wall', null)).toBe('WALL')
    expect(buildSelectionLabel('wall', 'door')).toBe('DOOR')
    expect(buildSelectionLabel('wall', 'window')).toBe('WINDOW')
    expect(buildSelectionLabel('stairs', null)).toBe('STAIRS')
  })
})

// ── 2. planFitting: where the leaf hangs ───────────────────────────────────

const REVEAL = 0.02

type PiecePlanInput = Parameters<typeof planFitting>[0]

function wallPiece(over: Partial<PiecePlanInput> = {}): PiecePlanInput {
  return {
    piece: 'wall',
    position: [10, 4, -6],
    yaw: 0,
    mask: DOOR_MASK,
    ...over,
  } as PiecePlanInput
}

describe('planFitting — only a pocket grows a leaf', () => {
  test('nothing to hang: other pieces, intact walls, trimmed walls', () => {
    for (const piece of ['floor', 'stairs', 'roof'] as const) {
      expect(planFitting(wallPiece({ piece, mask: DOOR_MASK }))).toBeNull()
    }
    expect(planFitting(wallPiece({ mask: FULL_MASK }))).toBeNull()
    // A shot-down / F-edited wall is a wall, not a doorway.
    expect(planFitting(wallPiece({ mask: HALF_WALL_MASK }))).toBeNull()
    expect(planFitting(wallPiece({ mask: 0 }))).toBeNull()
  })

  test('a door stands ON the wall base and fills its two-cell opening', () => {
    const piece = wallPiece({ mask: DOOR_MASK })
    const plan = planFitting(piece)!
    expect(plan.kind).toBe('door')
    // No threshold gap: the capsule cannot see a 2 cm lip, it would just trip.
    expect(plan.hinge[1]).toBeCloseTo(4, 6)
    expect(plan.height).toBeCloseTo((2 * WALL_H) / 3 - REVEAL, 6)
    expect(plan.width).toBeCloseTo(cellW - REVEAL * 2, 6)
    expect(plan.wallTopY).toBeCloseTo(4 + WALL_H, 6)
  })

  test('the leaf hangs INSIDE its pocket, hinged on the −X jamb', () => {
    const plan = planFitting(wallPiece({ position: [0, 0, 0], yaw: 0 }))!
    // Pocket col 1 of a 3 m wall spans local x ∈ [−0.5, +0.5]; the leaf must
    // sit inside it by the reveal on both jambs or a swing grazes the wall.
    const start = plan.hinge[0]
    expect(start).toBeCloseTo(-cellW / 2 + REVEAL, 6)
    expect(start + plan.width).toBeCloseTo(cellW / 2 - REVEAL, 6)
    expect(plan.hinge[2]).toBeCloseTo(0, 6)
  })

  test('the hinge follows the wall yaw (local +X → (cos, −sin) on XZ)', () => {
    const plan = planFitting(wallPiece({ position: [0, 0, 0], yaw: Math.PI / 2 }))!
    expect(plan.yaw).toBeCloseTo(Math.PI / 2, 6)
    expect(plan.hinge[0]).toBeCloseTo(0, 6)
    expect(plan.hinge[2]).toBeCloseTo(cellW / 2 - REVEAL, 6)
  })

  test('a window is a sash floating at chest height, reveal all round', () => {
    const plan = planFitting(wallPiece({ mask: WINDOW_MASK }))!
    const cellH = WALL_H / 3
    expect(plan.kind).toBe('window')
    expect(plan.hinge[1]).toBeCloseTo(4 + cellH + REVEAL, 6)
    expect(plan.height).toBeCloseTo(cellH - REVEAL * 2, 6)
  })

  test('it conforms to the storey it was placed on (2.5 m level)', () => {
    const plan = planFitting(wallPiece({ height: 2.5 }))!
    expect(plan.height).toBeCloseTo((2 * 2.5) / 3 - REVEAL, 6)
    expect(plan.wallTopY).toBeCloseTo(4 + 2.5, 6)
    // Footprints never change with the storey — only the rise does.
    expect(plan.width).toBeCloseTo(cellW - REVEAL * 2, 6)
  })

  test('derived from the DEAD ROWS, so a hand-carved pocket works too', () => {
    // Not the preset: a window pocketed at col 0 by an F-edit.
    const atCol0 = FULL_MASK & ~(1 << maskBit(0, 1))
    const plan = planFitting(wallPiece({ position: [0, 0, 0], mask: atCol0 }))!
    expect(plan.kind).toBe('window')
    expect(plan.hinge[0]).toBeCloseTo(-PIECE_DIMS.wall[0] / 2 + REVEAL, 6)
    // A one-cell doorway (bottom cell only) is a door of one cell's height.
    const stub = planFitting(wallPiece({ mask: FULL_MASK & ~(1 << maskBit(1, 0)) }))!
    expect(stub.kind).toBe('door')
    expect(stub.height).toBeCloseTo(WALL_H / 3 - REVEAL, 6)
    expect(stub.hinge[1]).toBeCloseTo(4, 6)
  })

  test('the nodeId is in the destruction guard’s namespace, per piece', () => {
    // destruction.ts skips prevoxelizing '__boots'-prefixed nodes: a leaf that
    // could be shredded would leave the E prompt on geometry that is gone.
    expect(fittingNodeId(7).startsWith('__boots')).toBe(true)
    expect(fittingNodeId(7)).not.toBe(fittingNodeId(8))
  })
})

// ── 3. The E lane: registration, swing, and crossing ───────────────────────

/** The leaf frame fittings.tsx renders: group AT the hinge, yawed with the
 * wall, box mesh reaching local +X — the frame buildHingedRig expects. */
function mountLeaf(
  plan: NonNullable<ReturnType<typeof planFitting>>,
  nodeId: string,
): { root: Group; collider: ColliderEntry } {
  const root = new Group()
  root.position.set(plan.hinge[0], plan.hinge[1], plan.hinge[2])
  root.rotation.y = plan.yaw
  const mesh = new Mesh(new BoxGeometry(plan.width, plan.height, plan.thickness))
  mesh.position.set(plan.width / 2, plan.height / 2, 0)
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  return {
    root,
    collider: {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
      root: mesh,
      nodeId,
      nodeType: 'fixture',
    },
  }
}

function emptyWorld(colliders: ColliderEntry[]): GameWorld {
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    operables: [],
    overlayRoots: [],
    buildingAabb: new Box3(),
    spawn: new Vector3(),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Run every animation to its settled end. A fresh iterator per step —
 * Map.values() is one-shot, and a consumed one silently animates nothing. */
function settle(states: Map<string, OperableState>): void {
  for (let i = 0; i < 40; i++) advanceOperables(states.values(), 1 / 30)
}

let mounted: Map<string, OperableState> | null = null

const isolate = () => {
  if (mounted) unmountInteract(mounted)
  mounted = null
  resetGameOperables()
  resetDestruction()
  clearPassages()
}

beforeEach(isolate)
afterEach(isolate)

describe('registerGameOperable — the built leaf answers E', () => {
  test('a leaf placed BEFORE interact mounts is still there afterwards', () => {
    // Retained fact, not an event: a piece can be placed — or arrive from a
    // peer — at any time, including before the component exists.
    const plan = planFitting(wallPiece({ position: [0, 0, 0] }))!
    const { root, collider } = mountLeaf(plan, '__boots-fitting-1')
    const state = registerGameOperable({
      nodeId: '__boots-fitting-1',
      root,
      colliders: [collider],
      noun: 'door',
      passage: true,
      passageTop: plan.wallTopY,
    })!
    expect(state.kind).toBe('door-hinged')
    expect(state.hinged).toBeTruthy()

    mounted = mountInteract(emptyWorld([collider]))
    expect(mounted.get('__boots-fitting-1')).toBe(state)

    // …and it survives a remount (its mesh is the plugin's own, not the
    // editor's, so there is no restore ledger to rebuild).
    unmountInteract(mounted)
    mounted = mountInteract(emptyWorld([collider]))
    expect(mounted.get('__boots-fitting-1')).toBe(state)
  })

  test('opening a built doorway clears a prism the CAPSULE fits through', () => {
    // The lintel case, and why passageTop exists: on a 2.5 m storey the
    // two-cell opening is 1.67 m and the player capsule is 1.78 m, so the
    // cell ABOVE the leaf pinches the head and the player stands in an open
    // doorway unable to cross.
    const piece = wallPiece({ position: [0, 0, 0], height: 2.5 })
    const plan = planFitting(piece)!
    expect(plan.height).toBeLessThan(PLAYER_CAPSULE.height)
    const { root, collider } = mountLeaf(plan, '__boots-fitting-2')
    const state = registerGameOperable({
      nodeId: '__boots-fitting-2',
      root,
      colliders: [collider],
      noun: 'door',
      passage: true,
      passageTop: plan.wallTopY,
    })!
    mounted = mountInteract(emptyWorld([collider]))

    expect(passageCount()).toBe(0) // shut: the doorway is closed, period
    toggleOperable(state)
    settle(mounted)
    expect(passageCount()).toBe(1)
    expect(state.passage!.max.y).toBeCloseTo(plan.wallTopY, 6)
    expect(state.passage!.max.y).toBeGreaterThan(PLAYER_CAPSULE.height)
    expect(state.value).toBeCloseTo(1, 3)

    toggleOperable(state)
    settle(mounted)
    expect(passageCount()).toBe(0)
    expect(state.value).toBeCloseTo(0, 3)
  })

  test('a sash swings like a leaf but is a WINDOW: no prism, aim-only', () => {
    const sashPlan = planFitting(wallPiece({ position: [0, 0, 0], mask: WINDOW_MASK }))!
    const sash = mountLeaf(sashPlan, '__boots-fitting-3')
    const sashState = registerGameOperable({
      nodeId: '__boots-fitting-3',
      root: sash.root,
      colliders: [sash.collider],
      noun: 'window',
      passage: false,
    })!
    const doorPlan = planFitting(wallPiece({ position: [3, 0, 0] }))!
    const door = mountLeaf(doorPlan, '__boots-fitting-4')
    const doorState = registerGameOperable({
      nodeId: '__boots-fitting-4',
      root: door.root,
      colliders: [door.collider],
      noun: 'door',
      passage: true,
      passageTop: doorPlan.wallTopY,
    })!
    mounted = mountInteract(emptyWorld([sash.collider, door.collider]))

    // The prompt reads the noun, so the player is told "window" (the kind is
    // 'door-hinged' — a casement is a leaf on a vertical hinge).
    expect(sashState.noun).toBe('window')
    expect(sashState.kind).toBe('door-hinged')

    // Nothing crosses a chest-high sash: a prism there would relieve real
    // wall contacts for nothing. Opening it must not register one.
    toggleOperable(sashState)
    settle(mounted)
    expect(sashState.passage).toBeNull()
    expect(passageCount()).toBe(0)

    // And it must not steal the point-blank prompt from the door you lean on.
    const beside = sashState.mountBox.getCenter(new Vector3())
    expect(nearestDoorFallback(mounted.values(), beside)).toBeNull()
    expect(nearestDoorFallback(mounted.values(), doorState.mountBox.getCenter(new Vector3()))).toBe(
      doorState,
    )
  })

  test('E answers a player STANDING at the doorway — eye height, not leaf centre', () => {
    // Live QA 2026-09-01: standing 1.15 m in front of an OPEN built doorway,
    // `doors.aimed()` came back null and E could not close it again. Nothing was
    // wrong with the door: the aim ray has nothing left to hit through an open
    // doorway, and the point-blank fallback measured a 3-D distance from the EYE
    // (1.58 m up) to the leaf's CENTRE — 0.83 m up on a 2.5 m storey — so 0.7 m
    // of the 1.2 m range was spent going nowhere. Horizontal is what standing at
    // a door means.
    const piece = wallPiece({ position: [0, 0, 0], height: 2.5 })
    const plan = planFitting(piece)!
    const { root, collider } = mountLeaf(plan, '__boots-fitting-9')
    const state = registerGameOperable({
      nodeId: '__boots-fitting-9',
      root,
      colliders: [collider],
      noun: 'door',
      passage: true,
      passageTop: plan.wallTopY,
    })!
    mounted = mountInteract(emptyWorld([collider]))
    const doorway = state.mountBox.getCenter(new Vector3())
    const eyeAt = (offset: number) =>
      new Vector3(doorway.x, piece.position[1] + EYE_HEIGHT, doorway.z + offset)

    // Arm's length in front, and further out than the leaf is tall.
    expect(nearestDoorFallback(mounted.values(), eyeAt(1.15))).toBe(state)
    expect(nearestDoorFallback(mounted.values(), eyeAt(-1.15))).toBe(state) // and from behind
    // Still a SHORT reach: across the room is not standing at the door.
    expect(nearestDoorFallback(mounted.values(), eyeAt(2.4))).toBeNull()

    // The vertical band is what keeps the storeys apart: the same doorway must
    // not answer the player standing on the floor above it.
    const upstairs = new Vector3(doorway.x, piece.position[1] + 2.5 + EYE_HEIGHT, doorway.z + 0.6)
    expect(nearestDoorFallback(mounted.values(), upstairs)).toBeNull()
    // …nor the one on the floor below.
    const downstairs = new Vector3(doorway.x, piece.position[1] - 2.5 + EYE_HEIGHT, doorway.z + 0.6)
    expect(nearestDoorFallback(mounted.values(), downstairs)).toBeNull()

    // And it keeps answering with the leaf swung wide open — the doorway is the
    // frame's place, not the leaf's.
    toggleOperable(state)
    settle(mounted)
    expect(state.open).toBe(true)
    expect(nearestDoorFallback(mounted.values(), eyeAt(1.15))).toBe(state)
  })

  test('re-masking replaces the leaf; undo/collapse drops it clean', () => {
    const plan = planFitting(wallPiece({ position: [0, 0, 0] }))!
    const first = mountLeaf(plan, '__boots-fitting-5')
    const a = registerGameOperable({
      nodeId: '__boots-fitting-5',
      root: first.root,
      colliders: [first.collider],
      noun: 'door',
      passage: true,
      passageTop: plan.wallTopY,
    })!
    mounted = mountInteract(emptyWorld([first.collider]))
    toggleOperable(a)
    settle(mounted)
    expect(passageCount()).toBe(1)

    // An F-edit re-mints the leaf on the same piece: same nodeId, new state,
    // and the OLD prism must go with it (or the hole outlives the door).
    const second = mountLeaf(plan, '__boots-fitting-5')
    const b = registerGameOperable({
      nodeId: '__boots-fitting-5',
      root: second.root,
      colliders: [second.collider],
      noun: 'door',
      passage: true,
      passageTop: plan.wallTopY,
    })!
    expect(b).not.toBe(a)
    expect(passageCount()).toBe(0)
    expect(mounted.get('__boots-fitting-5')).toBe(b)

    // Undo / collapse / Keep: the fitting unmounts and nothing is left behind.
    toggleOperable(b)
    settle(mounted)
    expect(passageCount()).toBe(1)
    unregisterGameOperable('__boots-fitting-5')
    expect(passageCount()).toBe(0)
    expect(mounted.has('__boots-fitting-5')).toBe(false)
  })

  test('nothing to hang on: no colliders, no operable', () => {
    const plan = planFitting(wallPiece())!
    expect(
      registerGameOperable({
        nodeId: '__boots-fitting-6',
        root: mountLeaf(plan, 'x').root,
        colliders: [],
        noun: 'door',
        passage: true,
      }),
    ).toBeNull()
  })
})
