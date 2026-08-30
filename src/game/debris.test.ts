import { beforeEach, describe, expect, test } from 'bun:test'
import { Box3, Color, type BufferAttribute } from 'three'
import {
  clearDebris,
  debrisCensus,
  debrisDump,
  debrisSpawnHash,
  makeShardGeometry,
  SHAPE_CHUNK_A,
  SHAPE_CHUNK_B,
  SHAPE_PLATE,
  SHAPE_SPLINTER,
  SHARD_SCALE_VAR,
  SHARD_SHAPE_COUNT,
  SHARD_SPIN_MAX,
  SHARD_SPIN_MIN,
  spawnDebris,
  spawnFlatDebris,
} from './debris'

/**
 * Pins for the debris-feel rework (2026-08-29, owner: "pieces of stuff
 * falling with gravity, not meaningless rotation of cubes"): shard-shape
 * assignment is hash-deterministic with real variety, tumble is slow and
 * biased about one axis (the old ±4.5 rad/s pinwheel is a regression),
 * launch is outward-dominant rather than a fountain, scale varies ±30%,
 * and the ring/flat pool caps hold.
 */

const TINT = new Color('#6b4f33')

beforeEach(() => {
  clearDebris() // also resets the spawn ordinal — sequences reproduce
})

describe('shard shape assignment', () => {
  test('identical spawn sequences shed identical shapes', () => {
    const spawnBurst = () => {
      for (let i = 0; i < 24; i++) {
        spawnDebris(1 + i * 0.37, 2 + (i % 5) * 0.11, -3 + i * 0.05, 0.08, TINT, 2)
      }
      return debrisDump().map((piece) => piece.shape)
    }
    const first = spawnBurst()
    clearDebris()
    const second = spawnBurst()
    expect(first.length).toBe(24)
    expect(second).toEqual(first)
  })

  test('a burst at ONE point still gets shape variety (ordinal in the hash)', () => {
    for (let i = 0; i < 32; i++) spawnDebris(5, 1.5, 5, 0.06, TINT, 2)
    const shapes = new Set(debrisDump().map((piece) => piece.shape))
    expect(shapes.size).toBeGreaterThanOrEqual(3)
    for (const shape of shapes) {
      expect(shape).toBeGreaterThanOrEqual(0)
      expect(shape).toBeLessThan(SHARD_SHAPE_COUNT)
    }
  })

  test('debrisSpawnHash is pure and ordinal-sensitive', () => {
    expect(debrisSpawnHash(1.23, 4.56, -7.89, 42)).toBe(debrisSpawnHash(1.23, 4.56, -7.89, 42))
    expect(debrisSpawnHash(1.23, 4.56, -7.89, 42)).not.toBe(debrisSpawnHash(1.23, 4.56, -7.89, 43))
  })
})

describe('gravity-dominant motion', () => {
  test('chunk tumble is slow and capped (no ±4.5 rad/s pinwheel)', () => {
    for (let i = 0; i < 64; i++) spawnDebris(i * 0.3, 2, 0, 0.08, TINT, 2.5)
    const dump = debrisDump()
    expect(dump.length).toBe(64)
    for (const piece of dump) {
      // Dominant-axis rate rides [SPIN_MIN, SPIN_MAX]; wobble is smaller.
      expect(piece.spin).toBeLessThanOrEqual(SHARD_SPIN_MAX + 1e-6)
      expect(piece.spin).toBeGreaterThanOrEqual(SHARD_SPIN_MIN - 1e-6)
    }
  })

  test('radial launch barely lofts — pieces leave outward, not fountaining', () => {
    const speed = 2
    for (let i = 0; i < 200; i++) spawnDebris(0, 3, 0, 0.06, TINT, speed)
    const census = debrisCensus()
    expect(census.live).toBe(200)
    // vy band is [-0.08, 0.32]·speed → mean ≈ 0.12·speed. The old cube
    // fountain averaged ≈ 0.72·speed.
    expect(census.meanVy).toBeLessThan(0.3 * speed)
    expect(census.meanVy).toBeGreaterThan(-0.2 * speed)
  })

  test('directional launches still follow the face normal (ceiling pops DOWN)', () => {
    for (let i = 0; i < 50; i++) spawnDebris(0, 2.6, 0, 0.05, TINT, 2, 2.6, { x: 0, y: -1, z: 0 })
    expect(debrisCensus().meanVy).toBeLessThan(0)
  })

  test('scale variation stays inside ±30% of the requested size', () => {
    const size = 0.1
    for (let i = 0; i < 100; i++) spawnDebris(i * 0.21, 1, i * 0.13, size, TINT, 2)
    const scales = debrisDump().map((piece) => piece.scale)
    for (const scale of scales) {
      expect(scale).toBeGreaterThanOrEqual(size * (1 - SHARD_SCALE_VAR) - 1e-6)
      expect(scale).toBeLessThanOrEqual(size * (1 + SHARD_SCALE_VAR) + 1e-6)
    }
    expect(Math.max(...scales) - Math.min(...scales)).toBeGreaterThan(0.01)
  })
})

describe('pool caps', () => {
  test('the debris ring never exceeds its capacity', () => {
    for (let i = 0; i < 1000; i++) spawnDebris(i * 0.1, 2, 0, 0.05, TINT, 2)
    expect(debrisCensus().live).toBeLessThanOrEqual(768)
  })

  test('flat plates recycle at their 120 cap without flooding the ring', () => {
    for (let i = 0; i < 150; i++) spawnFlatDebris(i * 0.2, 2, 0, 0.2, 0.25, TINT)
    const census = debrisCensus()
    expect(census.flats).toBe(120)
    expect(census.live).toBe(120)
  })
})

describe('shard geometries', () => {
  test('builders are deterministic — two calls, identical vertices', () => {
    for (const shape of [SHAPE_PLATE, SHAPE_CHUNK_A, SHAPE_CHUNK_B, SHAPE_SPLINTER]) {
      const a = makeShardGeometry(shape).getAttribute('position') as BufferAttribute
      const b = makeShardGeometry(shape).getAttribute('position') as BufferAttribute
      expect(Array.from(a.array as Float32Array)).toEqual(Array.from(b.array as Float32Array))
    }
  })

  test('shapes read as plate / chunk / splinter (bounding-box ratios)', () => {
    const bounds = (shape: number) => {
      const geometry = makeShardGeometry(shape)
      geometry.computeBoundingBox()
      const box = geometry.boundingBox as Box3
      return [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z] as const
    }
    const plate = bounds(SHAPE_PLATE)
    expect(plate[0] / plate[2]).toBeGreaterThan(3) // flat: ~2:2:0.4
    const splinter = bounds(SHAPE_SPLINTER)
    expect(splinter[0] / splinter[1]).toBeGreaterThan(4) // long: ~3:0.6:0.6
    for (const shape of [SHAPE_CHUNK_A, SHAPE_CHUNK_B]) {
      const chunk = bounds(shape)
      for (const extent of chunk) {
        expect(extent).toBeGreaterThan(0.5) // chunky in every axis
        expect(extent).toBeLessThanOrEqual(1.0)
      }
    }
    // The two chunk variants are genuinely different shards.
    const a = makeShardGeometry(SHAPE_CHUNK_A).getAttribute('position') as BufferAttribute
    const b = makeShardGeometry(SHAPE_CHUNK_B).getAttribute('position') as BufferAttribute
    expect(Array.from(a.array as Float32Array)).not.toEqual(Array.from(b.array as Float32Array))
  })
})
