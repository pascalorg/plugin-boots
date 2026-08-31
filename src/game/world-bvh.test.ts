import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Float32BufferAttribute,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Matrix4,
  Mesh,
  Ray,
  Vector3,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { MeshBVH } from 'three-mesh-bvh'
import { workerBvhBuilder } from './bvh-worker'
import type { ColliderEntry } from './world'
import {
  bvhBuilt,
  bvhFor,
  bvhPrimeStats,
  primeColliderBvhs,
  probeSpawnSurfaceY,
  sanitizeGeometryForBvh,
} from './world'

/**
 * BVH hardening + deferred building (perf fix #3, 2026-08-29).
 *
 * 1. The merged-stair TypeError: the host stair system's empty placeholder
 *    geometry (viewer stair-system createEmptyGeometry — one degenerate
 *    3-zero-vertex triangle + TWO `addGroup(0, 0, …)` zero-count groups)
 *    made `new MeshBVH` crash in buildPackedTree: three-mesh-bvh derives one
 *    BVH root per group range, a group set intersecting nothing yields ZERO
 *    ranges, and `rootRanges[0].offset` reads `.offset` of undefined. Every
 *    such stair then degraded to the never-hit fallback (non-solid) and
 *    re-failed each session. sanitizeGeometryForBvh strips groups from a
 *    BVH-only copy, which also makes triangles OUTSIDE any group solid
 *    (they were silently absent from grouped builds before).
 *
 * 2. Deferred builds: bvhFor stays synchronous (correctness — spawn probes
 *    and capsule sweeps need a real BVH the frame they ask), while
 *    primeColliderBvhs fills the same cache in the background through an
 *    injectable async builder (the worker in production; fakes here).
 */

const _ray = new Ray()

function downwardHit(bvh: MeshBVH, x: number, z: number, fromY = 10) {
  _ray.origin.set(x, fromY, z)
  _ray.direction.set(0, -1, 0)
  return bvh.raycastFirst(_ray, 2)
}

/** The host stair system's empty placeholder, byte for byte: one degenerate
 * all-zeroes triangle plus two zero-count material groups (tread + side). */
function emptyStairPlaceholder(): BufferGeometry {
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(new Float32Array(9), 3))
  geometry.addGroup(0, 0, 0)
  geometry.addGroup(0, 0, 1)
  return geometry
}

/** A representative straight merged stair, built the way the host viewer
 * builds it: per-step box geometries translated into a run, merged with
 * mergeGeometries(…, false), then contiguous material groups assigned per
 * triangle by face normal (normal.y > 0.75 → tread, else side) — the exact
 * shape applyStraightStairMaterialGroups leaves on the merged geometry. */
function mergedStairGeometry(steps = 4, rise = 0.18, run = 0.28, width = 1): BufferGeometry {
  const parts: BufferGeometry[] = []
  for (let i = 0; i < steps; i++) {
    const top = (i + 1) * rise
    const box = new BoxGeometry(width, top, run)
    box.translate(0, top / 2, i * run + run / 2)
    parts.push(box)
  }
  const merged = mergeGeometries(parts, false)
  if (!merged) throw new Error('mergeGeometries returned null')
  for (const part of parts) part.dispose()

  // Material groups exactly like the host's applyStraightStairMaterialGroups.
  const position = merged.getAttribute('position')
  const index = merged.getIndex()
  const triangleCount = index ? index.count / 3 : position.count / 3
  const v0 = new Vector3()
  const v1 = new Vector3()
  const v2 = new Vector3()
  const normal = new Vector3()
  const materials: number[] = []
  for (let t = 0; t < triangleCount; t++) {
    const a = index ? index.getX(t * 3) : t * 3
    const b = index ? index.getX(t * 3 + 1) : t * 3 + 1
    const c = index ? index.getX(t * 3 + 2) : t * 3 + 2
    v0.fromBufferAttribute(position, a)
    v1.fromBufferAttribute(position, b)
    v2.fromBufferAttribute(position, c)
    normal.crossVectors(v1.sub(v0), v2.sub(v0))
    materials.push(normal.lengthSq() > 0 && normal.normalize().y > 0.75 ? 0 : 1)
  }
  merged.clearGroups()
  let currentMaterial = materials[0]!
  let groupStart = 0
  for (let t = 1; t < materials.length; t++) {
    if (materials[t] === currentMaterial) continue
    merged.addGroup(groupStart * 3, (t - groupStart) * 3, currentMaterial)
    groupStart = t
    currentMaterial = materials[t]!
  }
  merged.addGroup(groupStart * 3, (materials.length - groupStart) * 3, currentMaterial)
  return merged
}

