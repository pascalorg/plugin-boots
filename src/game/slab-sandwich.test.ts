import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { clearDebris, debrisCensus } from './debris'
import {
  collideVoxelTargets,
  damageSegment,
  damageTarget,
  ensureVoxelTarget,
  isTearLaneNode,
  probeLandingY,
  resetDestruction,
  useDestruction,
  setShellFlag,
} from './destruction'
import { probeTargetSupport } from './structure'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

// S2 flips conforming shells DEFAULT ON. This suite pins the VOXEL-ONLY
// lane (awake voxelize, collider hand-over, replica collision/raycasts),
// so it throws the per-kind kill-switches before every test — the same
// session-latched setShell(kind, false) rollback QA uses (the latch
// re-arms via each test's resetDestruction). afterAll restores the
// defaults for whatever suite runs after this file.
beforeEach(() => {
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
})
afterAll(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
})


/**
 * SLAB SANDWICH (MULTILEVEL-PLAN Phase B), headless: horizontal slabs
 * voxelize as the wall anatomy rotated onto its side — thickness axis =
 * world Y, top (sheathing) + bottom (ceiling) skins, joists in the cavity,
 * sheets on BOTH faces — and they ride the wall tear lane (skin-respecting
 * pierce, sheet fly-offs, splash chips). Island support comes from a probe
 * against live colliders / voxel targets beneath each cell column instead
 * of the grid's own base row (which IS the ceiling skin on a horizontal
 * grid), and crumble debris is SAMPLED (≤ 120 per event) so a region
 * collapse can't evict the whole global debris ring.
 */

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

/** A second-storey floor slab (top surface at y=3, thickness 0.3) bearing
 * on one wall-like support column under its x-min edge. */
