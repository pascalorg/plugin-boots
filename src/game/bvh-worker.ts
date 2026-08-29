import type { BufferGeometry } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker'

/**
 * Off-main-thread BVH building (perf fix #3, 2026-08-29).
 *
 * Profiling a real 670-node scene showed every top main-thread spike tagged
 * `bvh-build` — 2136 / 1017 / 853 / 451 ms atomic stalls a few seconds into a
 * session, all synchronous `new MeshBVH(...)` constructions inside world.ts's
 * lazy `bvhFor`. A build is atomic: once started it cannot be time-sliced, so
 * budgeted drains (warmup.tsx) still eat a whole build's cost in one frame.
 * The only real cure is to not build on the main thread at all.
 *
 * three-mesh-bvh 0.9.x ships GenerateMeshBVHWorker: position + index buffers
 * transfer to a Worker, the packed BVH buffers transfer back, and the main
 * thread only pays a cheap deserialize. world.ts feeds it BVH-ONLY geometry
 * copies (sanitizeGeometryForBvh), so the transfer never neuters a live host
 * mesh's arrays.
 *
 * Worker loading is BUNDLER-DEPENDENT (`new Worker(new URL(...))` inside
 * node_modules): the host is a Next.js app where that pattern is supported,
 * but this module must never make the game WORSE where it isn't — every
 * failure mode (no Worker global, headless test run, constructor throw,
 * worker-script 404, hung task) degrades to `null` / a rejected build, and
 * world.ts's queue then simply stops: colliders keep their original
 * lazy-synchronous build path, which is exactly today's behavior.
 */

/** Builds a MeshBVH for a BVH-only geometry copy, asynchronously. */
export type BvhAsyncBuilder = (geometry: BufferGeometry) => Promise<MeshBVH>

/** One background build request: the CACHE-KEY geometry (the host mesh's own
 * geometry — world.ts sanitizes a copy at build time) plus a priority
 * (ascending: lower builds first; world.ts uses distance-to-spawn so the
 * colliders the player reaches first come off the queue first). */
export type BvhPrimeTask = {
  geometry: BufferGeometry
  priority: number
}

export type BvhPrimeHandle = {
  /** Stop scheduling further builds. An in-flight worker build still lands
   * in the cache when it completes — a finished BVH is valid regardless. */
  cancel: () => void
  /** Resolves when the queue drained, failed, or was cancelled. Never
   * rejects. Exposed for tests and diagnostics only. */
  done: Promise<void>
}

/**
 * Sequential, cancellable, lowest-priority-first build queue. Strictly one
 * build in flight (GenerateMeshBVHWorker is single-task). Already-built
 * geometries are skipped both BEFORE the build (isBuilt) and at landing
 * (a synchronous on-demand build may have won the race mid-flight — the
 * sync result stays, the worker result is discarded). The FIRST builder
 * failure stops the whole queue: a broken worker rejects every subsequent
 * call, and re-trying per task would just serialize error noise. Pure over
 * its dependencies — the worker-free tests inject a fake builder.
 */
export function runBvhPrimeQueue(
  tasks: readonly BvhPrimeTask[],
  deps: {
    build: BvhAsyncBuilder
    isBuilt: (geometry: BufferGeometry) => boolean
    onBuilt: (geometry: BufferGeometry, bvh: MeshBVH) => void
  },
): BvhPrimeHandle {
  let cancelled = false
  const ordered = [...tasks].sort((a, b) => a.priority - b.priority)
  const done = (async () => {
    for (const task of ordered) {
      if (cancelled) return
      if (deps.isBuilt(task.geometry)) continue
      let bvh: MeshBVH
      try {
        bvh = await deps.build(task.geometry)
      } catch {
        // Builder broken (worker failed / timed out). Remaining colliders
        // keep the lazy synchronous path — correctness never depended on
        // this queue.
        return
      }
      // Land the finished build even if cancelled meanwhile — it's a valid
      // BVH for a geometry that may well be probed next session. The sync
      // path wins any race (isBuilt guard).
      if (!deps.isBuilt(task.geometry)) deps.onBuilt(task.geometry, bvh)
    }
  })()
  return {
    cancel: () => {
      cancelled = true
    },
    done,
  }
}

/** A single worker build slower than this is assumed hung (a silently
 * unresolvable worker script can leave the generate promise pending
 * forever) — the worker is disposed and background priming stops. The
 * worst measured MAIN-thread build was ~3.2 s; a worker build of the same
 * mesh is in the same ballpark, so 30 s only ever trips on pathology. */
const WORKER_TASK_TIMEOUT_MS = 30_000

let workerBroken = false
let workerInstance: GenerateMeshBVHWorker | null = null

function breakWorker(reason: unknown): void {
  if (workerBroken) return
  workerBroken = true
  console.warn('[boots] BVH worker unavailable — builds stay on the main thread', reason)
  try {
    workerInstance?.dispose()
  } catch {
    // Termination of an already-dead worker is not worth a second warning.
  }
  workerInstance = null
}

/** Test-only: forget the singleton so a fresh environment can be probed. */
export function resetBvhWorkerForTests(): void {
  workerBroken = false
  workerInstance = null
}

/**
 * The shared background builder, or null where workers can't work: no
 * Worker global, no document (SSR / bun test — spawning real workers under
 * the test runner risks hangs), a broken worker from earlier in the page's
 * life, or a constructor throw (bundlers that don't emit the worker chunk
 * fail here or via the first task's onerror → rejection → queue stop).
 */
export function workerBvhBuilder(): BvhAsyncBuilder | null {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return null
  if (workerBroken) return null
  if (!workerInstance) {
    try {
      workerInstance = new GenerateMeshBVHWorker()
    } catch (error) {
      breakWorker(error)
      return null
    }
  }
  return generateInWorker
}

async function generateInWorker(geometry: BufferGeometry): Promise<MeshBVH> {
  const worker = workerInstance
  if (!worker || workerBroken) throw new Error('[boots] BVH worker is not available')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<MeshBVH>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('[boots] BVH worker build timed out')),
        WORKER_TASK_TIMEOUT_MS,
      )
      // generate() throws synchronously when already running / disposed —
      // the promise executor turns that into a rejection too.
      worker.generate(geometry).then(resolve, reject)
    })
  } catch (error) {
    breakWorker(error)
    throw error
  } finally {
    clearTimeout(timer)
  }
}
