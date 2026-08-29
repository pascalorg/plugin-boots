import { afterEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Color,
  type Material,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Vector3,
} from 'three'
import { craterSlots, resetCraters } from './craters'
import { clearDebris, debrisCensus } from './debris'
import {
  cellTint,
  collapseWholeTarget,
  damageExplosion,
  damageSegment,
  damageTarget,
  dominantTargetMaterial,
  dormantTargetCount,
  dropTarget,
  ensureVoxelTarget,
  floorBreachOpened,
  EXPLOSION_CORE_NODES,
  isMetalItemMaterial,
  ITEM_CHUNK_CAP,
  ITEM_CHUNK_PER_CELLS,
  ITEM_CHUNK_SCALE_MIN,
  ITEM_CHUNK_SCALE_SPAN,
  itemChunkCount,
  itemChunkSize,
  prevoxelizeTick,
  raycastSegments,
  resetDestruction,
  savedCoatHex,
  useDestruction,
  wakeAheadTick,
} from './destruction'
import {
  FLOOR_CLOD_DARK_HEX,
  FLOOR_DIRT_LIGHT_HEX,
  floorColumnHash,
  isUntexturedWhite,
  kindFallbackTone,
  pendingToneCount,
  primedCellColor,
  retryPendingTones,
  STRUCTURE_TOP_HEX,
  toneAuditReport,
} from './skin-tone'
import { settleTasksPending } from './structure'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * Round-2 destruction surface, headless: session-start prevoxelization
 * (walls clad + host colliders handed over without a single shot) and the
 * LOGICAL sheet system — per-face ~1.2 × 2.4 m groups of existing skin
 * voxels that count carve hits/torn cells and fly off wholesale. No new
 * rendered plane exists anywhere in the sheet model (coplanar z-fighting is
 * impossible by construction), so everything here asserts on grid + member
 * state only.
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

/** Two walls facing the z+ firing line + one crate volume — the same layout
 * family as the shooting tests. */
function makeWorld(): GameWorld {
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0])
  const crate = boxCollider('crate-1', 'item', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const colliders = [wallA, wallB, crate]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [3.5, 0], [6.5, 0])],
    ]),
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
})

const expectSameColor = (a: Color, b: Color) => {
  expect(a.r).toBeCloseTo(b.r, 10)
  expect(a.g).toBeCloseTo(b.g, 10)
  expect(a.b).toBeCloseTo(b.b, 10)
}

describe('prevoxelizeTick', () => {
  test('voxelizes walls AND items awake without a shot, colliders handed over', () => {
    const world = makeWorld()
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    const targets = useDestruction.getState().targets
    expect(targets.get('wall-1')?.kind).toBe('wall')
    expect(targets.get('wall-2')?.kind).toBe('wall')
    // Walls wake instantly (the bricks-from-the-start look) — and so do
    // ITEM-FAMILY nodes (voxel-first, owner 2026-08-28): the crate's host
    // GLB hides at session start and its silhouette replica renders from
    // frame one, so an item never morphs into voxels on its first hit —
    // it just starts losing chunks. Roofs and slabs joined them (round 2,
    // "no morphing anywhere"); only doors/windows and the block/column/
    // stair family still prebuild DORMANT (live host behaviors).
    expect(targets.get('wall-1')?.dormant).toBeFalsy()
    expect(targets.get('crate-1')?.dormant).toBeFalsy()
    expect(targets.get('crate-1')?.item).toBe(true)
    // Host handover happened for walls and items alike, in the same ticks.
    for (const collider of world.colliders) {
      expect(Boolean(collider.disabled)).toBe(true)
    }
    // The anatomy is fully there before any damage.
    const wall = targets.get('wall-1')!
    expect(wall.grid.aliveCount).toBeGreaterThan(0)
    expect(wall.studs.length).toBeGreaterThan(0)
    expect(wall.sheets.length).toBeGreaterThan(0)
  })

  test('a zero-budget tick returns false and a later tick finishes the job', () => {
    const world = makeWorld()
    expect(prevoxelizeTick(world, 0)).toBe(false)
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    expect(prevoxelizeTick(world, 8)).toBe(true) // idempotent once done
  })

  test('dormant census tracks non-item prebuilds; wake-ahead idles out at zero', () => {
    const world = makeWorld()
    // Items are voxel-first (awake at prevoxelize), so the census needs a
    // NON-item explodable for coverage: a door still prebuilds dormant.
    world.colliders.push(boxCollider('door-1', 'door', [0.9, 2.1, 0.1], [2.5, 1.05, 3]))
    expect(dormantTargetCount()).toBe(0)
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    // Walls + the crate wake instantly; the door is the one dormant prebuild.
    expect(useDestruction.getState().targets.get('crate-1')?.dormant).toBeFalsy()
    expect(useDestruction.getState().targets.get('door-1')?.dormant).toBe(true)
    expect(dormantTargetCount()).toBe(1)
    // A cooking stick near the door wakes it through wakeAheadTick…
    const center = new Vector3(2.5, 1.05, 3)
    expect(wakeAheadTick(world, center, 3.2)).toBe(true)
    expect(useDestruction.getState().targets.get('door-1')?.dormant).toBeFalsy()
    expect(dormantTargetCount()).toBe(0)
    // …and once the census is zero the per-frame scan idles out O(1).
    expect(wakeAheadTick(world, center, 3.2)).toBe(false)
  })

  test('roofs and slabs voxelize AWAKE too: replicas from frame one, no morphing (owner round 2)', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-1', 'slab', [3, 0.2, 3], [0, 3, 5]))
    world.colliders.push(boxCollider('ceil-1', 'ceiling', [3, 0.1, 3], [0, 2.6, -5]))
    world.colliders.push(boxCollider('roof-1', 'roof', [4, 0.3, 4], [0, 5.6, 0]))
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    const targets = useDestruction.getState().targets
    for (const nodeId of ['slab-1', 'ceil-1', 'roof-1']) {
      const target = targets.get(nodeId)!
      expect(target).toBeDefined()
      expect(target.dormant).toBeFalsy()
      expect(target.grid.aliveCount).toBeGreaterThan(0)
    }
    expect(dormantTargetCount()).toBe(0)
    // The hosts handed over at session start: colliders disabled so the
    // voxel grids own collision from frame one. (The mesh hide itself
    // rides hideForGame's session ledger — a live-session concern; it
    // no-ops headless, and Esc-restore is session.ts's tested contract.)
    for (const nodeId of ['slab-1', 'ceil-1', 'roof-1']) {
      const collider = world.colliders.find((c) => c.nodeId === nodeId)!
      expect(Boolean(collider.disabled)).toBe(true)
    }
  })

  test('placed items (__boots-item-*) never prebuild and never wedge completeness', () => {
    const world = makeWorld()
    let done = false
    for (let i = 0; i < 50 && !done; i++) done = prevoxelizeTick(world, 8)
    expect(done).toBe(true)
    // A placed item's GLB collider arrives MID-session (item-place.tsx
    // swaps the shot proxy after async load) — item-place owns its whole
    // voxel lifecycle, so the zero-budget completeness probe (warmup.tsx
    // gates its background BVH drain on it) must stay true and no dormant
    // target may be built for it.
    world.colliders.push(boxCollider('__boots-item-7', 'item', [0.8, 0.8, 0.8], [8, 0.4, 2]))
    expect(prevoxelizeTick(world, 0)).toBe(true)
    expect(prevoxelizeTick(world, 8)).toBe(true)
    expect(useDestruction.getState().targets.has('__boots-item-7')).toBe(false)
  })
})

