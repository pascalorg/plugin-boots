import { afterEach, describe, expect, test } from 'bun:test'
import { BoxGeometry, BufferAttribute, BufferGeometry } from 'three'
import { MeshBVH } from 'three-mesh-bvh'
import { resetBvhWorkerForTests, workerBvhBuilder } from './bvh-worker'
import { BVH_WORKER_BOOTED } from './bvh-worker-protocol'

/**
 * THE TWO THINGS ABOUT THE BVH WORKER THAT NOTHING ELSE CAN CATCH.
 *
 * The worker itself is not testable here — bun test has no `document`, which is
 * the gate that keeps `workerBvhBuilder()` from spawning real workers under the
 * runner (world-bvh.test.ts pins that). What IS testable is the pair of
 * properties that production depends on and that no dev run, no type check and
 * no reviewer reading the diff would notice going wrong:
 *
 *  1. The worker entry has NO STATIC IMPORTS. Static imports are evaluated
 *     before the entry's first statement, so any one of them that reaches three
 *     puts three's `window.__THREE__` epilogue in front of the shim — and in a
 *     production bundle, where the optimizer folded three's own `typeof window`
 *     guard away, that kills the worker at module evaluation. It is invisible in
 *     dev, where the fold does not happen. See bvh-worker-entry.ts.
 *
 *  2. A worker that never comes up is given up on PROMPTLY. The bug in 1 shipped
 *     for two days as a 30 s stall rather than a loud failure, because a
 *     module-eval throw does not fire the parent's `Worker.onerror` and the only
 *     symptom was a task reply that never came.
 */

// ── 1. The entry's load order ──────────────────────────────────────────────

/** The entry source with comments removed — every mention of `import` in this
 * file's prose is about the rule, and matching those would defeat the check. */