/** Minimal collider entry over a geometry at identity, the way collectWorld
 * builds them (lazy `bvh` getter through bvhFor). */
function colliderFor(geometry: BufferGeometry, nodeType = 'wall'): ColliderEntry {
  const mesh = new Mesh(geometry)
  mesh.updateMatrixWorld(true)
  geometry.computeBoundingBox()
  const worldBox = (geometry.boundingBox ?? new Box3()).clone()
  return {
    mesh,
    get bvh() {
      return bvhFor(this.mesh)
    },
    inverse: new Matrix4(),
    worldBox,
    root: mesh,
    nodeId: `node_${nodeType}_${Math.random().toString(36).slice(2, 8)}`,
    nodeType,
  }
}

afterEach(() => {
  mock.restore()
})

describe('sanitizeGeometryForBvh — the BVH-only copy', () => {
  test('strips groups and shares no arrays with the source', () => {
    const source = mergedStairGeometry()
    expect(source.groups.length).toBeGreaterThan(0)
    const copy = sanitizeGeometryForBvh(source)
    expect(copy.groups.length).toBe(0)
    expect(copy.getAttribute('position').array).not.toBe(source.getAttribute('position').array)
    expect(copy.index).not.toBeNull()
    expect(copy.index!.array).toBeInstanceOf(Uint32Array)
    expect(copy.index!.array).not.toBe(source.index!.array)
    // Same triangles, same order.
    expect(copy.index!.count).toBe(source.index!.count)
    expect(Array.from(copy.index!.array as Uint32Array)).toEqual(
      Array.from(source.index!.array as ArrayLike<number>),
    )
  })

  test('de-interleaves interleaved positions into a plain attribute', () => {
    // One triangle on the y = 1 plane, xyz packed into a stride-5 buffer.
    const stride = 5
    const verts = [
      [0, 1, 0],
      [1, 1, 0],
      [0, 1, 1],
    ]
    const data = new Float32Array(verts.length * stride)
    verts.forEach((v, i) => data.set(v, i * stride))
    const source = new BufferGeometry()
    source.setAttribute(
      'position',
      new InterleavedBufferAttribute(new InterleavedBuffer(data, stride), 3, 0),
    )
    const copy = sanitizeGeometryForBvh(source)
    const position = copy.getAttribute('position')
    expect((position as { isInterleavedBufferAttribute?: boolean }).isInterleavedBufferAttribute)
      .toBeUndefined()
    expect(Array.from(position.array as Float32Array)).toEqual([0, 1, 0, 1, 1, 0, 0, 1, 1])
  })

  test('drops triangles whose index references a missing vertex', () => {
    const source = new BufferGeometry()
    source.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3),
    )
    // Second triangle points past the vertex count — a malformed merge.
    source.setIndex([0, 1, 2, 0, 1, 9])
    const copy = sanitizeGeometryForBvh(source)
    expect(Array.from(copy.index!.array as Uint32Array)).toEqual([0, 1, 2])
    // The surviving triangle still raycasts.
    const bvh = new MeshBVH(copy)
    expect(downwardHit(bvh, 0.2, 0.2)).not.toBeNull()
  })

  test('non-indexed input stays non-indexed', () => {
    const source = new BufferGeometry()
    source.setAttribute(
      'position',
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3),
    )
    expect(sanitizeGeometryForBvh(source).index).toBeNull()
  })
})