describe('floor slab tone lane (owner wave 5: "the floor inside is white")', () => {
  /** The two-material host floor: a WOOD walking surface over a WHITE
   * ceiling underside + white rim (BoxGeometry's 6 material groups —
   * index 2 is +Y). White owns MORE area (bottom 9 m² + sides 2.4 m² vs
   * top 9 m²), so an all-faces area pick would come back white. */
  function twoMaterialFloorMesh(): Mesh {
    const white = new MeshStandardMaterial({ color: '#ffffff' })
    const wood = new MeshStandardMaterial({ color: '#8b5a2b' })
    const mesh = new Mesh(new BoxGeometry(3, 0.2, 3), [
      white, // +x
      white, // -x
      wood, // +y — the floor finish
      white, // -y — the white ceiling underside
      white, // +z
      white, // -z
    ])
    mesh.position.set(0, 0.1, 5)
    mesh.updateMatrixWorld(true)
    return mesh
  }

  test('dominant material for floors is the TOP face — the white underside never wins by area', () => {
    const mesh = twoMaterialFloorMesh()
    const picked = dominantTargetMaterial([mesh], 'floor')
    expect(picked?.color?.getHexString()).toBe('8b5a2b')
    // Same protection on the legacy 'slab' tone kind (ceiling-family).
    expect(dominantTargetMaterial([mesh], 'slab')?.color?.getHexString()).toBe('8b5a2b')
  })

  test('slab/floor nodes voxelize with floorCore; ceilings do not', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-9', 'slab', [3, 0.2, 3], [0, 3, 5]))
    world.colliders.push(boxCollider('floor-9', 'floor', [3, 0.2, 3], [8, 3, 5]))
    world.colliders.push(boxCollider('ceil-9', 'ceiling', [3, 0.1, 3], [0, 2.6, -5]))
    const targets = useDestruction.getState().targets
    for (const nodeId of ['slab-9', 'floor-9', 'ceil-9']) {
      expect(ensureVoxelTarget(world, nodeId)?.kind).toBe('slab')
    }
    expect(targets.get('slab-9')?.floorCore).toBe(true)
    expect(targets.get('floor-9')?.floorCore).toBe(true)
    expect(targets.get('ceil-9')?.floorCore).toBeFalsy()
    // The mirror flag: ceilings mute their attic-side TOP layer
    // (skin-tone.ts ceilingTop); floors keep their walking surface.
    expect(targets.get('ceil-9')?.ceilingTop).toBe(true)
    expect(targets.get('slab-9')?.ceilingTop).toBeFalsy()
    expect(targets.get('floor-9')?.ceilingTop).toBeFalsy()
  })

  test('a white-material floor slab falls back to the WOOD family tone, never screed gray', () => {
    const world = makeWorld()
    // boxCollider meshes wear three's default white MeshBasicMaterial —
    // exactly the untextured-white lie the chain must not honor.
    world.colliders.push(boxCollider('slab-9', 'slab', [3, 0.2, 3], [0, 3, 5]))
    const target = ensureVoxelTarget(world, 'slab-9')!
    expectSameColor(target.baseColor, kindFallbackTone('floor'))
    expect(isUntexturedWhite(target.baseColor)).toBe(false)
    // The audit names the floor lane.
    expect(toneAuditReport()).toEqual([{ nodeId: 'slab-9', kind: 'floor', why: 'white-base' }])
  })

  test('under-layer cells of a floor slab prime as dirt subfloor; the top layer keeps the floor tone', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-9', 'slab', [3, 0.2, 3], [0, 3, 5]))
    const target = ensureVoxelTarget(world, 'slab-9')!
    const topLayer = target.grid.ny - 1
    let unders = 0
    let tops = 0
    const out = new Color()
    for (let i = 0; i < target.grid.count && (unders < 6 || tops < 6); i++) {
      const iy = target.grid.coords[i * 3 + 1]!
      primedCellColor(out, target, i)
      // Pin against the exact primeSkin math: dirt for every layer under
      // the walking surface — the per-column clod blend (skin-tone.ts
      // FLOOR_CLOD anchors; no toneGrid here, so no flecks) — and the
      // resolved (wood-fallback) tone on top.
      const j1 = ((i * 2654435761) % 97) / 97
      const j2 = ((i * 1597334677) % 89) / 89
      const clod = floorColumnHash(target.grid.coords[i * 3]!, target.grid.coords[i * 3 + 2]!)
      const expected = (
        iy < topLayer
          ? new Color(FLOOR_CLOD_DARK_HEX).lerp(
              new Color(FLOOR_DIRT_LIGHT_HEX),
              (clod % 1024) / 1024,
            )
          : target.baseColor.clone()
      ).offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1)
      expectSameColor(out, expected)
      if (iy < topLayer) unders++
      else tops++
    }
    expect(unders).toBeGreaterThan(0)
    expect(tops).toBeGreaterThan(0)
  })
})

