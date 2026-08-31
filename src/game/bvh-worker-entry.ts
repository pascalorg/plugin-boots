/**
 * THE BVH WORKER'S ENTRY — a `window` that exists before three goes looking.
 *
 * three r185 ends its module evaluation with
 *
 *   if ( typeof window !== 'undefined' ) {
 *     if ( window.__THREE__ ) warn( 'Multiple instances…' )
 *     else window.__THREE__ = REVISION
 *   }
 *
 * The guard is right there in three's source. It is NOT in the production
 * bundle: the optimizer folds `typeof window !== 'undefined'` to true, because
 * for a browser target it is — on the main thread. The same chunk is also what
 * a Worker loads, and a Worker has no `window`, so what runs in the worker is
 * `window.__THREE__ ? … : window.__THREE__ = "185"`, unguarded, and it throws
 * `ReferenceError: window is not defined` during module evaluation. The whole
 * worker module graph dies with it. Dev builds skip that fold, which is why
 * this only ever happened in production.
 *
 * Measured (localhost prod build, 2026-08-31): worker created at 8.0 s, throws
 * on the spot, the first task's reply never comes, and bvh-worker.ts's timeout
 * gives up 30 s later — so off-main-thread BVH building has never once worked
 * in production, and the main-thread build stalls it exists to remove were all
 * still there, silently.
 *
 * Hence this file, which the worker loads instead of three-mesh-bvh's own entry:
 * define `window` first, THEN let three evaluate.
 *
 * ── THE INVARIANT: NO STATIC IMPORTS ──────────────────────────────────────
 * `import` declarations are hoisted and their modules evaluated BEFORE any
 * statement in this file, so a single static import of anything that reaches
 * three puts three's epilogue back in front of the shim and restores the bug
 * exactly. Every import here is therefore dynamic, including the harmless one.
 * bvh-worker.test.ts pins this by reading the source — the invariant is not
 * visible from the runtime behaviour of a dev build, so a reviewer editing this
 * file has nothing else to warn them.
 */

/** Only the members this file uses, so it needs neither the `webworker` lib
 * (which collides with `DOM` in this tsconfig) nor a cast to `any`. */
type WorkerScope = { postMessage: (message: unknown) => void }

// `globalThis` rather than `{}`: inside a worker everything three could plausibly
// reach through `window` — addEventListener, performance, postMessage — already
// lives on the worker global, so aliasing them is truer than handing three an
// empty object that throws on the second thing it touches. Nothing in the
// worker's graph renders, so no main-thread-only path is unlocked by this: three
// core's module evaluation touches `window` for `__THREE__` and nothing else.
;(globalThis as { window?: unknown }).window ??= globalThis

// three-mesh-bvh's real worker entry: imports three, installs `self.onmessage`,
// and answers build requests. Driven from bvh-worker.ts, which borrows the same
// package's `runTask` so both ends of the protocol stay one version apart from
// never.
// @ts-expect-error — reached through the package's `./src/*` export, which is
// plain JS with no adjacent declaration file. There is no type to get right
// here: the module's entire contract is the `self.onmessage` it installs.
await import('three-mesh-bvh/src/workers/generateMeshBVH.worker.js')

// Only now is the worker able to build anything. Waiting for this instead of
// waiting for a task reply is what turns "dead worker" from a 30 s stall into a
// prompt fall back to main-thread builds: a module-eval throw does NOT fire the
// parent's `Worker.onerror` (verified — the worker stayed alive until we
// terminated it), so silence is the only symptom a dead worker has.
const { BVH_WORKER_BOOTED } = await import('./bvh-worker-protocol')
;(globalThis as unknown as WorkerScope).postMessage(BVH_WORKER_BOOTED)
