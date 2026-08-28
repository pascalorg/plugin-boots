import { afterEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Group, Matrix4, Mesh, Vector3 } from 'three'
import { resetDestruction, useDestruction } from './destruction'
import {
  AIM_RANGE,
  classifyOperable,
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