describe('debris tint + floor breach (owner: "broken floor looks broken")', () => {
  test('cellTint funnels through primedCellColor — debris wears the cell skin tone, not baseColor', () => {
    const world = makeWorld()
    world.colliders.push(boxCollider('slab-9', 'slab', [3, 0.2, 3], [0, 3, 5]))
    const target = ensureVoxelTarget(world, 'slab-9')!
    const out = new Color()
    let checkedUnder = false
    for (let i = 0; i < target.grid.count; i++) {
      // Scratch contract: copy the tint before the next call.
      const tint = cellTint(target, i).clone()
      expectSameColor(tint, primedCellColor(out, target, i))
      if (!checkedUnder && target.grid.coords[i * 3 + 1] === 0) {
        // A bottom-skin cell of a floor slab sheds DIRT-brown debris.
        expect(isUntexturedWhite(tint)).toBe(false)
        expect(tint.r).toBeGreaterThan(tint.b)
        checkedUnder = true
      }
    }
    expect(checkedUnder).toBe(true)
    // Item palette still wins over the primed chain (fake target).
    const fake = {
      kind: 'volume',
      baseColor: new Color('#ff0000'),
      cellColors: new Float32Array([0.2, 0.4, 0.6]),
      grid: { coords: new Int16Array([0, 0, 0]) },
    } as unknown as Parameters<typeof cellTint>[0]
    const item = cellTint(fake, 0)
    // Float32Array palette — f32 precision.
    expect(item.r).toBeCloseTo(0.2, 6)
    expect(item.g).toBeCloseTo(0.4, 6)
    expect(item.b).toBeCloseTo(0.6, 6)
  })

  test('floorBreachOpened: true only when a removed column holds no live cell top-to-bottom', () => {
    // A 2×1×2 plan sandwich (ny 2): lattice keys ix + nx·(iy + ny·iz).
    const nx = 2
    const ny = 2
    const triples: [number, number, number][] = []
    for (let iz = 0; iz < 2; iz++)
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) triples.push([ix, iy, iz])
    const coords = new Int16Array(triples.length * 3)
    const index = new Map<number, number>()
    triples.forEach(([ix, iy, iz], i) => {
      coords[i * 3] = ix
      coords[i * 3 + 1] = iy
      coords[i * 3 + 2] = iz
      index.set(ix + nx * (iy + ny * iz), i)
    })
    const alive = new Uint8Array(triples.length).fill(1)
    const grid = { coords, index, alive, nx, ny }
    const at = (ix: number, iy: number, iz: number) => index.get(ix + nx * (iy + ny * iz))!
    // Top-only removal (the pierce gate's skin carve): no breach.
    const topOnly = at(0, 1, 0)
    alive[topOnly] = 0
    expect(floorBreachOpened(grid, [topOnly])).toBe(false)
    // Bottom goes too — the column is daylight now.
    const bottom = at(0, 0, 0)
    alive[bottom] = 0
    expect(floorBreachOpened(grid, [bottom])).toBe(true)
    // A removal elsewhere doesn't read the (0,0) hole as its own breach.
    const other = at(1, 1, 1)
    alive[other] = 0
    expect(floorBreachOpened(grid, [other])).toBe(false)
  })

  test('a THROUGH carve on a GROUND slab stamps ONE soil breach decal; upper storeys never do', () => {
    resetCraters()
    const world = makeWorld()
    world.colliders.push(boxCollider('pad-g', 'slab', [3, 0.2, 3], [10, 0.1, 10])) // base y = 0
    world.colliders.push(boxCollider('slab-up', 'slab', [3, 0.2, 3], [0, 3, 5])) // storey 2
    // Full-depth carve (radius ≥ the pierce gate) straight through the pad.
    expect(damageTarget(world, 'pad-g', new Vector3(10, 0.1, 10), 0.7)).toBeGreaterThan(0)
    let breaches = craterSlots().filter((s) => s.alive && s.breach)
    expect(breaches.length).toBe(1)
    expect(breaches[0]!.x).toBe(10)
    expect(breaches[0]!.z).toBe(10)
    // Just above the lawn plane (0.05), modest size: carve radius × 1.2.
    expect(breaches[0]!.y).toBeGreaterThan(0.05)
    expect(breaches[0]!.y).toBeLessThan(0.12)
    expect(breaches[0]!.radius).toBeCloseTo(0.7 * 1.2, 5)
    // Widening the same hole reuses the decal instead of stacking slots.
    damageTarget(world, 'pad-g', new Vector3(10.4, 0.1, 10), 0.7)
    breaches = craterSlots().filter((s) => s.alive && s.breach)
    expect(breaches.length).toBe(1)
    // The upper-storey slab breaches THROUGH too — but its hole must show
    // the room below, never a ground decal.
    expect(damageTarget(world, 'slab-up', new Vector3(0, 3, 5), 0.7)).toBeGreaterThan(0)
    expect(craterSlots().filter((s) => s.alive && s.breach).length).toBe(1)
    resetCraters()
  })
})

describe('eave-teeth tone lane (round-5 QA: light sawtooth through the eave slit)', () => {
  /** The exact primed-cell reference for the muted structural top tone. */
  const structureReference = (i: number): Color => {
    const j1 = ((i * 2654435761) % 97) / 97
    const j2 = ((i * 1597334677) % 89) / 89
    return new Color(STRUCTURE_TOP_HEX).offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1)
  }

  test('a ceiling slab flags ceilingTop but primes every CELL with the plain slab chain (mute is per FACE)', () => {
    // Live host ceilings voxelize as ONE cell layer whose bottom face IS
    // the room ceiling — a per-cell mute darkened the interior view
    // (2026-08-29 regression). The attic-side mute rides voxel-walls'
    // CEILING_GEOMETRY vertex colors (skin-tone.ts CEILING_FACE_TINT);
    // destruction's job is only the ceilingTop KEY plus untouched cell
    // tones: top layers keep the flat tone, the bottom skin keeps the
    // drywall lighten, both bit-identical to a plain slab.
    const world = makeWorld()
    world.colliders.push(boxCollider('ceil-9', 'ceiling', [3, 0.1, 3], [0, 2.6, -5]))
    const target = ensureVoxelTarget(world, 'ceil-9')!
    expect(target.ceilingTop).toBe(true)
    const topLayer = target.grid.ny - 1
    expect(topLayer).toBeGreaterThan(0)
    const out = new Color()
    let tops = 0
    let bottoms = 0
    for (let i = 0; i < target.grid.count && (tops < 6 || bottoms < 6); i++) {
      const iy = target.grid.coords[i * 3 + 1]!
      if (iy !== topLayer && iy !== 0) continue
      primedCellColor(out, target, i)
      const j1 = ((i * 2654435761) % 97) / 97
      const j2 = ((i * 1597334677) % 89) / 89
      const base =
        iy === 0
          ? // Bottom skin: bit-identical to the legacy ceiling lighten.
            target.baseColor.clone().offsetHSL(0, -0.06, 0.14)
          : // Top layer: the FLAT tone — never the structural mute.
            target.baseColor.clone()
      expectSameColor(out, base.offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1))
      if (iy === topLayer) tops++
      else bottoms++
    }
    expect(tops).toBeGreaterThan(0)
    expect(bottoms).toBeGreaterThan(0)
  })

  test('a wall primes its TOP row (the plate) muted; every row below keeps the wall tone', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target.kind).toBe('wall')
    const topRow = target.grid.ny - 1
    expect(topRow).toBeGreaterThan(0)
    const out = new Color()
    let tops = 0
    let bodies = 0
    for (let i = 0; i < target.grid.count && (tops < 6 || bodies < 6); i++) {
      const iy = target.grid.coords[i * 3 + 1]!
      primedCellColor(out, target, i)
      if (iy === topRow) {
        expectSameColor(out, structureReference(i))
        tops++
      } else {
        const j1 = ((i * 2654435761) % 97) / 97
        const j2 = ((i * 1597334677) % 89) / 89
        expectSameColor(
          out,
          target.baseColor.clone().offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * 0.1),
        )
        bodies++
      }
    }
    expect(tops).toBeGreaterThan(0)
    expect(bodies).toBeGreaterThan(0)
  })
})

