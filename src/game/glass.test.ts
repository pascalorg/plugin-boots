import { afterEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, Mesh } from 'three'
import {
  GLASS_SHARD_COUNT_MAX,
  GLASS_SHARD_COUNT_MIN,
  GLASS_SHARD_FACE_MIN,
  GLASS_SHARD_FACE_SPAN,
  GLASS_SHARD_THICKNESS,
  glassShardCensus,
  glassShardCount,
  glassShardFace,
  resetGlass,
  shatterPane,
  useGlass,
} from './glass'
import type { GlassPane } from './world'

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