function makeWorld(slabSize: [number, number, number] = [4, 0.3, 3]): GameWorld {
  const slab = boxCollider('slab-1', 'slab', slabSize, [0, 3 - slabSize[1] / 2, 0])
  const support = boxCollider(
    'wall-support',
    'wall',
    [0.4, 2.7, slabSize[2]],
    [-slabSize[0] / 2 + 0.2, 1.35, 0],
  )
  const colliders = [slab, support]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  return {
    colliders,
    walls: new Map(),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

afterEach(() => {
  resetDestruction()
  clearDebris()
})

describe('slab sandwich anatomy', () => {
  test('a horizontal slab voxelizes as two Y-skins with joists and double-faced sheets', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'slab-1')!
    expect(target.kind).toBe('slab')

    // Thickness axis is world Y: the pinned cell is thinner than the plan
    // cells and every surviving cell sits on the top or bottom face layer.
    const { grid } = target
    expect(grid.cellY).toBeLessThan(grid.cellX)
    expect(grid.cellX).toBe(grid.cellZ)
    expect(grid.ny).toBeGreaterThanOrEqual(3)
    expect(grid.count).toBeGreaterThan(0)
    let bottom = 0
    let top = 0
    for (let i = 0; i < grid.count; i++) {
      const iy = grid.coords[i * 3 + 1]!
      expect(iy === 0 || iy === grid.ny - 1).toBe(true)
      if (iy === 0) bottom++
      else top++
    }
    expect(bottom).toBeGreaterThan(0)
    expect(top).toBeGreaterThan(0)

    // Sheets tile BOTH faces; the ceiling face's outward normal points DOWN.
    const sides = new Set(target.sheets.map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
    for (const sheet of target.sheets) {
      expect(sheet.normal[0]).toBeCloseTo(0, 5)
      expect(sheet.normal[2]).toBeCloseTo(0, 5)
      expect(sheet.normal[1]).toBeCloseTo(sheet.side === 0 ? -1 : 1, 5)
    }

    // Slabs join the tear lane (shooting resolves tearRadius off this) —
    // both before and after voxelization.
    expect(isTearLaneNode(world, 'slab-1')).toBe(true)
    expect(isTearLaneNode(makeWorld(), 'slab-1')).toBe(true)
  })

  test('joists run 16" o.c. across the SHORT plan direction, tops 0.04 m down', () => {
    const world = makeWorld() // 4 m (x) × 3 m (z) → joists RUN along z
    const target = ensureVoxelTarget(world, 'slab-1')!
    expect(target.segments.length).toBeGreaterThan(0)
    expect(target.studs).toBe(target.segments) // legacy alias holds for slabs
    for (const joist of target.segments) {
      expect(joist.yaw).toBeCloseTo(Math.PI / 2, 6) // long axis along z
      expect(joist.hp).toBe(2)
      expect(joist.broken).toBe(false)
      expect(joist.size[1]).toBeCloseTo(0.235, 6) // real 2×10 depth
      expect(joist.size[2]).toBeCloseTo(0.038, 6) // real 2×10 width
      expect(joist.center[1] + joist.size[1] / 2).toBeCloseTo(3 - 0.04, 6)
    }
    // 16" o.c. across the 4 m spread: floor(4 / 0.4064) + 1 = 10 lines.
    const lines = new Set(target.segments.map((s) => Math.round(s.center[0] * 1000)))
    expect(lines.size).toBe(10)
  })

  test('thin toppings and non-plates keep the plain volume (no joists, no sheets)', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-chunk', 'slab', [0.5, 1.2, 0.5], [8, 0.6, 8]))
    const target = ensureVoxelTarget(world, 'slab-chunk')!
    expect(target.kind).toBe('volume')
    expect(target.segments.length).toBe(0)
    expect(target.sheets.length).toBe(0)
  })

  test('an ELEVATED thin slab hangs full-depth joists below its deck', () => {
    // Host slab-tool default (0.05 m) drawn as a second-storey floor: too
    // thin for embedded framing, but something must hold a floor up — the
    // joists frame at full 2×10 depth with tops at the slab underside.
    const world = makeWorld([4, 0.05, 3]) // top at y=3, underside 2.95
    const target = ensureVoxelTarget(world, 'slab-1')!
    expect(target.kind).toBe('slab')
    expect(target.segments.length).toBeGreaterThan(0)
    for (const joist of target.segments) {
      expect(joist.size[1]).toBeCloseTo(0.235, 6) // full 2×10 depth
      expect(joist.center[1] + joist.size[1] / 2).toBeCloseTo(2.95, 6) // tops at underside
    }
    // Same 16" o.c. layout machinery as embedded joists.
    const lines = new Set(target.segments.map((s) => Math.round(s.center[0] * 1000)))
    expect(lines.size).toBe(10)
  })

  test('a GROUND-LEVEL thin slab still carries no framing', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-ground', 'slab', [4, 0.05, 3], [10, 0.025, 10]))
    const target = ensureVoxelTarget(world, 'slab-ground')!
    expect(target.kind).toBe('slab')
    expect(target.segments.length).toBe(0)
  })
})