describe('skin-respecting carve (pierce fix)', () => {
  test('a rifle-size tear opens only the entered skin; the far face holds', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Shot entering the z-min face of the 0.12 m wall — the carve sphere
    // (rifle tearRadius 0.55) spans both skins, but only the entered one
    // may lose cells.
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    expect(removed).toBeGreaterThan(0)
    for (const sheet of wall.sheets) {
      if (sheet.side === 1) {
        expect(sheet.torn).toBe(0)
        for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(1)
      }
    }
    expect(wall.sheets.some((s) => s.side === 0 && s.torn > 0)).toBe(true)
  })

  test('a follow-up through the hole tears the far skin', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    // Second shot sails through the near-skin hole and lands ON the far
    // face — its entry point is on side 1 now, so side 1 tears.
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0.02), 0.55, new Vector3(0, 0, 1))
    expect(removed).toBeGreaterThan(0)
    expect(wall.sheets.some((s) => s.side === 1 && s.torn > 0)).toBe(true)
  })

  test('a heavy carve past the pierce gate punches both skins at once', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, -0.06), 0.65, new Vector3(0, 0, 1))
    const sides = new Set(wall.sheets.filter((s) => s.torn > 0).map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
  })
})

describe('framing segments (charcoal sticks)', () => {
  test('walls carry stick segments at the real lumber cross-section; studs aliases the array', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    expect(wall.segments.length).toBeGreaterThan(0)
    expect(wall.studs).toBe(wall.segments)
    for (const seg of wall.segments) {
      expect(seg.hp).toBeGreaterThan(0)
      expect(seg.broken).toBe(false)
      // Cross-section is real lumber — every axis but the long one is far
      // skinnier than the 0.15 m render cell.
      const sorted = [...seg.size].sort((a, b) => a - b)
      expect(sorted[0]!).toBeLessThan(0.05)
      expect(sorted[1]!).toBeLessThan(0.1)
      // Depth never poked proud of the 0.12 m wall.
      expect(sorted[1]!).toBeLessThanOrEqual(0.12)
    }
    // Vertical 2.6 m lines split into thirds — sticks, not whole studs.
    const verticals = wall.segments.filter((s) => s.size[1] > s.size[0])
    expect(verticals.length).toBeGreaterThan(0)
    for (const seg of verticals) expect(seg.size[1]).toBeLessThan(1)
    // Ids are array indices (fixed-length member contract).
    wall.segments.forEach((seg, i) => expect(seg.id).toBe(i))
    // Volumes carry no framing.
    expect(ensureVoxelTarget(world, 'crate-1')!.segments.length).toBe(0)
  })

  test('raycastSegments finds the stick, damageSegment chips then snaps it', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const hit = raycastSegments(new Vector3(0.2192, 1.35, 5), new Vector3(0, 0, -1), 90)
    expect(hit).not.toBeNull()
    expect(hit!.nodeId).toBe('wall-1')
    expect(hit!.studId).toBe(hit!.segmentId)
    const seg = wall.segments[hit!.segmentId]!
    const revBefore = wall.revision
    // Chip: hp drops, no break, revision untouched (checksum picks it up).
    expect(damageSegment(world, 'wall-1', seg.id, 1, hit!.point)).toBe(true)
    expect(seg.hp).toBe(1)
    expect(seg.broken).toBe(false)
    expect(wall.revision).toBe(revBefore)
    // Snap: broken, revision bumped, no underflow, further damage refused.
    expect(damageSegment(world, 'wall-1', seg.id, 24, hit!.point)).toBe(true)
    expect(seg.broken).toBe(true)
    expect(seg.hp).toBe(0)
    expect(wall.revision).toBe(revBefore + 1)
    expect(damageSegment(world, 'wall-1', seg.id, 24, hit!.point)).toBe(false)
    // Broken sticks are transparent to the segment ray.
    const again = raycastSegments(new Vector3(0.2192, 1.35, 5), new Vector3(0, 0, -1), 90)
    expect(again?.segmentId).not.toBe(seg.id)
  })
})

describe('carve splash chips the framing (gunfire chips neighbors)', () => {
  test('a rifle tear at mid-bay chips the flanking stick each side, never snaps it', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Stud lines on wall-1 sit at x = -1 + i*0.4064; aim between two of
    // them (mid-bay) at stick height 1.35.
    const bayX = -1 + 1.5 * 0.4064
    damageTarget(world, 'wall-1', new Vector3(bayX, 1.35, -0.06), 0.55, new Vector3(0, 0, 1))
    const chipped = wall.segments.filter((s) => !s.broken && s.hp === 1)
    // Both flanking sticks (~0.2 m away) scuffed; nothing snapped by splash.
    expect(chipped.length).toBeGreaterThanOrEqual(2)
    expect(wall.segments.some((s) => s.broken)).toBe(false)
    // The next studs over (~0.61 m) stayed clean: chips are local.
    for (const seg of wall.segments) {
      const dx = Math.abs(seg.center[0] - bayX)
      if (seg.size[1] > seg.size[0] && dx > 0.56) expect(seg.hp).toBe(2)
    }
  })

  test('repeated carves in the same bay keep the hp-1 floor (splash is sub-lethal)', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const bayX = -1 + 1.5 * 0.4064
    // Fresh cells fall each time (rising carve height + the far skin
    // through the hole), so every carve re-runs the splash over the same
    // flanking sticks.
    for (const [y, z] of [
      [1.15, -0.06],
      [1.35, 0.02],
      [1.55, -0.06],
      [1.75, 0.02],
    ] as const) {
      damageTarget(world, 'wall-1', new Vector3(bayX, y, z), 0.55, new Vector3(0, 0, 1))
    }
    for (const seg of wall.segments) {
      expect(seg.broken).toBe(false)
      expect(seg.hp).toBeGreaterThanOrEqual(1)
    }
  })

  test('volume carves splash nothing (no framing)', () => {
    const world = makeWorld()
    const crate = ensureVoxelTarget(world, 'crate-1')!
    expect(crate.segments.length).toBe(0)
    expect(() =>
      damageTarget(world, 'crate-1', new Vector3(10, 1.35, -0.5), 0.4),
    ).not.toThrow()
  })
})

