import type { BufferGeometry } from 'three'
import type { MeshBVH } from 'three-mesh-bvh'
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker'
import { BVH_WORKER_BOOTED } from './bvh-worker-protocol'

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
 * worker-script 404, worker that never boots, hung task) degrades to `null` /
 * a rejected build, and world.ts's queue then simply stops: colliders keep
 * their original lazy-synchronous build path, which is exactly today's
 * behavior.
 *
 * The worker script is OURS (bvh-worker-entry.ts), not three-mesh-bvh's, for
 * one reason: three's module evaluation touches `window` unguarded once the
 * production optimizer folds its `typeof window` check away, so loading
 * three-mesh-bvh's entry directly kills the worker in production — and did,
 * from the day this landed until 2026-08-31. Read that file for the whole
 * story. The PROTOCOL is still three-mesh-bvh's, borrowed rather than
 * reimplemented, so there is only one place either end can drift.
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

/**
 * A worker that has not said it booted within this long is presumed dead.
 *
 * It has to fetch and parse the whole three chunk before it can answer, so this
 * cannot be tight; but it is the only symptom a broken worker has, since a throw
 * during module evaluation does not fire the parent's `Worker.onerror`. Before
 * the boot handshake existed, the same failure surfaced as a task that never
 * replied — WORKER_TASK_TIMEOUT_MS, i.e. the queue idle for the first 30 s of a
 * session, which is precisely the stretch background priming exists to cover.
 */
let workerBootTimeoutMs = 10_000

/**
 * three-mesh-bvh's `WorkerBase.runTask` — the extension point its own subclasses
 * implement, and the only part of `GenerateMeshBVHWorker` this file wants: the
 * buffer transfer, the serialize/deserialize pair and the neutered-array
 * restore, all of which are protocol details best left to the package that
 * defines them. It is absent from the package's `.d.ts` (which declares only
 * `generate`/`dispose`/`running`), so the shape is spelled out here.
 *
 * `runTask` reads nothing off `this` in 0.9.x, but it is called as a method
 * anyway so a future version that reaches for `this.name` still works.
 */
type RunTask = (
  this: unknown,
  worker: Worker,
  geometry: BufferGeometry,
  options?: Record<string, unknown>,
) => Promise<MeshBVH>

const borrowedRunTask = (GenerateMeshBVHWorker.prototype as unknown as { runTask?: RunTask }).runTask

/**
 * The BVH worker: three-mesh-bvh's protocol driving a worker script of ours.
 *
 * Same surface as `GenerateMeshBVHWorker` (`generate`, `dispose`, one job at a
 * time) so the rest of this module did not have to change shape, plus the boot
 * handshake that class has no way to offer — it cannot know whether its worker
 * ever came up.
 */
class ShimmedBvhWorker {
  private worker: Worker | null
  private running = false
  /** Resolves when the worker installed its message handler; rejects when it
   * did not, which is how a worker killed at module evaluation is detected. */
  private readonly booted: Promise<void>

  constructor() {
    // `new URL(..., import.meta.url)` is the pattern bundlers recognise to emit
    // a worker chunk. The host app is Next/Turbopack, which supports it for a
    // TS entry; anywhere it is not supported the constructor throws or the
    // script 404s, and either way we fall back to main-thread builds.
    const worker = new Worker(new URL('./bvh-worker-entry.ts', import.meta.url), { type: 'module' })
    this.worker = worker
    this.booted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('[boots] BVH worker never reported ready')),
        workerBootTimeoutMs,
      )
      const settle = (outcome: () => void) => {
        clearTimeout(timer)
        worker.removeEventListener('message', onMessage)
        outcome()
      }
      const onMessage = (event: MessageEvent) => {
        // Task replies are objects; only the boot ping is this string. Anything
        // else on the wire before boot is not ours to interpret.
        if (event.data === BVH_WORKER_BOOTED) settle(resolve)
      }
      worker.addEventListener('message', onMessage)
      // Fires for a script that fails to FETCH or PARSE. A script that parses
      // and then throws does not fire it, hence the timeout above. Kept because
      // when it does fire it is both instant and specific.
      worker.addEventListener('error', (event) =>
        settle(() => reject(new Error(`[boots] BVH worker failed to start: ${event.message || 'unknown error'}`))),
      )
    })
    // Nobody awaits `booted` until the first build, and a rejection sitting
    // unobserved until then is reported as unhandled. The real handling is in
    // `generate`, which awaits it and lets `generateInWorker` break the worker.
    this.booted.catch(() => {})
  }

  async generate(geometry: BufferGeometry): Promise<MeshBVH> {
    if (this.running) throw new Error('[boots] BVH worker: already running a job')
    if (!borrowedRunTask) throw new Error('[boots] BVH worker: three-mesh-bvh has no runTask to borrow')
    const worker = this.worker
    if (!worker) throw new Error('[boots] BVH worker has been disposed')
    // Claim the slot before the await: two concurrent callers must not both get
    // past the guard while the first one is still waiting for boot.
    this.running = true
    try {
      await this.booted
      return await borrowedRunTask.call(this, worker, geometry, {})
    } finally {
      this.running = false
    }
  }

  dispose(): void {
    this.worker?.terminate()
    this.worker = null
  }
}

let workerBroken = false
let workerInstance: ShimmedBvhWorker | null = null

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

/**
 * Test-only: forget the singleton so a fresh environment can be probed, and
 * optionally shorten the boot budget — a test for "the worker never came up"
 * should not take ten real seconds to make its point.
 */
export function resetBvhWorkerForTests(bootTimeoutMs?: number): void {
  workerBroken = false
  workerInstance = null
  if (bootTimeoutMs !== undefined) workerBootTimeoutMs = bootTimeoutMs
}

/**
 * The shared background builder, or null where workers can't work: no
 * Worker global, no document (SSR / bun test — spawning real workers under
 * the test runner risks hangs), a broken worker from earlier in the page's
 * life, a three-mesh-bvh with no `runTask` to borrow, or a constructor throw
 * (bundlers that don't emit the worker chunk fail here, or the worker never
 * boots → rejection → queue stop).
 */
export function workerBvhBuilder(): BvhAsyncBuilder | null {
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return null
  if (workerBroken) return null
  if (!borrowedRunTask) {
    // An upstream refactor moved the protocol. Better to keep building on the
    // main thread than to spawn a worker nothing can drive.
    breakWorker(new Error('[boots] three-mesh-bvh: GenerateMeshBVHWorker has no runTask'))
    return null
  }
  if (!workerInstance) {
    try {
      workerInstance = new ShimmedBvhWorker()
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