describe('zero-thickness ceiling planes (host levels emit 0 m plates)', () => {
  test('a 0-extent ceiling voxelizes as a thin plate hugging the surface, not an isotropic volume', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('ceil-1', 'ceiling', [6.5, 0.0002, 5], [0, 2.48, 0]))
    const target = ensureVoxelTarget(world, 'ceil-1')!
    expect(target.kind).toBe('slab')
    const { grid } = target
    expect(grid.count).toBeGreaterThan(0)
    // Every cell top stays within a couple cm of the plane — the volume
    // lane's ~0.15 m cells used to interpenetrate the base row of walls
    // standing ON the plane and defeat the structure probe's min-drop gate.
    for (let i = 0; i < grid.count; i++) {
      const top = grid.centers[i * 3 + 1]! + grid.cellY / 2
      expect(top).toBeGreaterThan(2.44)
      expect(top).toBeLessThan(2.51)
    }
  })

  test('a wall whose only underpinning is the voxelized ceiling plane stays SUPPORTED', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('ceil-1', 'ceiling', [6.5, 0.0002, 5], [0, 2.48, 0]))
    // Upper-storey wall bearing on the plane (base at 2.5, like the host's
    // level-2 walls; not in world.walls, so it grids via the volume lane —
    // the probe only needs its base row).
    world.colliders.push(boxCollider('wall-up', 'wall', [2, 2.45, 0.1], [0, 2.5 + 2.45 / 2, 0]))
    const ceiling = ensureVoxelTarget(world, 'ceil-1')!
    const wallUp = ensureVoxelTarget(world, 'wall-up')!
    // Voxelization disabled both host colliders — support must come from
    // the ceiling PLATE cells alone.
    const ctx = {
      colliders: world.colliders,
      targets: () => [ceiling],
      terrainY: 0,
    }
    expect(probeTargetSupport(wallUp, ctx)).toBe(true)
    // Counterfactual: with the plate gone the wall really is unsupported —
    // the probe above is not trivially true.
    expect(probeTargetSupport(wallUp, { ...ctx, targets: () => [] })).toBe(false)
  })

  test('upward fire into a ceiling plate carves on EVERY hit (entry-face boundary noise)', () => {
    // QA phase-6 round 3: 6/8 upward rifle shots at a ceiling plate removed
    // ZERO voxels. The plate's cells all live in its TOP thickness layer, so
    // an upward shot's DDA point lands EXACTLY on the halves boundary of the
    // entry-skin test — float noise picked the empty bottom half and the
    // skin-limited carve deleted nothing. entrySkin now steps half a cell
    // INTO the grid along the shot before picking the side.
    const world = makeWorld()
    world.colliders.push(boxCollider('ceil-1', 'ceiling', [6.5, 0.0002, 5], [0, 2.48, 0]))
    const target = ensureVoxelTarget(world, 'ceil-1')!
    const { grid } = target
    const up = new Vector3(0, 1, 0)
    // Entry face of the populated top layer, a hair LOW (the noisy side).
    const entryY = grid.origin.y + grid.cellY - 1e-4
    const spots: Array<[number, number]> = [
      [0.2, 0.3],
      [-1.1, 0.8],
      [1.4, -0.9],
      [-0.6, -1.2],
    ]
    for (const [x, z] of spots) {
      expect(damageTarget(world, 'ceil-1', new Vector3(x, entryY, z), 0.45, up)).toBeGreaterThan(0)
    }
  })

  test('the plate is CONTACT-ONLY support — it never props a wall floating higher in the gap band', () => {
    // Host scenes stack a real slab (2.5–2.55) on top of the ceiling plane
    // (2.48); L2 walls bear on the SLAB at 2.55. Carving the slab strip
    // under a wall must drop it even though live plate cells survive 6.5 cm
    // below its base — a finish plane carries only what RESTS on it (QA
    // round 2 follow-up: pre-gate the cascade stalled with the wall propped
    // by the plate).
    const world = makeWorld()
    world.colliders.push(boxCollider('ceil-1', 'ceiling', [6.5, 0.0002, 5], [0, 2.48, 0]))
    world.colliders.push(boxCollider('wall-up', 'wall', [2, 2.45, 0.1], [0, 2.55 + 2.45 / 2, 0]))
    const ceiling = ensureVoxelTarget(world, 'ceil-1')!
    const wallUp = ensureVoxelTarget(world, 'wall-up')!
    expect(ceiling.contactOnlySupport).toBe(true)
    const ctx = {
      colliders: world.colliders,
      targets: () => [ceiling],
      terrainY: 0,
    }
    // Base at 2.55, plate top ~2.485: drop 0.065 > PLATE_CONTACT_SLACK.
    expect(probeTargetSupport(wallUp, ctx)).toBe(false)
    // A real slab in the same band WOULD hold it (not contact-gated).
    const slabUnder = ensureVoxelTarget(makeWorld([4, 0.3, 3]), 'slab-1')!
    expect(slabUnder.contactOnlySupport).toBeFalsy()
  })
})