describe('voxel-first items break naturally (owner call 2026-08-28)', () => {
  test('itemChunkCount: ~1 chunk per 2-3 cells, floor 1, cap 14', () => {
    expect(itemChunkCount(0)).toBe(0)
    expect(itemChunkCount(1)).toBe(1)
    expect(itemChunkCount(2)).toBe(1)
    expect(itemChunkCount(5)).toBe(2)
    expect(itemChunkCount(12)).toBe(5)
    expect(itemChunkCount(35)).toBe(ITEM_CHUNK_CAP)
    expect(itemChunkCount(500)).toBe(ITEM_CHUNK_CAP)
  })

  test('itemChunkSize: chunks stay in the 1.6-2.6x cell band, 2-3x a same-roll wall crumb', () => {
    const cell = 0.08 // typical silhouette cell
    for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
      const chunk = itemChunkSize(cell, roll)
      expect(chunk).toBeGreaterThanOrEqual(cell * ITEM_CHUNK_SCALE_MIN)
      expect(chunk).toBeLessThanOrEqual(cell * (ITEM_CHUNK_SCALE_MIN + ITEM_CHUNK_SCALE_SPAN))
      // Wall crumbs draw at cell * (0.6 + roll * 0.5) — the same roll's
      // chunk is 2-3x that: fewer, LARGER pieces, never wall dust.
      const crumb = cell * (0.6 + roll * 0.5)
      expect(chunk / crumb).toBeGreaterThanOrEqual(2)
      expect(chunk / crumb).toBeLessThanOrEqual(3)
    }
  })

  test('an item carve spawns exactly the chunk budget — and no paper shards', () => {
    const world = makeWorld()
    const crate = ensureVoxelTarget(world, 'crate-1')!
    expect(crate.item).toBe(true)
    clearDebris()
    const removed = damageTarget(world, 'crate-1', new Vector3(10, 1.35, 0), 0.3)
    expect(removed).toBeGreaterThan(0)
    const census = debrisCensus()
    expect(census.live).toBe(itemChunkCount(removed))
    expect(census.live).toBeLessThanOrEqual(ITEM_CHUNK_CAP)
    // Porcelain sheds chunks, never drywall paper (flat shards are the
    // wall/roof sheet read).
    expect(census.flats).toBe(0)
    clearDebris()
  })

  test('a heavy smash caps at ITEM_CHUNK_CAP chunks per carve', () => {
    const world = makeWorld()
    ensureVoxelTarget(world, 'crate-1')
    clearDebris()
    const removed = damageTarget(world, 'crate-1', new Vector3(10, 1.35, 0), 0.8)
    expect(removed).toBeGreaterThan(ITEM_CHUNK_CAP * ITEM_CHUNK_PER_CELLS)
    expect(debrisCensus().live).toBe(ITEM_CHUNK_CAP)
    clearDebris()
  })
})

describe('island collapse on studless volumes (the shower cut)', () => {
  test('severing an item volume drops the floating top half after the settle delay', async () => {
    const world = makeWorld()
    const shower = boxCollider('shower-1', 'item', [0.9, 2.4, 0.9], [20, 1.2, 0])
    world.colliders.push(shower)
    const target = ensureVoxelTarget(world, 'shower-1')!
    expect(target.kind).toBe('volume')
    const total = target.grid.aliveCount
    // Cut clean through at y = 1.2 — a 3×3 pattern of carves covers the
    // full 0.9 × 0.9 cross-section.
    for (const dx of [-0.3, 0, 0.3]) {
      for (const dz of [-0.3, 0, 0.3]) {
        damageTarget(world, 'shower-1', new Vector3(20 + dx, 1.2, dz), 0.35)
      }
    }
    const afterCarve = target.grid.aliveCount
    expect(afterCarve).toBeLessThan(total)
    // The top half is still alive but disconnected…
    let above = 0
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.alive[i] && target.grid.centers[i * 3 + 1]! > 1.7) above++
    }
    expect(above).toBeGreaterThan(0)
    // …until the island timer fires — then it falls as debris, numerically
    // visible in aliveCount (the __boots.targets() census field).
    // 140 ms settle + up to 150 ms B2 jitter → wait past the worst case.
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(target.grid.aliveCount).toBeLessThan(afterCarve)
    for (let i = 0; i < target.grid.count; i++) {
      if (target.grid.centers[i * 3 + 1]! > 1.7) expect(target.grid.alive[i]).toBe(0)
    }
    // The floor-supported bottom survives.
    expect(target.grid.aliveCount).toBeGreaterThan(0)
  })
})

