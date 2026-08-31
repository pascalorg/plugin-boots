/**
 * The one message the BVH worker sends on its own initiative.
 *
 * three-mesh-bvh's worker protocol is request/response: it only ever speaks
 * when spoken to. That leaves no way to tell "still loading" apart from "dead",
 * and a dead worker is exactly what production shipped — see bvh-worker-entry.ts
 * for why. So the entry adds one unsolicited message, sent after the real
 * handler is installed, and bvh-worker.ts waits for it before posting any task.
 *
 * Its own module because the entry may not statically import anything (again:
 * see bvh-worker-entry.ts), so both sides reach it without dragging a graph
 * along: the entry by dynamic import, this file by importing nothing at all.
 *
 * A task reply is always an object, so this string can never be mistaken for
 * one; and in the other direction three-mesh-bvh's own handler ignores a
 * message with neither `error` nor `serialized`, so an arrival it did not
 * expect costs nothing.
 */
export const BVH_WORKER_BOOTED = '[boots] bvh-worker-booted'