describe('floors for things — debris/dust landing probe', () => {
  test('probeLandingY reports the highest live surface below the point', () => {
    const world = makeWorld()
    // Over the intact slab: the host collider top (y = 3).
    expect(probeLandingY(world, 0, 4, 0)).toBeCloseTo(3, 5)
    // Off every surface: the lot's terrain plane.
    expect(probeLandingY(world, 30, 4, 30)).toBe(0)
    // Voxelized (host collider disabled) — the grid answers, same plane.
    ensureVoxelTarget(world, 'slab-1')
    expect(Math.abs(probeLandingY(world, 0, 4, 0) - 3)).toBeLessThan(0.06)
    // Through-hole: the probe falls past the carved column to the terrain.
    damageTarget(world, 'slab-1', new Vector3(1, 2.85, 1), 0.7)
    expect(probeLandingY(world, 1, 4, 1)).toBeLessThan(0.1)
  })

  test('the probe ignores WALL grids — debris torn off a wall never floats on its own source', () => {
    // An upper-storey wall standing on the slab; its debris pops off the
    // face and probes at apex while still inside the wall's plan band. The
    // wall's own live cells beneath the apex must NOT read as the floor —
    // the piece lands on the SLAB below.
    const world = makeWorld()
    const wall = boxCollider('wall-up', 'wall', [2, 2.45, 0.1], [0, 3 + 2.45 / 2, 0.5])
    world.colliders.push(wall)
    world.walls.set('wall-up', {
      node: {
        id: 'wall-up',
        start: [-1, 0.5],
        end: [1, 0.5],
        height: 2.45,
        thickness: 0.1,
      },
      root: wall.root,
      meshes: [wall.mesh],
    } as never)
    ensureVoxelTarget(world, 'slab-1')
    const wallT = ensureVoxelTarget(world, 'wall-up')!
    expect(wallT.kind).toBe('wall')
    damageTarget(world, 'wall-up', new Vector3(0, 4.3, 0.5), 0.4)
    // Probe inside the wall band, mid-height: live wall cells sit right
    // below, but the resolved floor is the slab top (~3), not ~4.
    const floor = probeLandingY(world, 0.3, 4.1, 0.5)
    expect(floor).toBeLessThan(3.1)
    expect(floor).toBeGreaterThan(2.8)
  })
})

describe('slab tear lane (skin-respecting carve + ceiling sheet fly-off)', () => {
  test('a sub-pierce shot from below opens only the ceiling skin', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'slab-1')!
    const removed = damageTarget(
      world,
      'slab-1',
      new Vector3(0.15, 2.7, 0.15), // ON the ceiling face
      0.45,
      new Vector3(0, 1, 0),
    )
    expect(removed).toBeGreaterThan(0)
    // Sphere reach spans both skins, but the sheathing above must hold.
    const { grid } = target
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 1] === grid.ny - 1) expect(grid.alive[i]).toBe(1)
    }
    let bottomDead = 0
    for (let i = 0; i < grid.count; i++) {
      if (grid.coords[i * 3 + 1] === 0 && !grid.alive[i]) bottomDead++
    }
    expect(bottomDead).toBe(removed)
  })

  test('a torn ceiling board flies off DOWNWARD (shards launch along −Y)', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'slab-1')!
    const up = new Vector3(0, 1, 0)
    let flew = false
    for (const z of [-0.3, 0, 0.3, -0.6, 0.6]) {
      clearDebris()
      damageTarget(world, 'slab-1', new Vector3(-0.2, 2.7, z), 0.45, up)
      if (target.sheets.some((s) => s.side === 0 && s.flownOff)) {
        flew = true
        break
      }
    }
    expect(flew).toBe(true)
    const flown = target.sheets.find((s) => s.side === 0 && s.flownOff)!
    expect(flown.normal[1]).toBeCloseTo(-1, 5)
    // The fly-off's shard plates dominate the flat pool and left downward.
    const census = debrisCensus()
    expect(census.flats).toBeGreaterThan(0)
    expect(census.meanVyFlat).toBeLessThan(0)
  })

  test('carves splash-chip joists (hp-1 floor); direct damage snaps them', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'slab-1')!
    const joist = target.segments[0]!
    const at = new Vector3(joist.center[0], joist.center[1], joist.center[2])
    damageTarget(world, 'slab-1', at, 0.5)
    expect(joist.hp).toBe(1) // chipped by the splash…
    expect(joist.broken).toBe(false)
    damageTarget(world, 'slab-1', at, 0.5)
    expect(joist.hp).toBe(1) // …but splash never snaps (hp-1 floor)
    expect(joist.broken).toBe(false)
    // Direct hits do: hp 2 → knife twice / one gun round.
    expect(damageSegment(world, 'slab-1', joist.id, 999, at)).toBe(true)
    expect(joist.broken).toBe(true)
  })
})