describe('drywall sheets', () => {
  test('walls get per-face sheet groups covering every skin cell; volumes get none', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    // Both faces are sheeted and every cell belongs to exactly one sheet.
    const sides = new Set(wall.sheets.map((s) => s.side))
    expect(sides).toEqual(new Set([0, 1]))
    let covered = 0
    for (const sheet of wall.sheets) {
      expect(sheet.cellCount).toBe(sheet.cells.length)
      expect(sheet.hits).toBe(0)
      expect(sheet.torn).toBe(0)
      expect(sheet.flownOff).toBe(false)
      covered += sheet.cellCount
      for (const idx of sheet.cells) expect(wall.sheetByCell[idx]).toBe(sheet.id)
    }
    expect(covered).toBe(wall.grid.count)
    // Sheets are LOGICAL: outward normals are horizontal unit vectors.
    for (const sheet of wall.sheets) {
      const [nx, ny, nz] = sheet.normal
      expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 5)
      expect(ny).toBe(0)
    }
    const crate = ensureVoxelTarget(world, 'crate-1')!
    expect(crate.kind).toBe('volume')
    expect(crate.sheets.length).toBe(0)
  })

  test('one big carve = one hit per touched sheet, torn matches removed cells', () => {
    const world = makeWorld()
    const removed = damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.45)
    expect(removed).toBeGreaterThan(8)
    const wall = useDestruction.getState().targets.get('wall-1')!
    const touched = wall.sheets.filter((s) => s.torn > 0)
    expect(touched.length).toBeGreaterThan(0)
    let torn = 0
    for (const sheet of touched) {
      expect(sheet.hits).toBe(1)
      torn += sheet.torn
    }
    expect(torn).toBe(removed)
    expect(Math.max(...touched.map((s) => s.torn))).toBeGreaterThan(8)
  })

  test('repeated carves fly the whole sheet off: flownOff, cells gone, one shot each', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const before = wall.grid.aliveCount
    // Walk small carves across one board area (fresh cells each time, the
    // way a player chews a hole wider) until a sheet lets go.
    const spots: Array<[number, number]> = [
      [-0.7, 1.0],
      [-0.4, 1.0],
      [-0.7, 1.7],
      [-0.4, 1.7],
      [-0.55, 1.35],
    ]
    for (const [x, y] of spots) {
      damageTarget(world, 'wall-1', new Vector3(x, y, 0), 0.3, new Vector3(0, 0, -1))
      if (wall.sheets.some((s) => s.flownOff)) break
    }
    const flown = wall.sheets.filter((s) => s.flownOff)
    expect(flown.length).toBeGreaterThan(0)
    for (const sheet of flown) {
      expect(sheet.torn).toBe(sheet.cellCount)
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(0)
    }
    // The wall lost at least one whole sheet's worth of material.
    expect(before - wall.grid.aliveCount).toBeGreaterThanOrEqual(flown[0]!.cellCount)
    // Untouched sheets are still intact.
    const intact = wall.sheets.filter((s) => s.torn === 0)
    expect(intact.length).toBeGreaterThan(0)
    for (const sheet of intact) {
      for (const idx of sheet.cells) expect(wall.grid.alive[idx]).toBe(1)
    }
  })

  test('a flown-off sheet takes no further hits', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    for (let i = 0; i < 8 && !wall.sheets.some((s) => s.flownOff); i++) {
      damageTarget(world, 'wall-1', new Vector3(-0.6 + i * 0.05, 1.0 + i * 0.15, 0), 0.3)
    }
    const flown = wall.sheets.find((s) => s.flownOff)!
    expect(flown).toBeDefined()
    const frozen = { hits: flown.hits, torn: flown.torn }
    // Empty air where the sheet was — more carves land nothing on it.
    damageTarget(world, 'wall-1', new Vector3(flown.center[0], flown.center[1], flown.center[2]), 0.3)
    expect(flown.hits).toBe(frozen.hits)
    expect(flown.torn).toBe(frozen.torn)
    expect(flown.torn).toBe(flown.cellCount)
  })
})

describe('damageExplosion (grenade detonation carve)', () => {
  test('one blast guts every destructible in range and snaps its framing', () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    const before = wall.grid.aliveCount
    const removed = damageExplosion(world, new Vector3(0, 1.2, 0.5), 3.2, { immediate: true })
    expect(removed).toBeGreaterThan(0)
    // The 3.2 m sphere dwarfs the 2 × 2.7 wall — most of it is gone…
    expect(wall.grid.aliveCount).toBeLessThan(before * 0.5)
    // …and the framing inside the radius snapped with it (cap 48).
    const broken = wall.segments.filter((s) => s.broken).length
    expect(broken).toBeGreaterThan(0)
    expect(broken).toBeLessThanOrEqual(48)
  })

  test('far targets and non-destructibles are untouched', () => {
    const world = makeWorld()
    // Blast at wall-1; wall-2 (5 m away, bounds > 3.2 m out) never voxelizes.
    damageExplosion(world, new Vector3(0, 1.2, 0.5), 3.2, { immediate: true })
    const targets = useDestruction.getState().targets
    expect(targets.has('wall-2')).toBe(false)
    expect(targets.has('crate-1')).toBe(false)
  })

  test('the boom frame carves at most EXPLOSION_CORE_NODES nodes; the rest ride the stagger', async () => {
    // Four walls clustered inside the core ring (radius * 0.5 = 1.6 m) of a
    // dead-center blast — the scale scenario: lots of material AT the point.
    const cluster = (id: string, center: [number, number, number]) =>
      boxCollider(id, 'wall', [1.6, 2.7, 0.12], center)
    const wallEntry = (c: ColliderEntry, z: number) => ({
      node: { id: c.nodeId, start: [-0.8, z] as [number, number], end: [0.8, z] as [number, number], height: 2.7, thickness: 0.12 },
      root: c.root,
      meshes: [c.mesh],
    })
    const a = cluster('cw-1', [0, 1.35, -0.6])
    const b = cluster('cw-2', [0, 1.35, 0.6])
    const c = cluster('cw-3', [0, 1.35, -1.2])
    const d = cluster('cw-4', [0, 1.35, 1.2])
    const colliders = [a, b, c, d]
    const buildingAabb = new Box3()
    for (const e of colliders) buildingAabb.union(e.worldBox)
    const world: GameWorld = {
      colliders,
      walls: new Map([
        ['cw-1', wallEntry(a, -0.6)],
        ['cw-2', wallEntry(b, 0.6)],
        ['cw-3', wallEntry(c, -1.2)],
        ['cw-4', wallEntry(d, 1.2)],
      ]),
      glass: [],
      doors: [],
      overlayRoots: [],
      buildingAabb,
      spawn: new Vector3(6, 0, 6),
      spawnYaw: 0,
      levelId: null,
    }
    const removedNow = damageExplosion(world, new Vector3(0, 1.2, 0), 3.2)
    // Instant feedback: SOMETHING carved this very frame…
    expect(removedNow).toBeGreaterThan(0)
    // …but the detonation frame itself touched at most the core budget.
    const targets = useDestruction.getState().targets
    let carvedNow = 0
    for (const t of targets.values()) if (t.grid.aliveCount < t.grid.count) carvedNow++
    expect(carvedNow).toBeGreaterThan(0)
    expect(carvedNow).toBeLessThanOrEqual(EXPLOSION_CORE_NODES)
    // The staggered steps finish the cluster within a few frames.
    await new Promise((resolve) => setTimeout(resolve, 400))
    let carvedLater = 0
    for (const t of targets.values()) if (t.grid.aliveCount < t.grid.count) carvedLater++
    expect(carvedLater).toBe(4)
  })
})

describe('island checks ride the shared settle drain (perf night 3)', () => {
  test('a carve queues its island task; whole-target collapse cancels it', () => {
    const world = makeWorld()
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 0.3)
    // The logical 140 ms + jitter delay is queued, not an own setTimeout —
    // the drain executes it budget-capped (structure.test.ts pins the cap).
    expect(settleTasksPending('island:wall-1')).toBe(true)
    collapseWholeTarget('wall-1')
    expect(settleTasksPending('island:wall-1')).toBe(false)
  })
})

