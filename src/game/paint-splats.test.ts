import { afterEach, describe, expect, test } from 'bun:test'
import { Object3D } from 'three'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import { useDestruction, type VoxelTarget } from './destruction'
import {
  bakedChunkOrders,
  bakedPaintCensus,
  bakeNodeSplats,
  drainPaintTints,
  flushPendingSplatZeros,
  pendingSplatZeroCensus,
  paintNeedsCellClipping,
  getPaintedByNode,
  releaseNodeSplats,
  resetPaint,
  resetPaintSplats,
  shouldStampSplat,
  SPLAT_COALESCE_FRAC,
  SPLAT_FACE_BIAS,
  SPLAT_SPRITE_CAP,
  SPLAT_SPRITE_JITTER_MAX,
  SPLAT_SPRITE_JITTER_MIN,
  SPLAT_SPRITE_LIFT,
  splatNormalFor,
  splatSpriteCensus,
  splatSpriteSize,
  splatSpriteSlots,
  stampSplat,
} from './paint'
import { rotateByBasis, yawBasis } from './voxel'

/**
 * Phase 10 splat-sprite pins: the round paint read over the square cell
 * tint. All pure/pool math — sizing jitter, the coalescing economy, the
 * face-normal derivation (yawed walls included), ring cap/eviction, and
 * the drop/collapse eviction wired through drainPaintTints.
 */

afterEach(() => {
  resetPaintSplats()
  resetPaint()
  useDestruction.getState().reset()
  useBoots.getState().resolvePlaced()
})

// A unit +Z face normal for stamps that don't care about orientation.
const stamp = (nodeId: string, x: number, color = 2, radius = 0.25) =>
  stampSplat(nodeId, x, 0, 0, 0, 0, 1, radius, color)

describe('F-edited wall paint clipping', () => {
  const piece = (id: number, mask: number, kind: PlacedPiece['piece'] = 'wall') =>
    [{ id, piece: kind, mask }] as Pick<PlacedPiece, 'id' | 'piece' | 'mask'>[]

  test('suppresses an unclipped round quad on a built wall with a missing cell', () => {
    expect(paintNeedsCellClipping('__boots-piece-7', piece(7, FULL_MASK & ~(1 << 4)))).toBe(true)
  })

  test('keeps round splats on intact walls and unrelated surfaces', () => {
    expect(paintNeedsCellClipping('__boots-piece-7', piece(7, FULL_MASK))).toBe(false)
    expect(paintNeedsCellClipping('__boots-piece-7', piece(7, 1, 'floor'))).toBe(false)
    expect(paintNeedsCellClipping('wall-host', piece(7, 1))).toBe(false)
    expect(paintNeedsCellClipping('__boots-piece-7-extra', piece(7, 1))).toBe(false)
  })
})

describe('splatSpriteSize (scale jitter bounds)', () => {
  test('band pinned around the true 2 × radius diameter', () => {
    expect(splatSpriteSize(0.25, 0)).toBeCloseTo(0.5 * SPLAT_SPRITE_JITTER_MIN, 12)
    expect(splatSpriteSize(0.25, 1)).toBeCloseTo(0.5 * SPLAT_SPRITE_JITTER_MAX, 12)
    // Mid-draw is the exact diameter — the jitter is centered.
    expect(splatSpriteSize(0.25, 0.5)).toBeCloseTo(0.5, 12)
    expect(splatSpriteSize(1.4, 0.5)).toBeCloseTo(2.8, 12)
  })

  test('every draw stays inside the band, monotonic in rand', () => {
    let prev = 0
    for (let i = 0; i <= 10; i++) {
      const size = splatSpriteSize(0.3, i / 10)
      expect(size).toBeGreaterThanOrEqual(0.6 * SPLAT_SPRITE_JITTER_MIN - 1e-12)
      expect(size).toBeLessThanOrEqual(0.6 * SPLAT_SPRITE_JITTER_MAX + 1e-12)
      expect(size).toBeGreaterThanOrEqual(prev)
      prev = size
    }
  })
})