async function entrySourceWithoutComments(): Promise<string> {
  const source = await Bun.file(`${import.meta.dir}/bvh-worker-entry.ts`).text()
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

describe('the BVH worker entry shims `window` before three can look for it', () => {
  test('has no static imports at all — they would evaluate three first', async () => {
    const code = await entrySourceWithoutComments()
    // `import x from`, `import {…} from`, `import 'side-effect'` — but not
    // `await import(…)`, which is a call and runs in statement order.
    const staticImports = code.match(/^[ \t]*import\b(?!\s*\()/gm) ?? []
    expect(staticImports).toEqual([])
  })

  test('assigns `window` before the first dynamic import', async () => {
    const code = await entrySourceWithoutComments()
    const shimAt = code.indexOf('window')
    const firstImportAt = code.indexOf('import(')
    expect(shimAt).toBeGreaterThanOrEqual(0)
    expect(firstImportAt).toBeGreaterThanOrEqual(0)
    expect(shimAt).toBeLessThan(firstImportAt)
  })

  test('the upstream worker body it defers to is still where it was', () => {
    // A moved or renamed file in three-mesh-bvh would not fail the type check
    // (the import is untyped by necessity) — it would fail at runtime, in
    // production, as a silent fall back to main-thread builds.
    expect(Bun.resolveSync('three-mesh-bvh/src/workers/generateMeshBVH.worker.js', import.meta.dir)).toContain(
      'generateMeshBVH.worker.js',
    )
  })
})

// ── 2. Giving up on a dead worker ──────────────────────────────────────────

type Listener = (event: { data: unknown }) => void

/** A worker that loads nothing and says nothing — the exact shape of a worker
 * whose module graph died on evaluation: alive, silent, never errors. */
class SilentWorker {
  static instances = 0
  terminated = false
  onmessage: Listener | null = null
  constructor() {
    SilentWorker.instances++
  }
  addEventListener(_type: string, _listener: Listener): void {}
  removeEventListener(_type: string, _listener: Listener): void {}
  postMessage(_data?: unknown, _transfer?: unknown): void {}
  terminate(): void {
    this.terminated = true
  }
}

/** …and one that boots, to prove the handshake is a handshake and not a wait. */
class BootingWorker extends SilentWorker {
  private listeners: Listener[] = []
  override addEventListener(type: string, listener: Listener): void {
    if (type === 'message') {
      this.listeners.push(listener)
      // Next tick, like a real script finishing evaluation.
      queueMicrotask(() => {
        for (const l of this.listeners) l({ data: BVH_WORKER_BOOTED })
      })
    }
  }
  override removeEventListener(_type: string, listener: Listener): void {
    this.listeners = this.listeners.filter((l) => l !== listener)
  }
}

/**
 * A worker that actually ANSWERS: three-mesh-bvh's task protocol, performed on
 * the main thread. Nothing else here exercises the borrowed `runTask` end to end
 * — the transfer shape it posts, the serialize/deserialize pair, the restore of
 * the arrays a real transfer would neuter — and that borrow is this module's one
 * coupling to a package it does not control.
 *
 * The reply is deferred a tick, which is what makes overlap observable: a driver
 * that serializes logs post/reply/post/reply, one that does not logs
 * post/post/reply/reply.
 */
class ProtocolWorker extends BootingWorker {
  static log: string[] = []
  override postMessage(data?: unknown): void {
    const { index, position } = data as { index: Uint32Array | null; position: Float32Array }
    ProtocolWorker.log.push('posted')
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new BufferAttribute(position, 3, false))
    if (index) geometry.setIndex(new BufferAttribute(index, 1, false))
    // Upstream passes `copyIndexBuffer: false` here to avoid a copy it is about
    // to transfer anyway; nothing is transferred on this thread, and the option
    // is not in the package's types, so the default stands.
    const serialized = MeshBVH.serialize(new MeshBVH(geometry))
    queueMicrotask(() => {
      ProtocolWorker.log.push('replied')
      this.onmessage?.({ data: { error: null, serialized, position, progress: 1 } })
    })
  }
}

type Patchable = { Worker?: unknown; document?: unknown }

/** Put a fake Worker and a nominal `document` in scope so `workerBvhBuilder`
 * gets past its environment gate, and take them back out afterwards. */
function withFakeWorkerEnv(WorkerImpl: unknown, bootTimeoutMs: number): () => void {
  const target = globalThis as Patchable
  const hadWorker = 'Worker' in target
  const hadDocument = 'document' in target
  const prevWorker = target.Worker
  const prevDocument = target.document
  target.Worker = WorkerImpl
  target.document = {}
  resetBvhWorkerForTests(bootTimeoutMs)
  return () => {
    if (hadWorker) target.Worker = prevWorker
    else delete target.Worker
    if (hadDocument) target.document = prevDocument
    else delete target.document
    // Back to the shipped budget, and no fake left in the singleton.
    resetBvhWorkerForTests(10_000)
  }
}

let restore: (() => void) | null = null
afterEach(() => {
  restore?.()
  restore = null
})

describe('a worker that never reports ready is abandoned, not waited on', () => {
  test('the first build rejects on the boot budget, and the worker latches broken', async () => {
    restore = withFakeWorkerEnv(SilentWorker, 30)
    SilentWorker.instances = 0

    const build = workerBvhBuilder()
    // Not null: the environment gate passed AND three-mesh-bvh's runTask was
    // found — a missing runTask would have broken the worker right here.
    expect(build).not.toBeNull()
    expect(SilentWorker.instances).toBe(1)

    // 30 ms, not the shipped 10 s: the point is that it gives up on the boot
    // handshake rather than on a 30 s task timeout.
    const started = Bun.nanoseconds()
    await expect(build!({} as never)).rejects.toThrow(/never reported ready/)
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(WELL_UNDER_THE_TASK_TIMEOUT_MS)

    // And the whole builder is off for the rest of the page's life: world.ts's
    // queue stops, colliders keep the lazy synchronous path.
    expect(workerBvhBuilder()).toBeNull()
    expect(SilentWorker.instances).toBe(1)
  })

  test('two overlapping builds both land, one after the other', async () => {
    restore = withFakeWorkerEnv(ProtocolWorker, 30)
    ProtocolWorker.log = []
    const build = workerBvhBuilder()
    expect(build).not.toBeNull()

    // React mounts the game twice in development, so two prime queues overlap
    // and the second asks for a build while the first is still in flight —
    // `activeBvhPrime.cancel()` cannot recall a build already posted. That used
    // to throw `Already running job.`, which this module read as a broken worker
    // and latched off for the rest of the page's life: measured 100 ms into the
    // first mount, every dev session.
    const [first, second] = await Promise.all([build!(new BoxGeometry(1, 1, 1)), build!(new BoxGeometry(2, 1, 1))])
    expect(first).toBeInstanceOf(MeshBVH)
    expect(second).toBeInstanceOf(MeshBVH)
    // Serialized, not interleaved — the worker takes one task at a time.
    expect(ProtocolWorker.log).toEqual(['posted', 'replied', 'posted', 'replied'])
  })

  test('a worker that does report ready gets its task posted', async () => {
    restore = withFakeWorkerEnv(BootingWorker, 30)

    const build = workerBvhBuilder()
    expect(build).not.toBeNull()
    // The fake has no BVH protocol behind the handshake, so the borrowed
    // runTask throws on the geometry it is handed. That it throws THERE — and
    // not with "never reported ready" — is the assertion: boot was observed and
    // the task went out.
    await expect(build!({} as never)).rejects.not.toThrow(/never reported ready/)
  })
})

/** The old failure mode's timing, as the thing this must beat. Kept as a named
 * constant so the assertion reads as "faster than the bug", not "fast". */
const WELL_UNDER_THE_TASK_TIMEOUT_MS = 5_000