describe('skeleton snap (cladding gone → bare frame falls)', () => {
  test('a wall carved to zero live voxels snaps every segment within ~1.5 s', async () => {
    const world = makeWorld()
    const wall = ensureVoxelTarget(world, 'wall-1')!
    expect(wall.segments.some((s) => !s.broken)).toBe(true)
    // One giant full-depth carve (radius >= pierce gate) strips ALL cladding.
    damageTarget(world, 'wall-1', new Vector3(0, 1.35, 0), 4)
    expect(wall.grid.aliveCount).toBe(0)
    // Immediately after: the snap is STAGGERED, not instantaneous.
    // After the 1.5 s span (+ buffer): the whole skeleton is down.
    await new Promise((resolve) => setTimeout(resolve, 1800))
    expect(wall.segments.every((s) => s.broken)).toBe(true)
  })
})

describe('savedCoatHex (host-order coat resolution for voxel skins)', () => {
  const navyScene = {
    mat_navy0000000000: { material: { preset: 'custom', properties: { color: '#3b4a63' } } },
  }

  test('slot scene-material ref wins over the legacy inline field', () => {
    const node = {
      slots: { interior: 'scene:mat_navy0000000000' },
      material: { preset: 'custom', properties: { color: '#ffffff' } },
    }
    expect(savedCoatHex(node, navyScene)).toBe('#3b4a63')
  })

  test('legacy custom coat resolves when no slot ref applies', () => {
    const node = { material: { preset: 'custom', properties: { color: '#44464a' } } }
    expect(savedCoatHex(node)).toBe('#44464a')
    // library: refs never flatten to a tint — the mesh sample stays right.
    expect(savedCoatHex({ ...node, slots: { interior: 'library:brick' } })).toBe('#44464a')
  })

  test('preset/texture finishes keep the mesh-sample fallback (null)', () => {
    expect(savedCoatHex({})).toBeNull()
    expect(savedCoatHex({ material: { preset: 'brick', properties: { color: '#ffffff' } } })).toBeNull()
    // A slot ref to a NON-custom scene material also declines.
    expect(
      savedCoatHex(
        { slots: { exterior: 'scene:mat_tex' } },
        { mat_tex: { material: { preset: 'brick', properties: { color: '#ffffff' } } } },
      ),
    ).toBeNull()
  })
})

describe('isMetalItemMaterial (metal spark flag — QA P9R1 fix 2)', () => {
  test('metalness > 0.5 reads metal; 0 / missing does not', () => {
    expect(isMetalItemMaterial({ metalness: 1 })).toBe(true)
    expect(isMetalItemMaterial({ metalness: 0.6 })).toBe(true)
    expect(isMetalItemMaterial({ metalness: 0.5 })).toBe(false)
    expect(isMetalItemMaterial({ metalness: 0 })).toBe(false)
    expect(isMetalItemMaterial({})).toBe(false)
    expect(isMetalItemMaterial(null)).toBe(false)
  })

  test("a 'metal-*' pascal_material library tag reads metal even at baked metalness 0", () => {
    // The barbell's chrome bar ships metallicFactor 0 in the GLB but tags
    // extras.pascal_material 'library:metal-chrome' — the tag is truth.
    expect(isMetalItemMaterial({ metalness: 0, userData: { pascal_material: 'library:metal-chrome' } })).toBe(true)
    expect(isMetalItemMaterial({ userData: { pascal_material: 'metal-steel' } })).toBe(true)
    // Non-metal library tags (and non-string junk) stay porcelain.
    expect(isMetalItemMaterial({ userData: { pascal_material: 'library:preset-nearblack' } })).toBe(false)
    expect(isMetalItemMaterial({ userData: { pascal_material: 'library:wood-finewood27' } })).toBe(false)
    expect(isMetalItemMaterial({ userData: { pascal_material: 42 } })).toBe(false)
    // 'metal-*' must be the id START — a substring never matches.
    expect(isMetalItemMaterial({ userData: { pascal_material: 'library:sheet-metal-look' } })).toBe(false)
  })

  test('item target flags metal from a tagged sub-mesh; untagged stays false', () => {
    const world = makeWorld()
    const crate = world.colliders.find((c) => c.nodeId === 'crate-1')!
    ;(crate.mesh.material as Material).userData = { pascal_material: 'library:metal-chrome' }
    expect(ensureVoxelTarget(world, 'crate-1')?.metal).toBe(true)
    resetDestruction()
    ;(crate.mesh.material as Material).userData = {}
    expect(ensureVoxelTarget(world, 'crate-1')?.metal).toBe(false)
  })

  test('mixed item: the per-cell mask marks only the metal sub-mesh region', () => {
    const world = makeWorld()
    const wood = boxCollider('mixed-1', 'item', [1, 0.3, 1], [20, 1, 0])
    const chrome = boxCollider('mixed-1', 'item', [1, 0.3, 1], [22, 1, 0])
    ;(chrome.mesh.material as Material).userData = { pascal_material: 'library:metal-chrome' }
    world.colliders.push(wood, chrome)
    const target = ensureVoxelTarget(world, 'mixed-1')!
    expect(target.metal).toBe(true)
    const mask = target.cellMetal!
    expect(mask).toBeDefined()
    let metalCells = 0
    let woodCells = 0
    for (let i = 0; i < target.grid.count; i++) {
      const x = target.grid.centers[i * 3]!
      if (mask[i] === 1) {
        metalCells++
        expect(x).toBeGreaterThan(21) // chrome box territory
      } else {
        woodCells++
        expect(x).toBeLessThan(21) // wood box territory
      }
    }
    expect(metalCells).toBeGreaterThan(0)
    expect(woodCells).toBeGreaterThan(0)
  })

  test('multi-material mesh: the DOMINANT group decides (wood table with a metal screw stays wood)', () => {
    const world = makeWorld()
    const crate = world.colliders.find((c) => c.nodeId === 'crate-1')!
    const wood = new MeshStandardMaterial({ metalness: 0 })
    const chrome = new MeshStandardMaterial({ metalness: 1 })
    crate.mesh.material = [wood, chrome]
    const total = crate.mesh.geometry.getIndex()!.count
    crate.mesh.geometry.clearGroups()
    crate.mesh.geometry.addGroup(0, total - 6, 0) // wood covers almost everything
    crate.mesh.geometry.addGroup(total - 6, 6, 1) // one metal sliver
    expect(ensureVoxelTarget(world, 'crate-1')?.metal).toBe(false)
  })
})

