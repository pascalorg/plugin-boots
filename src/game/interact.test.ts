import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import { clearPassages, passageCount } from './collision'
import { ensureVoxelTarget, resetDestruction, useDestruction } from './destruction'
import {
  AIM_RANGE,
  buildPassageBox,
  classifyOperable,
  isRestorableDoor,
  mountInteract,
  nearestDoorFallback,
  type OperableState,
  opensPassable,
  operableNoun,
  pickAimedOperable,
  poseCabinetParts,
  toggleOperable,
  advanceOperables,
  unmountInteract,
} from './interact'
import { bvhFor, type ColliderEntry, type GameWorld, type OperableEntry } from './world'

/**
 * E-interact, headless: kind classification (what E can operate at all),
 * the cabinet pose lerp (the one animator implemented locally), the restore
 * ledgers (exit must hand the editor its exact scene back), and aim-pick
 * priority (crosshair ray beats proximity; nearest hit wins; doors keep a
 * point-blank fallback). Host pose helpers (@pascal-app/viewer) are mocked
 * away by the test preload, so operation-door/window kinematics themselves
 * are the host's contract — here we assert our dispatch + state around them.
 */

type BuiltOperable = { root: Group; collider: ColliderEntry }

/** A one-mesh operable node: Group root at `center`, box mesh child. */
function buildOperable(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): BuiltOperable {
  const root = new Group()
  root.position.set(center[0], center[1], center[2])
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  root.add(mesh)
  root.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    root,
    collider: {
      mesh,
      bvh: bvhFor(mesh),
      inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
      worldBox,
      root,
      nodeId,
      nodeType,
    },
  }
}

type WorldSpec = {
  doors?: Array<{ built: BuiltOperable; nodeId: string; node?: Record<string, unknown> }>
  operables?: Array<{
    built: BuiltOperable
    nodeId: string
    kind: string
    node: Record<string, unknown>
  }>
}