describe('shouldStampSplat (held-trigger coalescing)', () => {
  const prev = { x: 0, y: 0, z: 0, color: 2 }

  test('no previous sprite always stamps', () => {
    expect(shouldStampSplat(undefined, 0, 0, 0, 2, 0.25)).toBe(true)
  })

  test('same color inside SPLAT_COALESCE_FRAC × radius coalesces', () => {
    expect(SPLAT_COALESCE_FRAC).toBe(0.3)
    // min distance at r = 0.25 is 0.075.
    expect(shouldStampSplat(prev, 0.05, 0, 0, 2, 0.25)).toBe(false)
    expect(shouldStampSplat(prev, 0.08, 0, 0, 2, 0.25)).toBe(true)
    // The radius scales the rule: the same 0.08 offset coalesces far out.
    expect(shouldStampSplat(prev, 0.08, 0, 0, 2, 1.4)).toBe(false)
  })

  test('a color change always stamps, even at zero distance', () => {
    expect(shouldStampSplat(prev, 0, 0, 0, 4, 0.25)).toBe(true)
  })

  test('distance is true 3D, not per-axis', () => {
    // √(3 · 0.04²) ≈ 0.069 < 0.075 in, √(3 · 0.05²) ≈ 0.087 out.
    expect(shouldStampSplat(prev, 0.04, 0.04, 0.04, 2, 0.25)).toBe(false)
    expect(shouldStampSplat(prev, 0.05, 0.05, 0.05, 2, 0.25)).toBe(true)
  })
})

describe('splatNormalFor (the quad lies flat on the hit face)', () => {
  /** A 2.1 × 2.7 × 0.12 m wall grid — thickness axis z. */
  const wallGrid = (yaw = 0) => ({
    q: yawBasis(yaw),
    nx: 14,
    ny: 18,
    nz: 3,
    cellX: 0.15,
    cellY: 0.15,
    cellZ: 0.04,
  })
  const out = { x: 0, y: 0, z: 0 }

  test('head-on spray takes the reversed aim: the facing wall face', () => {
    splatNormalFor(wallGrid(), 'wall', 0, 0, -1, out)
    expect(out.x).toBeCloseTo(0, 10)
    expect(out.y).toBeCloseTo(0, 10)
    expect(out.z).toBeCloseTo(1, 10)
    // From the other side, the other face.
    splatNormalFor(wallGrid(), 'wall', 0, 0, 1, out)
    expect(out.z).toBeCloseTo(-1, 10)
  })

  test('glancing pass on a wall still stamps on the FACE, not the run edge', () => {
    // −dir is x-dominant, but the thickness (z) component 0.436 clears the
    // face bias — the drywall face wins.
    splatNormalFor(wallGrid(), 'wall', 0.9, 0, -Math.sqrt(0.19), out)
    expect(out.x).toBeCloseTo(0, 10)
    expect(out.z).toBeCloseTo(1, 10)
    // A plain VOLUME with the same spray takes the raw dominant axis.
    splatNormalFor(wallGrid(), 'volume', 0.9, 0, -Math.sqrt(0.19), out)
    expect(out.x).toBeCloseTo(-1, 10)
    expect(out.z).toBeCloseTo(0, 10)
  })

  test('true edge-on spray (no thickness component) falls back to dominant axis', () => {
    splatNormalFor(wallGrid(), 'wall', -1, 0, 0, out)
    expect(out.x).toBeCloseTo(1, 10)
    expect(out.z).toBeCloseTo(0, 10)
    // The bias threshold itself is pinned — below it the fallback rules.
    expect(SPLAT_FACE_BIAS).toBe(0.2)
  })

  test('slab sprayed from above stamps flat on the top face', () => {
    const slab = { q: yawBasis(0), nx: 20, ny: 2, nz: 20, cellX: 0.15, cellY: 0.06, cellZ: 0.15 }
    const m = Math.hypot(0.3, 0.9, 0.3)
    splatNormalFor(slab, 'slab', 0.3 / m, -0.9 / m, 0.3 / m, out)
    expect(out.x).toBeCloseTo(0, 10)
    expect(out.y).toBeCloseTo(1, 10)
    expect(out.z).toBeCloseTo(0, 10)
  })

  test('yawed wall: the normal is face-aligned in the GRID frame, world-rotated', () => {
    const yaw = Math.PI / 4
    splatNormalFor(wallGrid(yaw), 'wall', 0, 0, -1, out)
    // Unit, faces back at the shooter, and carries the 45° yaw.
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 6)
    expect(out.x).toBeCloseTo(-Math.SQRT1_2, 6)
    expect(out.y).toBeCloseTo(0, 6)
    expect(out.z).toBeCloseTo(Math.SQRT1_2, 6)
    // Axis-aligned once rotated INTO the grid frame — flat on a voxel face.
    const local = { x: 0, y: 0, z: 0 }
    rotateByBasis(yawBasis(yaw), out.x, out.y, out.z, local)
    expect(Math.abs(local.z)).toBeCloseTo(1, 6)
  })
})

