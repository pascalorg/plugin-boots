/**
 * Short-lived spatial memo for landing-plane probes (perf round 2026-08-27,
 * grenade-hitch finding B4): a detonation spawns 100–200 debris/dust pieces
 * inside a second, and every one ran the injected probeLandingY — a walk of
 * ALL colliders plus a downward DDA against every non-wall voxel target —
 * even though blast debris shares a few-metre footprint. Pieces inside the
 * same 0.5 m XZ cell and 1 m Y band (an upstairs piece must never inherit
 * the downstairs floor) reuse one probe result for TTL_MS.
 *
 * Design constraints (the optimization round set the bar):
 * - Zero allocation on the hot path: packed numeric keys into two
 *   Map<number, number>s — no strings, no entry objects.
 * - Staleness is bounded at TTL_MS (400 ms): a slab carved out from under a
 *   settling plume reads one probe late, which is invisible — the same
 *   window the investigation signed off on.
 * - Both consumers (debris.tsx, dust.tsx) own an instance each and clear it
 *   whenever their probe injection changes (session start/teardown).
 */

export type LandingProbe = (x: number, y: number, z: number) => number

/** XZ bucket size (m) — blast debris within half a metre shares a floor. */
const XZ_CELL = 0.5
/** Y band (m) — storeys must never share a memo cell. */
const Y_CELL = 1
/** Memo lifetime (ms) — bounded staleness after carves under the piece. */
const TTL_MS = 400
/** Hard entry cap — a wholesale clear beats per-entry eviction bookkeeping. */
const MAX_ENTRIES = 512

/** Packed cell key: 11 bits x, 11 bits z, 8 bits y-band (wraps every 1024
 * cells ≈ 512 m — an alias needs two probes half a kilometre apart inside
 * one TTL window, which no scene produces). */
function cellKey(x: number, y: number, z: number): number {
  return (
    (Math.round(x / XZ_CELL) & 0x7ff) |
    ((Math.round(z / XZ_CELL) & 0x7ff) << 11) |
    ((Math.round(y / Y_CELL) & 0xff) << 22)
  )
}

export type ProbeMemo = {
  /** Cached floor Y for this position, or undefined on miss/expiry. */
  peek: (x: number, y: number, z: number) => number | undefined
  /** Run the probe and cache its result (callers budget the misses). */
  probe: (probe: LandingProbe, x: number, y: number, z: number) => number
  /** peek-then-probe convenience for unbudgeted callers. */
  get: (probe: LandingProbe, x: number, y: number, z: number) => number
  clear: () => void
}

/** `now` is injectable for tests; defaults to the wall clock. */
export function createProbeMemo(now: () => number = () => performance.now()): ProbeMemo {
  const values = new Map<number, number>()
  const stamps = new Map<number, number>()
  const peek = (x: number, y: number, z: number): number | undefined => {
    const key = cellKey(x, y, z)
    const stamp = stamps.get(key)
    if (stamp === undefined || now() - stamp >= TTL_MS) return undefined
    return values.get(key)
  }
  const probe = (probeFn: LandingProbe, x: number, y: number, z: number): number => {
    if (values.size >= MAX_ENTRIES) {
      values.clear()
      stamps.clear()
    }
    const key = cellKey(x, y, z)
    const value = probeFn(x, y, z)
    values.set(key, value)
    stamps.set(key, now())
    return value
  }
  return {
    peek,
    probe,
    get: (probeFn, x, y, z) => peek(x, y, z) ?? probe(probeFn, x, y, z),
    clear: () => {
      values.clear()
      stamps.clear()
    },
  }
}