function makeWorld(spec: WorldSpec): GameWorld {
  const colliders: ColliderEntry[] = []
  const doors: GameWorld['doors'] = []
  const operables: OperableEntry[] = []
  const buildingAabb = new Box3()
  for (const d of spec.doors ?? []) {
    colliders.push(d.built.collider)
    buildingAabb.union(d.built.collider.worldBox)
    doors.push({
      nodeId: d.nodeId,
      root: d.built.root,
      colliderIndices: [colliders.length - 1],
      node: d.node,
    })
  }
  for (const o of spec.operables ?? []) {
    colliders.push(o.built.collider)
    buildingAabb.union(o.built.collider.worldBox)
    operables.push({
      nodeId: o.nodeId,
      kind: o.kind,
      root: o.built.root,
      colliderIndices: [colliders.length - 1],
      node: o.node,
    })
  }
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors,
    operables,
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

/** Run every operable's animation to its settled end (fresh iterator per
 * step — Map.values() is one-shot). */
function settle(states: Map<string, OperableState>): void {
  for (let i = 0; i < 30; i++) advanceOperables(states.values(), 1 / 30)
}

afterEach(() => {
  resetDestruction()
  // Clear any ledgers a test left mounted — module state must not leak.
  unmountInteract(new Map())
  clearPassages()
})

describe('classifyOperable — kind classifiers', () => {
  test('doors: hinged types swing, operation types pose, pure openings stand down', () => {
    expect(classifyOperable('door', { doorType: 'hinged', openingKind: 'door' })).toBe(
      'door-hinged',
    )
    expect(classifyOperable('door', { doorType: 'double', openingKind: 'door' })).toBe(
      'door-hinged',
    )
    for (const doorType of [
      'sliding',
      'pocket',
      'barn',
      'folding',
      'garage-sectional',
      'garage-rollup',
      'garage-tiltup',
    ]) {
      expect(classifyOperable('door', { doorType, openingKind: 'door' })).toBe('door-operation')
    }
    expect(classifyOperable('door', { doorType: 'hinged', openingKind: 'opening' })).toBeNull()
    // No snapshot (hand-built worlds) — the legacy hinged behavior.
    expect(classifyOperable('door', null)).toBe('door-hinged')
  })

  test('windows: operable sash types only; fixed/bay/bow and pure openings never', () => {
    for (const windowType of [
      'sliding',
      'casement',
      'awning',
      'hopper',
      'single-hung',
      'double-hung',
      'louvered',
    ]) {
      expect(classifyOperable('window', { windowType, openingKind: 'window' })).toBe('window')
    }
    for (const windowType of ['fixed', 'bay', 'bow']) {
      expect(classifyOperable('window', { windowType, openingKind: 'window' })).toBeNull()
    }
    expect(classifyOperable('window', { windowType: 'casement', openingKind: 'opening' })).toBeNull()
    expect(classifyOperable('window', null)).toBeNull()
  })

  test('cabinets both kinds; anything else never', () => {
    expect(classifyOperable('cabinet', {})).toBe('cabinet')
    expect(classifyOperable('cabinet-module', {})).toBe('cabinet')
    expect(classifyOperable('wall', {})).toBeNull()
    expect(classifyOperable('item', {})).toBeNull()
  })

  test('passability: doors yes; only out-swinging windows; cabinets never', () => {
    expect(opensPassable('door-hinged', null)).toBe(true)
    expect(opensPassable('door-operation', { doorType: 'garage-rollup' })).toBe(true)
    expect(opensPassable('window', { windowType: 'casement' })).toBe(true)
    expect(opensPassable('window', { windowType: 'awning' })).toBe(true)
    expect(opensPassable('window', { windowType: 'sliding' })).toBe(false)
    expect(opensPassable('window', { windowType: 'double-hung' })).toBe(false)
    expect(opensPassable('window', { windowType: 'louvered' })).toBe(false)
    expect(opensPassable('cabinet', {})).toBe(false)
  })

  test('prompt nouns', () => {
    expect(operableNoun('door-hinged')).toBe('door')
    expect(operableNoun('door-operation')).toBe('door')
    expect(operableNoun('window')).toBe('window')
    expect(operableNoun('cabinet')).toBe('cabinet')
  })
})

describe('poseCabinetParts', () => {
  test('lerps rotate and translate parts by openScale', () => {
    const root = new Group()
    const hingedFront = new Group()
    hingedFront.userData.cabinetPose = { type: 'rotate', axis: 'y', angle: -1.9 }
    const drawer = new Group()
    drawer.userData.cabinetPose = { type: 'translate', axis: 'z', distance: 0.45 }
    root.add(hingedFront, drawer)

    expect(poseCabinetParts(root, 1)).toBe(true)
    expect(hingedFront.rotation.y).toBeCloseTo(-1.9)
    expect(drawer.position.z).toBeCloseTo(0.45)

    poseCabinetParts(root, 0.5)
    expect(hingedFront.rotation.y).toBeCloseTo(-0.95)
    expect(drawer.position.z).toBeCloseTo(0.225)

    poseCabinetParts(root, 0)
    expect(hingedFront.rotation.y).toBeCloseTo(0)
    expect(drawer.position.z).toBeCloseTo(0)
  })

  test('returns false when nothing carries cabinetPose', () => {
    const root = new Group()
    root.add(new Group())
    expect(poseCabinetParts(root, 1)).toBe(false)
  })
})

describe('ledger restore', () => {
  test('hinged door: swing mutates the root, unmount restores the exact pose + colliders', () => {
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const position0 = door.root.position.clone()
    const quaternion0 = door.root.quaternion.clone()

    const states = mountInteract(world)
    const state = states.get('door-a')!
    expect(state.kind).toBe('door-hinged')

    toggleOperable(state)
    settle(states)
    expect(state.open).toBe(true)
    expect(state.value).toBeCloseTo(1)
    // The root actually moved (hinge swing = rotation + position arc)…
    expect(door.root.quaternion.angleTo(quaternion0)).toBeGreaterThan(1)
    // …and its colliders went non-solid.
    expect(door.collider.disabled).toBe(true)

    unmountInteract(states)
    expect(door.root.position.distanceTo(position0)).toBeCloseTo(0)
    expect(door.root.quaternion.angleTo(quaternion0)).toBeCloseTo(0)
    expect(door.collider.disabled).toBe(false)
  })

  test('cabinet: opens by cabinetPose lerp, colliders STAY solid, unmount re-poses to the original operationState', () => {
    const cab = buildOperable('cab-a', 'cabinet', [0.6, 0.9, 0.6], [2, 0.45, 0])
    const front = new Group()
    front.userData.cabinetPose = { type: 'rotate', axis: 'y', angle: 2.0 }
    cab.root.add(front)
    // The editor left this cabinet 30% open — the game must hand that back.
    front.rotation.y = 2.0 * 0.3
    const world = makeWorld({
      operables: [
        { built: cab, nodeId: 'cab-a', kind: 'cabinet', node: { operationState: 0.3 } },
      ],
    })

    const states = mountInteract(world)
    const state = states.get('cab-a')!
    expect(state.kind).toBe('cabinet')
    expect(state.open).toBe(false) // 0.3 <= 0.5 reads as closed
    expect(state.value).toBeCloseTo(0.3)

    toggleOperable(state)
    settle(states)
    expect(front.rotation.y).toBeCloseTo(2.0)
    expect(cab.collider.disabled).toBeFalsy() // cabinets never drop colliders

    unmountInteract(states)
    expect(front.rotation.y).toBeCloseTo(2.0 * 0.3)
  })

  test('out-swing window: colliders drop while open, re-latch when closed again', () => {
    const win = buildOperable('win-a', 'window', [1.2, 1.2, 0.1], [4, 1.5, 0])
    const world = makeWorld({
      operables: [
        {
          built: win,
          nodeId: 'win-a',
          kind: 'window',
          node: { windowType: 'casement', openingKind: 'window', operationState: 0 },
        },
      ],
    })
    const states = mountInteract(world)
    const state = states.get('win-a')!
    expect(state.kind).toBe('window')
    expect(state.passable).toBe(true)

    toggleOperable(state)
    expect(win.collider.disabled).toBe(true)
    settle(states)
    toggleOperable(state)
    settle(states)
    expect(state.open).toBe(false)
    expect(win.collider.disabled).toBe(false)
    unmountInteract(states)
  })

  test('inside-frame window (sliding) keeps colliders on while open', () => {
    const win = buildOperable('win-b', 'window', [1.2, 1.2, 0.1], [6, 1.5, 0])
    const world = makeWorld({
      operables: [
        {
          built: win,
          nodeId: 'win-b',
          kind: 'window',
          node: { windowType: 'sliding', openingKind: 'window', operationState: 0 },
        },
      ],
    })
    const states = mountInteract(world)
    toggleOperable(states.get('win-b')!)
    settle(states)
    expect(win.collider.disabled).toBeFalsy()
    unmountInteract(states)
  })

  test('pure openings and fixed windows never become operables', () => {
    const opening = buildOperable('open-a', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const fixed = buildOperable('win-f', 'window', [1.2, 1.2, 0.1], [2, 1.5, 0])
    const world = makeWorld({
      doors: [
        {
          built: opening,
          nodeId: 'open-a',
          node: { doorType: 'hinged', openingKind: 'opening' },
        },
      ],
      operables: [
        {
          built: fixed,
          nodeId: 'win-f',
          kind: 'window',
          node: { windowType: 'fixed', openingKind: 'window', operationState: 0 },
        },
      ],
    })
    const states = mountInteract(world)
    expect(states.size).toBe(0)
    unmountInteract(states)
  })
})

describe('aim-pick priority', () => {
  test('nearest hit along the crosshair ray wins', () => {
    const win = buildOperable('win-a', 'window', [1.2, 1.2, 0.1], [0, 1.5, -1])
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, -2])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
      operables: [
        {
          built: win,
          nodeId: 'win-a',
          kind: 'window',
          node: { windowType: 'casement', openingKind: 'window', operationState: 0 },
        },
      ],
    })
    const states = mountInteract(world)
    const origin = new Vector3(0, 1.5, 1)
    const forward = new Vector3(0, 0, -1)
    // Window at 2 m stands in front of the door at 3 m: window wins.
    const picked = pickAimedOperable(states.values(), origin, forward)
    expect(picked?.nodeId).toBe('win-a')
    // Aim away: nothing.
    expect(pickAimedOperable(states.values(), origin, new Vector3(0, 0, 1))).toBeNull()
    unmountInteract(states)
  })

  test('hits beyond AIM_RANGE are out of reach', () => {
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, -4])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const origin = new Vector3(0, 1.05, 0)
    const forward = new Vector3(0, 0, -1)
    expect(pickAimedOperable(states.values(), origin, forward)).toBeNull() // ~3.97 m > 2.5
    expect(pickAimedOperable(states.values(), origin, forward, 4.5)?.nodeId).toBe('door-a')
    expect(AIM_RANGE).toBeCloseTo(2.5)
    unmountInteract(states)
  })

  test('voxelized nodes stand down for aim and fallback', () => {
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, -1])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const origin = new Vector3(0, 1.05, 0.5)
    const forward = new Vector3(0, 0, -1)
    expect(pickAimedOperable(states.values(), origin, forward)?.nodeId).toBe('door-a')
    // Shot to bits — destruction owns it now.
    useDestruction.getState().targets.set('door-a', {} as never)
    expect(pickAimedOperable(states.values(), origin, forward)).toBeNull()
    expect(nearestDoorFallback(states.values(), origin)).toBeNull()
    unmountInteract(states)
  })

  test('DORMANT prebuilds do NOT stand operables down (still rendering, untouched)', () => {
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, -1])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const origin = new Vector3(0, 1.05, 0.5)
    const forward = new Vector3(0, 0, -1)
    // Session-start prevoxelize builds a SLEEPING replica for every
    // explodable (doors included) — the host keeps rendering and colliding,
    // so E-interact must keep working until a first hit actually wakes it.
    useDestruction.getState().targets.set('door-a', { dormant: true } as never)
    expect(pickAimedOperable(states.values(), origin, forward)?.nodeId).toBe('door-a')
    // Point-blank fallback from inside DOOR_FALLBACK_RANGE of the leaf.
    expect(nearestDoorFallback(states.values(), new Vector3(0, 1.05, -0.2))?.nodeId).toBe('door-a')
    unmountInteract(states)
  })

  test('point-blank fallback: doors answer by proximity, windows/cabinets are aim-only', () => {
    const door = buildOperable('door-a', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const win = buildOperable('win-a', 'window', [1.2, 1.2, 0.1], [5, 1.5, 0])
    const cab = buildOperable('cab-a', 'cabinet', [0.6, 0.9, 0.6], [5.5, 0.45, 0])
    const front = new Group()
    front.userData.cabinetPose = { type: 'rotate', axis: 'y', angle: 2.0 }
    cab.root.add(front)
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-a', node: { doorType: 'hinged', openingKind: 'door' } }],
      operables: [
        {
          built: win,
          nodeId: 'win-a',
          kind: 'window',
          node: { windowType: 'casement', openingKind: 'window', operationState: 0 },
        },
        { built: cab, nodeId: 'cab-a', kind: 'cabinet', node: { operationState: 0 } },
      ],
    })
    const states = mountInteract(world)
    // Shoulder against the door leaf, crosshair looking past the jamb.
    expect(nearestDoorFallback(states.values(), new Vector3(0.4, 1.6, 0.8))?.nodeId).toBe('door-a')
    // Standing right next to a window/cabinet is NOT enough — aim required.
    expect(nearestDoorFallback(states.values(), new Vector3(5.2, 1.2, 0.3))).toBeNull()
    // And out of fallback range the door stops answering too.
    expect(nearestDoorFallback(states.values(), new Vector3(0, 1.6, 2.5))).toBeNull()
    unmountInteract(states)
  })
})

