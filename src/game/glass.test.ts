import { afterEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, Mesh, Vector3 } from 'three'
import {
  GLASS_SHARD_COUNT_MAX,
  GLASS_SHARD_COUNT_MIN,
  GLASS_SHARD_FACE_MIN,
  GLASS_SHARD_FACE_SPAN,
  GLASS_SHARD_THICKNESS,
  glassShardCensus,
  glassShardCount,
  glassShardFace,
  raycastGlass,
  resetGlass,
  shatterPane,
  useGlass,
} from './glass'
import { bvhPrimeStats, type GameWorld, type GlassPane } from './world'

/**
 * The shatterPane session guard: a grenade's deferred glass waves (40/80 ms
 * setTimeout in explodeAt) can fire AFTER Esc tore the session down — the
 * teardown runs resetGlass first, so a late shatter used to mark the
 * still-rendering pane in the FRESH store (an unbreakable window all next
 * session), spawn shards into the cleared pool, and play the voice in the
 * editor. No session (bun tests never open one) → complete no-op.
 */

afterEach(() => {
  resetGlass()
})

describe('shatterPane session guard', () => {
  test('without a live session the pane is untouched and the store stays clean', () => {
    const mesh = new Mesh(new BoxGeometry(1, 1.2, 0.02))
    const pane: GlassPane = { mesh, root: mesh, nodeId: 'window-1' }
    shatterPane(pane)
    expect(useGlass.getState().shattered.size).toBe(0)
    expect(useGlass.getState().version).toBe(0)
    expect(mesh.visible).toBe(true) // hideForGame never ran
    // …and the plate-shard pool stays empty too — no ghost shards raining
    // into the editor after Esc.
    expect(glassShardCensus().live).toBe(0)
  })
})

/**
 * THE PANE BROADPHASE.
 *
 * `bvhFor` BUILDS a MeshBVH on read, and panes are not colliders — the
 * background prime queue (world.ts) never covers them, so this lane is the only
 * thing that ever builds one. Before the cull, a single round fired anywhere in
 * the house asked every pane in it for a BVH, hit or miss, synchronously, inside
 * the trigger frame. The collider lane learned this in the 2026-08-27 perf round
 * (shooting.ts's worldBox cull); glass and the aim probe had not.
 *
 * `bvhPrimeStats([]).mainThreadBuilds` is world.ts's page-lifetime count of
 * cache-miss builds — passing no colliders makes it a pure build counter, which
 * is what turns "did that call build anything?" into an assertion. Deltas only,
 * never absolutes: the count spans the whole test file.
 */