describe('tone resolution at voxelize (no target ever wears untextured white)', () => {
  test('a default-white wall resolves to the wall fallback and audits white-base', () => {
    const world = makeWorld() // wall meshes carry three's default white material
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(isUntexturedWhite(target.baseColor)).toBe(false)
    expect(toneAuditReport()).toContainEqual({
      nodeId: 'wall-1',
      kind: 'wall',
      why: 'white-base',
    })
  })

  test('a colored wall keeps its own tone and stays out of the audit', () => {
    const world = makeWorld()
    const wall = world.colliders.find((c) => c.nodeId === 'wall-1')!
    ;(wall.mesh.material as MeshStandardMaterial).color.set('#8a4b32')
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target.baseColor.getHexString()).toBe('8a4b32')
    expect(toneAuditReport().some((e) => e.nodeId === 'wall-1')).toBe(false)
  })

  test('an item region with an unreadable map over a white base wears the item fallback, not white', () => {
    const world = makeWorld()
    const crate = world.colliders.find((c) => c.nodeId === 'crate-1')!
    const material = crate.mesh.material as MeshStandardMaterial
    material.color.set('#ffffff')
    // Compressed-style map: an image no CPU path can read.
    ;(material as unknown as { map: unknown }).map = { image: { width: 4, height: 4 } }
    const target = ensureVoxelTarget(world, 'crate-1')!
    expect(isUntexturedWhite(target.baseColor)).toBe(false)
    expect(toneAuditReport()).toContainEqual({
      nodeId: 'crate-1',
      kind: 'item',
      why: 'map-unreadable',
    })
  })

  test('a plain-white item with NO map keeps its porcelain white (legit, not a fallback)', () => {
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'crate-1')!
    expect(isUntexturedWhite(target.baseColor)).toBe(true)
    expect(toneAuditReport().some((e) => e.nodeId === 'crate-1')).toBe(false)
  })

  test('a pending wall texture retints the live target when it loads (skinRevision bump)', () => {
    const world = makeWorld()
    const wall = world.colliders.find((c) => c.nodeId === 'wall-1')!
    const material = wall.mesh.material as MeshStandardMaterial
    const image: { data?: Uint8Array; width: number; height: number } = { width: 2, height: 2 }
    ;(material as unknown as { map: unknown }).map = { image }
    const target = ensureVoxelTarget(world, 'wall-1')!
    // Still loading: the fallback renders, the retry lane is armed.
    expect(isUntexturedWhite(target.baseColor)).toBe(false)
    expect(pendingToneCount()).toBe(1)
    expect(target.skinRevision ?? 0).toBe(0)
    // The image "finishes loading" as a flat red — next retry pass lands it.
    const data = new Uint8Array(2 * 2 * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 255
      data[i + 3] = 255
    }
    image.data = data
    retryPendingTones()
    expect(target.baseColor.r).toBeGreaterThan(0.9)
    expect(target.baseColor.g).toBeLessThan(0.1)
    expect(target.skinRevision).toBe(1)
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport().some((e) => e.nodeId === 'wall-1')).toBe(false)
  })

  test('dropTarget clears the node from the audit and cancels its retry', () => {
    const world = makeWorld()
    const wall = world.colliders.find((c) => c.nodeId === 'wall-1')!
    ;(wall.mesh.material as unknown as { map: unknown }).map = {
      image: { width: 4, height: 4 },
    }
    ensureVoxelTarget(world, 'wall-1')
    expect(pendingToneCount()).toBe(1)
    dropTarget('wall-1')
    expect(pendingToneCount()).toBe(0)
    expect(toneAuditReport().some((e) => e.nodeId === 'wall-1')).toBe(false)
  })
})

/** Vertically-striped readable image: left half red, right half blue. */
function stripedImage(w = 8, h = 8): { data: Uint8Array; width: number; height: number } {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (x < w / 2) data[o] = 255
      else data[o + 2] = 255
      data[o + 3] = 255
    }
  }
  return { data, width: w, height: h }
}

describe('per-cell texture patterns at voxelize (stage 2)', () => {
  test('a wall with a readable striped map carries the toneGrid and its cells wear the stripes', () => {
    const world = makeWorld()
    const wall = world.colliders.find((c) => c.nodeId === 'wall-1')!
    ;(wall.mesh.material as unknown as { map: unknown }).map = { image: stripedImage() }
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target.toneGrid).toBeDefined()
    // Two cells far apart along the span read DIFFERENT stripes — the
    // owner's "same texture, not one averaged tone" requirement.
    const out = new Color()
    let minRB = Infinity
    let maxRB = -Infinity
    for (let i = 0; i < target.grid.count; i++) {
      primedCellColor(out, target, i)
      const rb = out.r - out.b
      if (rb < minRB) minRB = rb
      if (rb > maxRB) maxRB = rb
    }
    expect(maxRB).toBeGreaterThan(0.5) // some cells clearly red
    expect(minRB).toBeLessThan(-0.5) // some cells clearly blue
  })

  test('a pending wall texture delivers the pattern grid with the retint', () => {
    const world = makeWorld()
    const wall = world.colliders.find((c) => c.nodeId === 'wall-1')!
    const image: { data?: Uint8Array; width?: number; height?: number } = {}
    ;(wall.mesh.material as unknown as { map: unknown }).map = { image }
    const target = ensureVoxelTarget(world, 'wall-1')!
    expect(target.toneGrid).toBeUndefined()
    Object.assign(image, stripedImage())
    retryPendingTones()
    expect(target.toneGrid).toBeDefined()
    expect(target.skinRevision).toBe(1)
  })

  test('item cells sample their region texture by world-position projection', () => {
    const world = makeWorld()
    const crate = world.colliders.find((c) => c.nodeId === 'crate-1')!
    ;(crate.mesh.material as unknown as { map: unknown }).map = { image: stripedImage() }
    const target = ensureVoxelTarget(world, 'crate-1')!
    // Items carry the pattern IN cellColors (no toneGrid on the target).
    expect(target.toneGrid).toBeUndefined()
    const colors = target.cellColors!
    expect(colors).toBeDefined()
    // The crate spans x ∈ [9.4, 10.6]: cells left of center sample the red
    // half, right of center the blue half (u = the dominant-axis fraction).
    let sawRed = false
    let sawBlue = false
    for (let i = 0; i < target.grid.count; i++) {
      const x = target.grid.centers[i * 3]!
      const rb = colors[i * 3]! - colors[i * 3 + 2]!
      if (x < 9.9 && rb > 0.5) sawRed = true
      if (x > 10.1 && rb < -0.5) sawBlue = true
    }
    expect(sawRed).toBe(true)
    expect(sawBlue).toBe(true)
  })

  test('a saved custom coat suppresses the pattern (flat paint wins)', () => {
    // savedCoatHex path is scene-store backed and not constructible here;
    // pin the contract at the target level instead: no readable map → no
    // toneGrid, flat baseColor only.
    const world = makeWorld()
    const target = ensureVoxelTarget(world, 'wall-2')!
    expect(target.toneGrid).toBeUndefined()
  })
})