describe('slab island support (probe beneath, not own base row)', () => {
  test('severing the slab from its bearing wall crumbles the cut-off region only', async () => {
    const world = makeWorld() // support wall under the x-min edge only
    const target = ensureVoxelTarget(world, 'slab-1')!
    // Full-depth trench at x = 0 across the whole z span (radius clears the
    // pierce gate, so both skins go).
    for (const z of [-1.35, -0.75, -0.15, 0.45, 1.05]) {
      damageTarget(world, 'slab-1', new Vector3(0, 2.85, z), 0.7)
    }
    // Both regions still hold live cells right after the carve…
    const live = (min: number, max: number) => {
      let n = 0
      const { grid } = target
      for (let i = 0; i < grid.count; i++) {
        const x = grid.centers[i * 3]!
        if (grid.alive[i] && x >= min && x <= max) n++
      }
      return n
    }
    expect(live(0.8, 2)).toBeGreaterThan(0)
    expect(live(-2, -1.5)).toBeGreaterThan(0)
    // …then the settle pass drops the region with no bearing beneath it and
    // keeps the region over the wall.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(live(0.8, 2)).toBe(0)
    expect(live(-2, -1.5)).toBeGreaterThan(0)
  })

  test('a terrain-borne slab never crumbles from lateral carves', async () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('pad-1', 'slab', [3, 0.2, 3], [10, 0.1, 0]))
    const target = ensureVoxelTarget(world, 'pad-1')!
    expect(target.kind).toBe('slab')
    for (const z of [-1.2, -0.6, 0, 0.6, 1.2]) {
      damageTarget(world, 'pad-1', new Vector3(10, 0.1, z), 0.7)
    }
    const before = target.grid.aliveCount
    expect(before).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(target.grid.aliveCount).toBe(before) // grounded — no island fell
  })

  test('region collapse samples debris (≤ 120 pieces, ring never floods)', async () => {
    const world = makeWorld([8, 0.3, 6]) // big slab → big cut-off region
    const target = ensureVoxelTarget(world, 'slab-1')!
    // Trench one sheet-tile away from the bearing edge (tearing the edge
    // tile would fly the bearing board off and drop the WHOLE slab) — the
    // cut-off region is still ring-sized (~330 cells).
    for (const z of [-2.7, -2.1, -1.5, -0.9, -0.3, 0.3, 0.9, 1.5, 2.1, 2.7]) {
      damageTarget(world, 'slab-1', new Vector3(-1, 2.85, z), 0.7)
    }
    const beforeCrumble = target.grid.aliveCount
    clearDebris() // drop the carve debris — measure the crumble alone
    await new Promise((resolve) => setTimeout(resolve, 400))
    const fallen = beforeCrumble - target.grid.aliveCount
    expect(fallen).toBeGreaterThan(120) // the event really was ring-sized
    const census = debrisCensus()
    expect(census.live).toBeGreaterThan(0)
    expect(census.live).toBeLessThanOrEqual(120)
  })
})

describe('fall-through (capsule vs carved slab)', () => {
  test('the capsule stands on the intact sandwich and drops through a hole', () => {
    const world = makeWorld()
    ensureVoxelTarget(world, 'slab-1')
    // Standing on the intact floor: contact + grounded.
    const pos = new Vector3(1, 2.99, 0.5)
    const vel = new Vector3(0, -1, 0)
    expect(collideVoxelTargets(pos, vel, 0.34, 1.7)).toBe(true)
    expect(pos.y).toBeGreaterThan(2.99) // pushed up onto the top skin
    expect(vel.y).toBeGreaterThanOrEqual(-1e-6) // downward velocity absorbed

    // Blow a hole wider than the capsule at that spot…
    damageTarget(world, 'slab-1', new Vector3(1, 3, 0.5), 0.7)
    const dropPos = new Vector3(1, 2.99, 0.5)
    const dropVel = new Vector3(0, -1, 0)
    // …and the same capsule finds nothing to stand on.
    expect(collideVoxelTargets(dropPos, dropVel, 0.34, 1.7)).toBe(false)
    expect(dropPos.y).toBeCloseTo(2.99, 6)
    expect(dropVel.y).toBeCloseTo(-1, 6)
  })
})
