/**
 * THE GROUND AUTHORITY — one answer to "how high is the lot here?", shared by
 * every system that used to assume y = 0.
 *
 * A Pascal scene can carry a host `site` node with a sculpted HEIGHTFIELD.
 * The owner's real project runs from −5.1 m in an excavated yard to +1.7 m on
 * a knoll, so "the ground is the y = 0 plane" is wrong by metres — craters
 * floated over valleys, debris stopped dead in mid-air, dropped items snapped
 * up to zero, and bots hovered over pits or ground into hills.
 *
 * This module owns NO probing of its own — that would be a second mechanism
 * competing with world.ts's helpers. It is a DISTRIBUTION POINT: world.ts
 * installs a closure over the session's site snapshot (the host's analytic
 * terrain field when its core exports one, else a cached BVH probe of the
 * 'site' colliders — see installGroundProbes), and everything downstream
 * reads it through two calls:
 *
 *   groundSurfaceY(x, z)  the walkable ground height at a world XZ. The
 *                         terrain surface on a sculpted site; FLAT_LOT_Y on
 *                         every other scene, so a void/flat scene behaves
 *                         EXACTLY as it did before this module existed.
 *   lotFloorY()           the session's hard floor — the backstop under
 *                         which nothing may fall (collision.ts). Stays at
 *                         FLAT_LOT_Y without terrain; on a sculpted site it
 *                         drops below the terrain's lowest point so the
 *                         excavated yard is walkable instead of being sealed
 *                         by an invisible plane at zero.
 *
 * Deliberately dependency-free (no three, no host core): collision.ts and
 * the debris/dust pools sit in the hot path and must not pull the world
 * graph in, and every consumer stays unit-testable with a stub probe.
 * Lifecycle mirrors the other injected probes (setDebrisGroundProbe &c):
 * game-root installs on session start and calls resetGround() on teardown,
 * so nothing leaks between sessions or tests.
 */

/** The flat lot plane — the ground of every scene without sculpted terrain,
 * and the value both readers fall back to. This is the y = 0 that the rest
 * of the codebase used to hard-code. */
export const FLAT_LOT_Y = 0

/** World XZ → ground height (m). Installed per session by world.ts. */
export type GroundSurfaceProbe = (x: number, z: number) => number

let surfaceProbe: GroundSurfaceProbe | null = null
let floorY: number = FLAT_LOT_Y

/**
 * Install (or clear) the session's terrain height probe. Only ever called
 * with a probe when the scene HAS sculpted terrain — a flat site's decorative
 * ground fill (y = −0.05) is not a walkable surface and must not pull the
 * whole game 5 cm down.
 */
export function setGroundSurfaceProbe(probe: GroundSurfaceProbe | null): void {
  surfaceProbe = probe
}

/** Lower the session's hard floor (see lotFloorY). Clamped so it can only
 * ever move DOWN from the flat plane: a site whose terrain is entirely above
 * zero must not lift the floor into the scene. */
export function setLotFloorY(y: number): void {
  floorY = Number.isFinite(y) ? Math.min(FLAT_LOT_Y, y) : FLAT_LOT_Y
}

/** Session teardown / test isolation: back to flat-lot behaviour. */
export function resetGround(): void {
  surfaceProbe = null
  floorY = FLAT_LOT_Y
}

/** Is a sculpted-terrain probe installed? Lets callers keep a byte-identical
 * flat-scene path instead of paying for a probe that would answer 0. */
export function hasGroundSurfaceProbe(): boolean {
  return surfaceProbe !== null
}

/**
 * The ground height at a world XZ: the terrain surface on a sculpted site,
 * else the flat lot plane. Never throws and never returns NaN — a host helper
 * that answers garbage degrades to the flat plane rather than teleporting
 * whatever asked (a NaN would poison a bot position or a debris slot for the
 * rest of the session).
 */
export function groundSurfaceY(x: number, z: number): number {
  if (!surfaceProbe) return FLAT_LOT_Y
  const y = surfaceProbe(x, z)
  return Number.isFinite(y) ? y : FLAT_LOT_Y
}

/** The hard floor under the whole lot: nothing falls below this. */
export function lotFloorY(): number {
  return floorY
}