describe('stampSplat pool (ring cap, reuse, node eviction)', () => {
  test('a stamp claims a slot: lifted position, jittered size, palette color', () => {
    expect(stampSplat('wall_a', 1, 2, 3, 0, 0, 1, 0.25, 4, 0.5, 0)).toBe(true)
    expect(splatSpriteCensus()).toBe(1)
    expect(splatSpriteCensus('wall_a')).toBe(1)
    const slot = splatSpriteSlots().find((s) => s.alive)!
    expect(slot.nodeId).toBe('wall_a')
    expect(slot.x).toBeCloseTo(1, 10)
    expect(slot.y).toBeCloseTo(2, 10)
    // Lifted off the surface along the +Z normal, inside the 6–8 mm band.
    expect(slot.z).toBeCloseTo(3 + SPLAT_SPRITE_LIFT, 10)
    expect(SPLAT_SPRITE_LIFT).toBeGreaterThanOrEqual(0.006)
    expect(SPLAT_SPRITE_LIFT).toBeLessThanOrEqual(0.008)
    expect(slot.size).toBeCloseTo(0.5, 10) // mid-draw = exact 2 × radius
    expect(slot.color).toBe(4)
  })

  test('coalescing: a held trigger re-stamps only past the economy distance', () => {
    expect(stamp('wall_c', 0)).toBe(true)
    // 0.05 m < 0.3 × 0.25 — swallowed, no slot claimed.
    expect(stamp('wall_c', 0.05)).toBe(false)
    expect(splatSpriteCensus()).toBe(1)
    // A color change stamps regardless — and RETIRES the covered old coat
    // (0.05 m < 0.6 × 0.25, same facing — the blink fix).
    expect(stamp('wall_c', 0.05, 3)).toBe(true)
    expect(splatSpriteCensus('wall_c')).toBe(1)
    // The SAME color past the economy distance stamps again (no retire).
    expect(stamp('wall_c', 0.13, 3)).toBe(true)
    expect(splatSpriteCensus('wall_c')).toBe(2)
  })

  test('BLINK FIX: a new coat retires covered different-color sprites', () => {
    // Blue (2) pass: three stamps along x.
    expect(stamp('wall_b2', 0)).toBe(true)
    expect(stamp('wall_b2', 0.1)).toBe(true)
    expect(stamp('wall_b2', 0.2)).toBe(true)
    expect(splatSpriteCensus('wall_b2')).toBe(3)
    // Red (3) over the middle: cover reach 0.6 × 0.25 = 0.15 from x = 0.1
    // retires ALL three blues (0, 0.1, 0.2 are within 0.15 ± lift) — the
    // circle can never z-flicker between two coats.
    expect(stamp('wall_b2', 0.1, 3)).toBe(true)
    expect(splatSpriteCensus('wall_b2')).toBe(1)
    const live = splatSpriteSlots().filter((s) => s.alive && s.nodeId === 'wall_b2')
    expect(live.length).toBe(1)
    expect(live[0]!.color).toBe(3)
  })

  test('BLINK FIX: the other face of the wall keeps its coat', () => {
    // Blue on the +Z face…
    expect(stampSplat('wall_f', 0, 0, 0, 0, 0, 1, 0.25, 2)).toBe(true)
    // …red on the −Z face at the same (x, y): normals oppose, no retire.
    expect(stampSplat('wall_f', 0, 0, -0.12, 0, 0, -1, 0.25, 3)).toBe(true)
    expect(splatSpriteCensus('wall_f')).toBe(2)
  })

  test('BLINK FIX: a distant different color is NOT retired', () => {
    expect(stamp('wall_d2', 0)).toBe(true)
    // 0.5 m away at radius 0.25 — far outside the 0.15 cover reach.
    expect(stamp('wall_d2', 0.5, 3)).toBe(true)
    expect(splatSpriteCensus('wall_d2')).toBe(2)
  })

  test('the pool stays at SPLAT_SPRITE_CAP; overflow is BAKED, never dropped', () => {
    expect(SPLAT_SPRITE_CAP).toBe(192)
    const stamps = SPLAT_SPRITE_CAP + 5
    for (let i = 0; i < stamps; i++) {
      expect(stamp('wall_r', i * 1.0)).toBe(true)
    }
    // Live instances stay bounded by the pool…
    expect(splatSpriteCensus()).toBeLessThanOrEqual(SPLAT_SPRITE_CAP)
    // …and every quad the player sprayed is still drawn (live or baked).
    expect(splatSpriteCensus('wall_r') + bakedPaintCensus('wall_r', 'sprite')).toBe(stamps)
  })

  test('the wrap PROMOTES the other node instead of erasing it', () => {
    expect(stamp('wall_old', 0)).toBe(true)
    for (let i = 0; i < SPLAT_SPRITE_CAP; i++) {
      expect(stamp('wall_new', i * 1.0)).toBe(true)
    }
    // The 193rd stamp needed wall_old's slot — so wall_old's quad was baked,
    // not deleted. It is still on the wall.
    expect(splatSpriteCensus('wall_old') + bakedPaintCensus('wall_old', 'sprite')).toBe(1)
    expect(splatSpriteCensus('wall_new') + bakedPaintCensus('wall_new', 'sprite')).toBe(SPLAT_SPRITE_CAP)
    expect(splatSpriteCensus()).toBeLessThanOrEqual(SPLAT_SPRITE_CAP)
  })

  test('a baked slot\'s zero-write is DEFERRED one frame (no one-frame hole)', () => {
    // The chunk mesh that takes a quad over only reaches the scene on the uSES
    // commit AFTER this frame's render. Zeroing the instance immediately would
    // leave one frame with neither — so the zero waits for the frame-top flush.
    for (let i = 0; i < 4; i++) expect(stamp('wall_pz', i * 1.0)).toBe(true)
    expect(bakeNodeSplats('wall_pz')).toBe(4)
    expect(pendingSplatZeroCensus()).toBe(4) // still drawn this frame
    expect(bakedPaintCensus('wall_pz', 'sprite')).toBe(4)
    flushPendingSplatZeros()
    expect(pendingSplatZeroCensus()).toBe(0)
    // Draining twice is a cheap no-op.
    flushPendingSplatZeros()
    expect(pendingSplatZeroCensus()).toBe(0)
  })

  test('releaseNodeSplats frees the node\'s BAKED quads too (dropped target)', () => {
    expect(stamp('wall_gone', 0)).toBe(true)
    expect(stamp('wall_stays', 5)).toBe(true)
    expect(bakeNodeSplats('wall_gone')).toBe(1)
    expect(bakedPaintCensus('wall_gone', 'sprite')).toBe(1)
    releaseNodeSplats('wall_gone')
    // Its surface no longer exists — live AND baked go.
    expect(splatSpriteCensus('wall_gone')).toBe(0)
    expect(bakedPaintCensus('wall_gone', 'sprite')).toBe(0)
    expect(splatSpriteCensus('wall_stays')).toBe(1)
  })

  test('baked sprite chunks draw UNDER the live pool, in bake order', () => {
    // The live pool's cover-scan retires an older different-colour quad; a
    // baked quad can't be retired, so it must never draw OVER newer paint.
    for (let i = 0; i < 3; i++) expect(stamp('wall_so', i * 1.0, 2)).toBe(true)
    expect(bakeNodeSplats('wall_so')).toBe(3)
    for (let i = 0; i < 3; i++) expect(stamp('wall_so', 10 + i, 3)).toBe(true)
    expect(bakeNodeSplats('wall_so')).toBe(3)
    const orders = bakedChunkOrders('wall_so', 'sprite')
    expect(orders.length).toBe(2)
    expect(orders[1]!).toBeGreaterThan(orders[0]!) // later bake draws later
    for (const order of orders) expect(order).toBeLessThan(0) // …but under live
  })

  test('resetPaintSplats clears the BAKED quads as well as the pool', () => {
    for (let i = 0; i < 3; i++) stamp('wall_rz', i * 1.0)
    expect(bakeNodeSplats('wall_rz')).toBe(3)
    resetPaintSplats()
    expect(splatSpriteCensus()).toBe(0)
    expect(bakedPaintCensus(undefined, 'sprite')).toBe(0)
    expect(pendingSplatZeroCensus()).toBe(0)
  })

  test('releaseNodeSplats frees exactly one node and its coalesce record', () => {
    expect(stamp('wall_x', 0)).toBe(true)
    expect(stamp('wall_y', 0)).toBe(true)
    releaseNodeSplats('wall_x')
    expect(splatSpriteCensus('wall_x')).toBe(0)
    expect(splatSpriteCensus('wall_y')).toBe(1)
    // The record went too: the SAME spot re-stamps on a rebuilt node.
    expect(stamp('wall_x', 0)).toBe(true)
    releaseNodeSplats('never_stamped') // cheap no-op
  })

  test('resetPaintSplats clears the pool (session teardown)', () => {
    stamp('wall_z', 0)
    stamp('wall_z', 1)
    resetPaintSplats()
    expect(splatSpriteCensus()).toBe(0)
    expect(splatSpriteCensus('wall_z')).toBe(0)
  })
})