describe("bvhFor — merged-stair geometries (the buildPackedTree 'offset' TypeError)", () => {
  test('ROOT CAUSE: zero-count groups crash a raw MeshBVH reading rootRanges[0].offset', () => {
    // three-mesh-bvh derives one BVH root per group range; both groups have
    // count 0, so they intersect nothing, getRootPrimitiveRanges returns []
    // and buildPackedTree dereferences rootRanges[0].offset of undefined.
    let thrown: unknown
    try {
      new MeshBVH(emptyStairPlaceholder())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect(String((thrown as TypeError).message)).toContain('offset')
  })

  test('bvhFor builds the placeholder cleanly — no non-solid fallback, no re-fail', () => {
    const warn = spyOn(console, 'warn')
    const mesh = new Mesh(emptyStairPlaceholder())
    const bvh = bvhFor(mesh)
    expect(warn).not.toHaveBeenCalled()
    // Cached: the old path re-failed (and re-warned) every session.
    expect(bvhFor(mesh)).toBe(bvh)
    // The placeholder's one triangle is degenerate — correctly hits nothing.
    expect(downwardHit(bvh, 0, 0)).toBeNull()
  })

  test('a real merged stair is SOLID: every tread top raycasts at its height', () => {
    const warn = spyOn(console, 'warn')
    const steps = 4
    const rise = 0.18
    const run = 0.28
    const mesh = new Mesh(mergedStairGeometry(steps, rise, run))
    const bvh = bvhFor(mesh)
    expect(warn).not.toHaveBeenCalled()
    for (let i = 0; i < steps; i++) {
      const hit = downwardHit(bvh, 0, i * run + run / 2)
      expect(hit).not.toBeNull()
      expect(hit!.point.y).toBeCloseTo((i + 1) * rise, 5)
    }
  })

  test('the HOST geometry is untouched: groups kept, index order preserved', () => {
    const geometry = mergedStairGeometry()
    const groupsBefore = geometry.groups.map((g) => ({ ...g }))
    const indexBefore = Array.from(geometry.index!.array as ArrayLike<number>)
    bvhFor(new Mesh(geometry))
    // The old non-interleaved path handed MeshBVH the host geometry, which
    // reordered its index in place; the sanitized copy leaves it alone.
    expect(geometry.groups).toEqual(groupsBefore)
    expect(Array.from(geometry.index!.array as ArrayLike<number>)).toEqual(indexBefore)
  })

  test('triangles OUTSIDE any group are solid too (grouped builds skipped them)', () => {
    const geometry = new BufferGeometry()
    // Two floor triangles; the group covers only the first.
    geometry.setAttribute(
      'position',
      new Float32BufferAttribute(
        [0, 0, 0, 1, 0, 0, 0, 0, 1, /* tri 1 */ 2, 0, 0, 3, 0, 0, 2, 0, 1],
        3,
      ),
    )
    geometry.setIndex([0, 1, 2, 3, 4, 5])
    geometry.addGroup(0, 3, 0)
    // Raw grouped build: the uncovered triangle is invisible to the BVH.
    expect(downwardHit(new MeshBVH(geometry), 2.2, 0.2)).toBeNull()
    // bvhFor's stripped copy covers everything.
    expect(downwardHit(bvhFor(new Mesh(geometry)), 2.2, 0.2)).not.toBeNull()
  })

  test('interleaved GLB-style positions still build and hit (2026-08-25 regression)', () => {
    const stride = 7
    const verts = [
      [0, 2, 0],
      [1, 2, 0],
      [0, 2, 1],
    ]
    const data = new Float32Array(verts.length * stride)
    verts.forEach((v, i) => data.set(v, i * stride))
    const geometry = new BufferGeometry()
    geometry.setAttribute(
      'position',
      new InterleavedBufferAttribute(new InterleavedBuffer(data, stride), 3, 0),
    )
    const warn = spyOn(console, 'warn')
    const hit = downwardHit(bvhFor(new Mesh(geometry)), 0.2, 0.2)
    expect(warn).not.toHaveBeenCalled()
    expect(hit).not.toBeNull()
    expect(hit!.point.y).toBeCloseTo(2, 5)
  })
})

describe('primeColliderBvhs — deferred background builds', () => {
  const spawn = new Vector3(0, 0, 0)

  /** Fake async builder: real MeshBVH, recorded call order. */
  function recordingBuilder() {
    const built: BufferGeometry[] = []
    const build = mock(async (geometry: BufferGeometry) => {
      built.push(geometry)
      return new MeshBVH(geometry)
    })
    return { build, built }
  }

  function boxCollider(centerX: number): ColliderEntry {
    const geometry = new BoxGeometry(1, 1, 1)
    geometry.translate(centerX, 0.5, 0)
    return colliderFor(geometry)
  }

  test('builds nearest-to-spawn first and fills the bvhFor cache', async () => {
    const far = boxCollider(30)
    const near = boxCollider(3)
    const mid = boxCollider(12)
    const { build, built } = recordingBuilder()
    const handle = primeColliderBvhs([far, near, mid], spawn, build)
    expect(handle).not.toBeNull()
    await handle!.done
    expect(built.length).toBe(3)
    // Ascending worldBox distance from spawn — the builder saw the sanitized
    // copies in near → mid → far order (identified by their bounds).
    const centersX = built.map((g) => {
      g.computeBoundingBox()
      return (g.boundingBox!.min.x + g.boundingBox!.max.x) / 2
    })
    expect(centersX).toEqual([3, 12, 30])
    for (const collider of [near, mid, far]) {
      expect(bvhBuilt(collider.mesh)).toBe(true)
      // The getter is now a cache hit — same instance every read.
      expect(collider.bvh).toBe(collider.bvh)
    }
  })

  test('a synchronous bvhFor demand mid-flight wins the cache race', async () => {
    const collider = boxCollider(5)
    let release: ((bvh: MeshBVH) => void) | undefined
    const gate = new Promise<MeshBVH>((resolve) => {
      release = resolve
    })
    const build = mock((geometry: BufferGeometry) => {
      // Keep the worker "busy" until the test releases it.
      void geometry
      return gate
    })
    const handle = primeColliderBvhs([collider], spawn, build)
    // The first frame's capsule sweep can't wait — sync build.
    const syncBvh = collider.bvh
    expect(bvhBuilt(collider.mesh)).toBe(true)
    // The worker result lands late — and is discarded.
    release!(new MeshBVH(sanitizeGeometryForBvh(collider.mesh.geometry)))
    await handle!.done
    expect(collider.bvh).toBe(syncBvh)
  })

  test('already-built geometries are never re-enqueued', async () => {
    const builtAhead = boxCollider(2)
    const fresh = boxCollider(8)
    void builtAhead.bvh // sync-build (the spawn probe does this at mount)
    const { build, built } = recordingBuilder()
    const handle = primeColliderBvhs([builtAhead, fresh], spawn, build)
    await handle!.done
    expect(built.length).toBe(1)
    expect(bvhBuilt(fresh.mesh)).toBe(true)
  })

  test('duplicate geometries across colliders enqueue once', async () => {
    const geometry = new BoxGeometry(1, 1, 1)
    const a = colliderFor(geometry)
    const b = colliderFor(geometry)
    const { build, built } = recordingBuilder()
    const handle = primeColliderBvhs([a, b], spawn, build)
    await handle!.done
    expect(built.length).toBe(1)
    expect(bvhBuilt(a.mesh)).toBe(true)
    expect(bvhBuilt(b.mesh)).toBe(true)
  })

  test('a failing builder stops the queue; the rest stays lazy and sync-safe', async () => {
    const first = boxCollider(1)
    const second = boxCollider(9)
    const build = mock(async () => {
      throw new Error('worker exploded')
    })
    const handle = primeColliderBvhs([first, second], spawn, build)
    await handle!.done
    expect(build.mock.calls.length).toBe(1)
    expect(bvhBuilt(first.mesh)).toBe(false)
    expect(bvhBuilt(second.mesh)).toBe(false)
    // Correctness path unharmed: on-demand sync builds still work.
    expect(downwardHit(first.bvh, 1, 0)).not.toBeNull()
  })

  test("a new session's prime cancels the previous queue mid-flight", async () => {
    const oldNear = boxCollider(1)
    const oldFar = boxCollider(20)
    let release: ((bvh: MeshBVH) => void) | undefined
    const gate = new Promise<MeshBVH>((resolve) => {
      release = resolve
    })
    let sanitizedFirst: BufferGeometry | undefined
    const oldBuild = mock((geometry: BufferGeometry) => {
      sanitizedFirst = geometry
      return gate
    })
    const oldHandle = primeColliderBvhs([oldNear, oldFar], spawn, oldBuild)

    // Next session starts before the first build even lands.
    const next = boxCollider(4)
    const { build: newBuild } = recordingBuilder()
    const newHandle = primeColliderBvhs([next], spawn, newBuild)

    release!(new MeshBVH(sanitizedFirst!))
    await oldHandle!.done
    await newHandle!.done
    // The in-flight build still lands (a finished BVH is valid), but the
    // cancelled queue never starts oldFar's build.
    expect(oldBuild.mock.calls.length).toBe(1)
    expect(bvhBuilt(oldNear.mesh)).toBe(true)
    expect(bvhBuilt(oldFar.mesh)).toBe(false)
    expect(bvhBuilt(next.mesh)).toBe(true)
  })

  test('spawn settle stays sync-correct: probeSpawnSurfaceY builds on demand', () => {
    // Task-3 guard: at mount the settle raycasts colliders BEFORE any
    // background build lands — the lazy getter must force a real BVH.
    const slab = colliderFor(new BoxGeometry(4, 0.4, 4).translate(0, 0.2, 0), 'slab')
    expect(bvhBuilt(slab.mesh)).toBe(false)
    const surface = probeSpawnSurfaceY([slab], 0.5, 0.5)
    expect(surface).toBeCloseTo(0.4, 5)
    expect(bvhBuilt(slab.mesh)).toBe(true)
  })

  test('workerBvhBuilder is null here (headless) — collectWorld priming no-ops', () => {
    // bun test has no document; spawning real workers under the runner is
    // exactly what the environment gate exists to prevent.
    expect(workerBvhBuilder()).toBeNull()
    const collider = boxCollider(6)
    expect(primeColliderBvhs([collider], spawn)).toBeNull()
    expect(bvhBuilt(collider.mesh)).toBe(false)
  })

  /**
   * The reading that would have caught the two-day-dead production worker:
   * a stopped queue and a finished one differ in nothing a session can feel.
   */
  describe('bvhPrimeStats — telling a working queue from a stopped one', () => {
    /** Every reading in this describe comes from an INJECTED builder, which is
     * not the worker — so the worker fields stay at their untouched values, and
     * spelling that out is half the point: a full cache with `workerBuilds: 0`
     * is the shape of a session that built everything on the main thread. */
    const idle = (reading: { geometries: number; built: number; priming: boolean }) => ({
      ...reading,
      workerBuilds: 0,
      // Whatever earlier tests in this file built synchronously — the count is
      // page-lifetime by design, so the reading is about the SPLIT, not a total.
      mainThreadBuilds: expect.any(Number),
      workerBroken: false,
    })

    // `priming` is module state, and these tests deliberately leave a queue
    // mid-build. An empty prime is the honest reset — a session with nothing to
    // do cancels the previous queue and returns null — and it keeps the
    // assertions true under `--randomize` as well as in file order.
    beforeEach(() => {
      expect(primeColliderBvhs([], spawn, recordingBuilder().build)).toBeNull()
    })

    test('reports progress without ever building anything itself', async () => {
      const near = boxCollider(2)
      const far = boxCollider(25)

      // THE load-bearing property. `ColliderEntry.bvh` is a getter that BUILDS;
      // a diagnostic that read colliders through it would synchronously build
      // the whole world on the main thread — the exact stall the prime lane
      // exists to remove — and then report 100% primed, every time.
      const before = bvhPrimeStats([near, far])
      expect(before).toEqual(idle({ geometries: 2, built: 0, priming: false }))
      expect(bvhBuilt(near.mesh)).toBe(false)
      expect(bvhBuilt(far.mesh)).toBe(false)

      const { build } = recordingBuilder()
      const handle = primeColliderBvhs([near, far], spawn, build)
      // Synchronously after the call the queue is running and nothing landed.
      expect(bvhPrimeStats([near, far])).toEqual(idle({ geometries: 2, built: 0, priming: true }))

      await handle!.done
      // `done` resolving is not the flag clearing — that happens in a `then`
      // callback of its own, one microtask behind.
      await Promise.resolve()
      expect(bvhPrimeStats([near, far])).toEqual(idle({ geometries: 2, built: 2, priming: false }))
    })

    test('counts geometries, not colliders', async () => {
      // Every wall of one type shares a geometry; counting colliders would
      // report a number with no relation to the work the queue has to do.
      const shared = new BoxGeometry(1, 1, 1)
      const a = colliderFor(shared)
      const b = colliderFor(shared)
      const own = boxCollider(9)
      expect(bvhPrimeStats([a, b, own]).geometries).toBe(2)

      const { build } = recordingBuilder()
      await primeColliderBvhs([a, b, own], spawn, build)!.done
      await Promise.resolve()
      expect(bvhPrimeStats([a, b, own])).toEqual(idle({ geometries: 2, built: 2, priming: false }))
    })

    test('a builder that fails leaves the stopped-queue signature', async () => {
      // This is what a dead worker looks like from the outside, and the whole
      // reason the reading exists: not priming, and short of the total.
      const first = boxCollider(1)
      const second = boxCollider(11)
      const build = mock(async () => {
        throw new Error('worker exploded')
      })
      const handle = primeColliderBvhs([first, second], spawn, build)
      await handle!.done
      await Promise.resolve()
      const stats = bvhPrimeStats([first, second])
      expect(stats.priming).toBe(false)
      expect(stats.built).toBeLessThan(stats.geometries)
    })

    test("a superseded queue's completion does not clear the live queue's flag", async () => {
      // Esc → Jump in: the old session's queue finishes (its in-flight build
      // lands, then cancellation stops it) AFTER the new session's queue has
      // started. If the flag were set by whichever `done` fires last, the new
      // session would report "not priming" for the whole time it primes —
      // which reads exactly like the dead-worker signature above.
      const old = boxCollider(3)
      const { build: quick } = recordingBuilder()
      const oldHandle = primeColliderBvhs([old, boxCollider(30)], spawn, quick)

      const next = boxCollider(7)
      // Still building when the assertion runs, like a real worker mid-task.
      const nextHandle = primeColliderBvhs([next], spawn, mock(() => new Promise<MeshBVH>(() => {})))
      expect(nextHandle).not.toBeNull()

      await oldHandle!.done
      await Promise.resolve()
      expect(bvhPrimeStats([next]).priming).toBe(true)
      // The old queue did stop where cancellation caught it: the in-flight
      // build landed, the second one was never started. (`priming` is about the
      // live queue whatever colliders are passed — there is only ever one.)
      expect(bvhPrimeStats([old]).built).toBe(1)
      expect(quick.mock.calls.length).toBe(1)
    })
  })
})