/**
 * Open-door combat + passage (owner report 2026-08-29: "when I open the
 * door I can't go through / if I shoot it, it doesn't break"): while open,
 * door colliders flip disabled + ballistic TOGETHER (movement passes,
 * bullets still test them), their transforms ride the swing so hitscan
 * meets the leaf at its true pose, the doorway prism registers for passage
 * relief, and stale DORMANT prebuilds (grid baked at another pose) drop on
 * every toggle.
 */
describe('open-door combat + passage relief', () => {
  test('open: disabled + ballistic + passage registered; close settle retires all three', () => {
    const door = buildOperable('door-p', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-p', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const state = states.get('door-p')!
    expect(passageCount()).toBe(0)
    expect(state.passage).not.toBeNull()

    toggleOperable(state)
    // Flags flip AT the toggle (mid-swing already passable + shootable).
    expect(door.collider.disabled).toBe(true)
    expect(door.collider.ballistic).toBe(true)
    expect(passageCount()).toBe(1)
    settle(states)
    expect(door.collider.ballistic).toBe(true)

    toggleOperable(state) // close — prism holds until the latch
    expect(passageCount()).toBe(1)
    settle(states)
    expect(door.collider.disabled).toBe(false)
    expect(door.collider.ballistic).toBe(false)
    expect(passageCount()).toBe(0)
    unmountInteract(states)
  })

  test('unmount retires passages and ballistic flags mid-open', () => {
    const door = buildOperable('door-q', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-q', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    toggleOperable(states.get('door-q')!)
    settle(states)
    expect(passageCount()).toBe(1)
    unmountInteract(states)
    expect(passageCount()).toBe(0)
    expect(door.collider.disabled).toBe(false)
    expect(door.collider.ballistic).toBe(false)
  })

  test('the swing refreshes collider inverse + worldBox to the LIVE pose', () => {
    const door = buildOperable('door-r', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-r', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const state = states.get('door-r')!
    const closedCenter = door.collider.worldBox.getCenter(new Vector3())

    toggleOperable(state)
    settle(states)
    // The box tracked the ±100° swing about the hinge edge…
    const openCenter = door.collider.worldBox.getCenter(new Vector3())
    expect(openCenter.distanceTo(closedCenter)).toBeGreaterThan(0.5)
    // …and inverse is the exact inverse of the CURRENT matrixWorld.
    const composed = new Matrix4().multiplyMatrices(
      door.collider.inverse,
      door.collider.mesh.matrixWorld,
    )
    const identity = new Matrix4()
    for (let i = 0; i < 16; i++) {
      expect(composed.elements[i]!).toBeCloseTo(identity.elements[i]!, 5)
    }
    // The aim pick therefore answers at the swung pose: a ray down the OLD
    // leaf plane from the side no longer hits at the closed slab location.
    const picked = pickAimedOperable(
      states.values(),
      new Vector3(0, 1.05, 1),
      new Vector3(0, 0, -1),
    )
    // Hinge at local -X: the leaf swung out of the crosshair line through
    // the closed pose center — the pick follows the LIVE colliders.
    expect(picked?.nodeId ?? null).toBe(null)
    unmountInteract(states)
  })

  test('toggling drops a STALE dormant prebuild; awake targets are never touched', () => {
    const door = buildOperable('door-s', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-s', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    const state = states.get('door-s')!

    // Session-start prevoxelize: a real dormant prebuild at the CLOSED pose.
    ensureVoxelTarget(world, 'door-s', { dormant: true })
    expect(useDestruction.getState().targets.get('door-s')?.dormant).toBe(true)

    toggleOperable(state) // pose changes — the stale prebuild must go
    expect(useDestruction.getState().targets.has('door-s')).toBe(false)
    settle(states)

    // Awake target (bullets broke the leaf): destruction owns it — a close
    // toggle must NOT drop it.
    ensureVoxelTarget(world, 'door-s')
    expect(useDestruction.getState().targets.get('door-s')?.dormant).toBeFalsy()
    toggleOperable(state)
    settle(states)
    expect(useDestruction.getState().targets.has('door-s')).toBe(true)
    unmountInteract(states)
  })

  test('buildPassageBox: full frame height, thin axis padded, opening axis exact', () => {
    const door = buildOperable('door-t', 'door', [1, 2.1, 0.06], [0, 1.05, 0])
    const box = buildPassageBox([door.collider])!
    expect(box.min.y).toBeCloseTo(0)
    expect(box.max.y).toBeCloseTo(2.1)
    // Opening axis (x) stays the frame's exact span…
    expect(box.min.x).toBeCloseTo(-0.5)
    expect(box.max.x).toBeCloseTo(0.5)
    // …the thin axis (z) pads past sills/rails that overhang the wall face.
    expect(box.min.z).toBeLessThan(-0.3)
    expect(box.max.z).toBeGreaterThan(0.3)
  })
})

/**
 * SEALED-DOOR HANDBACK (owner repro 2026-08-30, Starter House scene
 * 31b8ec37e9bb: "still can't walk through a regular door … something on
 * the wall blocks me"): ONE pistol round on a CLOSED door woke its voxel
 * replica AT THE CLOSED POSE — the twin looked like the door, the E prompt
 * stood down, and the doorway stayed sealed for the whole session. While
 * the awake grid is lightly damaged (≤ DOOR_RESTORE_MAX_DAMAGE of its
 * cells gone) the door must stay E-operable: the toggle hands the node
 * back to the host (restoreOperableTarget — leaf visible, colliders
 * re-latched) and swings it open like any other door.
 */
describe('sealed-door handback (voxelized-at-closed-pose doors)', () => {
  function sealedDoorWorld() {
    const door = buildOperable('door-v', 'door', [1, 2.1, 0.06], [0, 1.05, -1])
    const world = makeWorld({
      doors: [{ built: door, nodeId: 'door-v', node: { doorType: 'hinged', openingKind: 'door' } }],
    })
    const states = mountInteract(world)
    return { door, world, states, state: states.get('door-v')! }
  }

  test('a lightly-shot closed door keeps the prompt and E re-takes + opens it', () => {
    const { door, world, states, state } = sealedDoorWorld()
    // Stray fire: the dormant-less awake voxelize at the CLOSED pose (the
    // repro's pistol round). destruction disables the host colliders.
    ensureVoxelTarget(world, 'door-v')
    const target = useDestruction.getState().targets.get('door-v')!
    expect(target.dormant).toBeFalsy()
    expect(door.collider.disabled).toBe(true)
    // Light damage — a few cells of the leaf carved out.
    target.grid.aliveCount = target.grid.count - Math.floor(target.grid.count * 0.1)

    // The door still answers the crosshair AND the point-blank fallback.
    const origin = new Vector3(0, 1.05, 0.5)
    const forward = new Vector3(0, 0, -1)
    expect(isRestorableDoor(state)).toBe(true)
    expect(pickAimedOperable(states.values(), origin, forward)?.nodeId).toBe('door-v')
    expect(nearestDoorFallback(states.values(), new Vector3(0, 1.05, -0.2))?.nodeId).toBe('door-v')

    // E: hand the node back to the host, then swing.
    toggleOperable(state)
    expect(useDestruction.getState().targets.has('door-v')).toBe(false) // grid gone
    expect(door.collider.mesh.visible).toBe(true) // leaf renders again
    expect(state.open).toBe(true)
    settle(states)
    // Open posture exactly like an undamaged door: passable + shootable.
    expect(door.collider.disabled).toBe(true)
    expect(door.collider.ballistic).toBe(true)
    expect(passageCount()).toBe(1)
    unmountInteract(states)
  })

  test('past the damage cap destruction keeps the door: no prompt, no toggle', () => {
    const { door, world, states, state } = sealedDoorWorld()
    ensureVoxelTarget(world, 'door-v')
    const target = useDestruction.getState().targets.get('door-v')!
    // More than DOOR_RESTORE_MAX_DAMAGE of the cells are gone — wrecked.
    target.grid.aliveCount = Math.floor(target.grid.count * 0.5)
    expect(isRestorableDoor(state)).toBe(false)

    const origin = new Vector3(0, 1.05, 0.5)
    const forward = new Vector3(0, 0, -1)
    expect(pickAimedOperable(states.values(), origin, forward)).toBeNull()
    expect(nearestDoorFallback(states.values(), new Vector3(0, 1.05, -0.2))).toBeNull()
    toggleOperable(state) // self-guarded no-op
    expect(state.open).toBe(false)
    expect(useDestruction.getState().targets.has('door-v')).toBe(true)
    expect(door.collider.disabled).toBe(true) // the grid keeps collision
    unmountInteract(states)
  })

  test('a door that voxelized standing OPEN is never re-taken (doorway stays open)', () => {
    const { world, states, state } = sealedDoorWorld()
    toggleOperable(state)
    settle(states)
    expect(state.open).toBe(true)
    // Bullets broke the open leaf — destruction owns it from here.
    ensureVoxelTarget(world, 'door-v')
    expect(isRestorableDoor(state)).toBe(false)
    toggleOperable(state) // no close over a carved grid
    expect(state.open).toBe(true)
    expect(useDestruction.getState().targets.has('door-v')).toBe(true)
    // The passage prism keeps relieving the open doorway.
    expect(passageCount()).toBe(1)
    unmountInteract(states)
  })

  test('windows and cabinets never hand back', () => {
    const win = buildOperable('win-v', 'window', [1.2, 1.2, 0.1], [4, 1.5, 0])
    const world = makeWorld({
      operables: [
        {
          built: win,
          nodeId: 'win-v',
          kind: 'window',
          node: { windowType: 'casement', openingKind: 'window', operationState: 0 },
        },
      ],
    })
    const states = mountInteract(world)
    ensureVoxelTarget(world, 'win-v')
    expect(isRestorableDoor(states.get('win-v')!)).toBe(false)
    toggleOperable(states.get('win-v')!)
    expect(states.get('win-v')!.open).toBe(false)
    expect(useDestruction.getState().targets.has('win-v')).toBe(true)
    unmountInteract(states)
  })
})