/** Minimal live target for the drain: 5 cells along X, controllable life. */
const fakeTarget = (nodeId: string, aliveCount: number): VoxelTarget => {
  const count = 5
  const centers = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) centers[i * 3] = i * 0.15
  const alive = new Uint8Array(count).fill(aliveCount > 0 ? 1 : 0)
  return {
    nodeId,
    kind: 'wall',
    dormant: false,
    grid: { count, alive, centers, aliveCount },
  } as unknown as VoxelTarget
}

describe('sprite eviction on drop/collapse (drainPaintTints wiring)', () => {
  const scene = new Object3D()
  const ledger = () => getPaintedByNode() as Map<string, Map<number, number>>

  test('a DROPPED target (builder Z-undo) sheds its sprites on the next drain', () => {
    expect(stamp('gone', 0)).toBe(true)
    ledger().set('gone', new Map([[0, (2 << 8) | 200]]))
    // No target registered — the piece unmounted.
    drainPaintTints(scene)
    expect(splatSpriteCensus('gone')).toBe(0)
    // The ledger itself SURVIVES (Save still counts the coat).
    expect(ledger().get('gone')!.size).toBe(1)
  })

  test('a FULLY-collapsed grid sheds its sprites, keeps its ledger', () => {
    useDestruction.getState().targets.set('flat', fakeTarget('flat', 0))
    expect(stamp('flat', 0)).toBe(true)
    ledger().set('flat', new Map([[1, (3 << 8) | 255]]))
    drainPaintTints(scene)
    expect(splatSpriteCensus('flat')).toBe(0)
    expect(ledger().get('flat')!.size).toBe(1)
  })

  test('a LIVE target keeps its sprites through the drain', () => {
    useDestruction.getState().targets.set('alive', fakeTarget('alive', 5))
    expect(stamp('alive', 0)).toBe(true)
    ledger().set('alive', new Map([[2, (2 << 8) | 128]]))
    drainPaintTints(scene)
    expect(splatSpriteCensus('alive')).toBe(1)
  })

  test('an F-edited built wall sheds full-disc sprites but keeps its clipped cell coat', () => {
    const nodeId = '__boots-piece-7'
    useBoots.setState({
      placed: [{ id: 7, piece: 'wall', position: [0, 0, 0], yaw: 0, mask: FULL_MASK & ~(1 << 4) }],
    })
    useDestruction.getState().targets.set(nodeId, fakeTarget(nodeId, 5))
    expect(stamp(nodeId, 0)).toBe(true)
    ledger().set(nodeId, new Map([[2, (2 << 8) | 128]]))

    drainPaintTints(scene)

    expect(splatSpriteCensus(nodeId)).toBe(0)
    expect(ledger().get(nodeId)!.size).toBe(1)
  })
})