describe('raycastGlass — the pane broadphase', () => {
  const builds = () => bvhPrimeStats([]).mainThreadBuilds

  /** A pane facing +z, `x` metres to the side and `z` metres away. */
  function paneAt(nodeId: string, x: number, z: number): GlassPane {
    const mesh = new Mesh(new BoxGeometry(1, 1.2, 0.02))
    mesh.position.set(x, 1.2, z)
    mesh.updateMatrixWorld(true)
    return { mesh, root: mesh, nodeId }
  }

  const glassWorld = (...panes: GlassPane[]) => ({ glass: panes }) as unknown as GameWorld
  const eyes = new Vector3(0, 1.2, 0)
  const forward = new Vector3(0, 0, -1)

  test('a pane off the ray is never built, and the aimed one still answers', () => {
    const aimed = paneAt('win-aimed', 0, -2)
    const aside = paneAt('win-aside', 9, -2)
    const world = glassWorld(aimed, aside)

    const before = builds()
    expect(raycastGlass(world, eyes, forward, 5)?.pane.nodeId).toBe('win-aimed')
    // One build, for the pane the round passes through. The one 9 m to the side
    // is culled by its AABB and never asked.
    expect(builds() - before).toBe(1)

    // Aimed the other way: both AABBs answer, nothing builds.
    const after = builds()
    expect(raycastGlass(world, eyes, new Vector3(0, 0, 1), 5)).toBeNull()
    expect(builds() - after).toBe(0)
  })

  test('a pane out of range is culled before it builds, not after', () => {
    const far = paneAt('win-far', 0, -4)
    const world = glassWorld(far)

    // The old order built the BVH, cast it, THEN threw the hit away on
    // distance — so a window across the room still cost a build per shot.
    const before = builds()
    expect(raycastGlass(world, eyes, forward, 1)).toBeNull()
    expect(builds() - before).toBe(0)

    // Same pane, honest range: it answers, and pays its one build.
    expect(raycastGlass(world, eyes, forward, 5)?.pane.nodeId).toBe('win-far')
    expect(builds() - before).toBe(1)
  })

  test('a pane that MOVED is re-boxed from its live matrix', () => {
    // An operation window swings its panes with the root. A cached box would
    // cull a pane the round really passes through — the reason the AABB is
    // derived per call instead of stored on GlassPane.
    const pane = paneAt('win-swung', 9, -2)
    const world = glassWorld(pane)
    expect(raycastGlass(world, eyes, forward, 5)).toBeNull()

    pane.mesh.position.x = 0
    pane.mesh.updateMatrixWorld(true)
    expect(raycastGlass(world, eyes, forward, 5)?.pane.nodeId).toBe('win-swung')
  })

  test('a shattered pane stays out of the lane entirely', () => {
    const pane = paneAt('win-gone', 0, -2)
    const world = glassWorld(pane)
    useGlass.setState({ shattered: new Set([pane.mesh]) })
    const before = builds()
    expect(raycastGlass(world, eyes, forward, 5)).toBeNull()
    expect(builds() - before).toBe(0)
  })
})

/**
 * Plate shards, not cubes (owner round 5): glass breaks into thin plates —
 * one sliver axis at real pane thickness, both face edges many times that.
 * Pure math only here; the visual lane is covered by headless QA via the
 * __boots.glassShards census.
 */
describe('glass plate shard math', () => {
  test('sliver thickness is real pane glass (6–10 mm), never a voxel', () => {
    expect(GLASS_SHARD_THICKNESS).toBeGreaterThanOrEqual(0.006)
    expect(GLASS_SHARD_THICKNESS).toBeLessThanOrEqual(0.01)
  })

  test('every face roll draws a PLATE: each edge ≥ 5× the sliver axis', () => {
    for (const [r1, r2] of [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [0.5, 0.5],
    ] as const) {
      const { w, h } = glassShardFace(r1, r2)
      expect(w).toBeGreaterThanOrEqual(GLASS_SHARD_FACE_MIN)
      expect(w).toBeLessThanOrEqual(GLASS_SHARD_FACE_MIN + GLASS_SHARD_FACE_SPAN)
      expect(h).toBeGreaterThanOrEqual(GLASS_SHARD_FACE_MIN)
      expect(h).toBeLessThanOrEqual(GLASS_SHARD_FACE_MIN + GLASS_SHARD_FACE_SPAN)
      expect(w).toBeGreaterThanOrEqual(GLASS_SHARD_THICKNESS * 5)
      expect(h).toBeGreaterThanOrEqual(GLASS_SHARD_THICKNESS * 5)
    }
  })

  test('shard count scales with pane area inside the clamp band', () => {
    // Tiny cabinet front → floor of the band; degenerate area too.
    expect(glassShardCount(0.1)).toBe(GLASS_SHARD_COUNT_MIN)
    expect(glassShardCount(0)).toBe(GLASS_SHARD_COUNT_MIN)
    expect(glassShardCount(Number.NaN)).toBe(GLASS_SHARD_COUNT_MIN)
    // A 1 × 1.4 m window pane sits mid-band and beats the floor.
    const window = glassShardCount(1.4)
    expect(window).toBeGreaterThan(GLASS_SHARD_COUNT_MIN)
    expect(window).toBeLessThanOrEqual(GLASS_SHARD_COUNT_MAX)
    // A storefront sheet caps out instead of flooding the pool.
    expect(glassShardCount(10)).toBe(GLASS_SHARD_COUNT_MAX)
    // Monotone: more pane never means fewer shards.
    expect(glassShardCount(2)).toBeGreaterThanOrEqual(window)
  })
})
