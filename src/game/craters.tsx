'use client'

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { BufferAttribute, BufferGeometry, Color, NormalBlending, Vector3 } from 'three'
import { spawnDebris } from './debris'
import { spawnDust } from './dust'
import { groundSurfaceY, hasGroundSurfaceProbe } from './ground'
import { clearScatterInRadius } from './nature'
import { type GameWorld, pointOnRoad } from './world'

/**
 * EXPLOSION CRATERS — a grenade that detonates on the lawn digs a hole
 * (owner call 2026-08-25: "a grenade in the ground digs a hole when boom —
 * on the green, probably not on the road"). Purely cosmetic: a displaced
 * radial dirt patch + a scorch decal at the blast point, the grass/flower
 * blades inside it cleared (nature.tsx zero-scales their instances), and a
 * one-shot dirt burst (brown debris cubes + a dust plume; spawnDust has no
 * tint channel — checked 2026-08-26 — so the plume stays gypsum-gray).
 * Collision is NOT deformed — the player walks the old ground plane.
 *
 * SCULPTED GROUND: every height here is relative to ground.ts's height at
 * the scar's XZ, not to y = 0 (which is what "the green" used to mean). On a
 * flat or void lot that IS zero and nothing changes; on a site with terrain
 * the eligibility band follows the dirt, the patch base rides it, and the
 * patch itself is DRAPED per vertex so a crater on a slope cuts into the
 * slope instead of hovering over it as a level disc.
 *
 * ── API ───────────────────────────────────────────────────────────────
 *   spawnCrater(world, center, blastRadius)
 *       The one entry point — grenade.tsx's explodeAt calls it on every
 *       detonation; eligibility lives HERE (green only: blast y near
 *       terrain 0, not on world.roadFootprints, not under the building
 *       AABB), so callers never pre-filter. Returns true when a crater
 *       actually spawned.
 *   spawnFloorBreach(x, z, slabBaseY, carveRadius)
 *       The FLOOR-BREACH variant (owner "broken floor looks broken"): a
 *       carve that opens a ground slab clean THROUGH stamps a modest
 *       soil-toned decal at the hole so whatever sits below (the lawn
 *       plane, or nothing) reads as broken earth. Deliberately BYPASSES
 *       craterEligible — the hole is under the building/driveway by
 *       definition — and shares this ring buffer's CRATER_CAP budget.
 *       destruction.ts calls it from the slab carve path; upper storeys
 *       no-op (their holes must show the room below).
 *   <Craters />  renders the live ring buffer. Mounted by <Nature/> (the
 *       lawn owner), so craters persist for the session and unmount —
 *       geometries disposed — with the rest of the green on exit. No host
 *       objects are touched, so there is no ledger to settle.
 *   resetCraters()  clear all slots (the component does this on mount and
 *       unmount; exported for tests).
 *
 * ── Budget ────────────────────────────────────────────────────────────
 * CRATER_CAP (16) slots in a ring buffer — the 17th boom reuses the first
 * slot (gen bump remounts that mesh with fresh geometry). Each crater is
 * one ~100-vertex vertex-colored patch + one 41-vertex decal, built once
 * at spawn, static afterwards: zero per-frame cost beyond two draw calls.
 *
 * ── Reading the shape ─────────────────────────────────────────────────
 * craterProfile(t) is the radial section (t = r / craterRadius): −0.25 m
 * at the center, easing up through grade to a +0.06 m rim crest at t = 0.7,
 * back to exactly 0 at t = 1 so the edge meets the lawn flush. The patch
 * bases at y = 0.058 (epsilon above the lawn disc's 0.05, plus a polygon
 * offset) so the flush skirt never z-fights the grass. The bowl below the
 * lawn plane is occluded by the lawn itself — the NormalBlending scorch
 * decal (charred center fading out past the rim, RGBA vertex colors)
 * floats just above the lawn and carries the "hole" read, while the
 * displaced rim ring pokes through above it as real dirt.
 */

export const CRATER_CAP = 16
/** Bowl depth (m) below grade at the crater center. */
export const CRATER_DEPTH = 0.25
/** Rim crest height (m) above grade. */
export const CRATER_RIM_HEIGHT = 0.06
/** Where the rim crest sits along the normalized radius. */
export const CRATER_RIM_T = 0.7
/** Crater diameter clamps (m) — scales with the blast radius between them. */
export const CRATER_MIN_DIAMETER = 1.6
export const CRATER_MAX_DIAMETER = 2.4
/** A blast further than this from THE GROUND UNDER IT hit a floor/roof, not
 * dirt. Measured against ground.ts's height at the blast XZ — on a flat lot
 * that is y = 0 as before, on a sculpted site it follows the terrain (the
 * owner's lot runs −5.1 m to +1.7 m, so an absolute band around zero
 * disqualified nearly every real ground blast). */
export const CRATER_MAX_BLAST_Y = 0.6
/** Patch base on a FLAT lot: epsilon above the lawn disc (y = 0.05) — see
 * header. */
export const CRATER_BASE_Y = 0.058
/** Patch base on a SCULPTED site: the terrain suppresses nature's lawn disc,
 * so the patch only has to clear the dirt it is cut into. */
export const CRATER_TERRAIN_LIFT = 0.008
/** Scorch decal floats this far above the patch base. */
const SCORCH_LIFT = 0.006

/** Radial resolution of the displaced patch. */
const CRATER_RINGS = 5
const CRATER_SEGMENTS = 20

/** Charred center → soil brown at the rim (vertex-colored, lit). */
const CHAR_R = 0.16
const CHAR_G = 0.13
const CHAR_B = 0.1
const SOIL_R = 0.42
const SOIL_G = 0.3
const SOIL_B = 0.19
/** Floor-breach center: dark packed earth, NOT explosion char — the decal
 * reads as broken ground, its rim easing up to the same soil brown. */
const EARTH_R = SOIL_R * 0.55
const EARTH_G = SOIL_G * 0.55
const EARTH_B = SOIL_B * 0.55

// ── Floor-breach policy ─────────────────────────────────────────────────
/** A slab whose grid base sits above this is an upper storey — its breach
 * shows the room below, never a ground decal. Mirrors voxel-walls'
 * UNDERLAY_MAX_BASE_Y (an import would cycle: voxel-walls → destruction →
 * craters). */
export const BREACH_MAX_BASE_Y = 0.35
/** Breach decal base height floor: just above the lawn plane (y = 0.05),
 * in the 0.06–0.07 band the crater base also lives in. */
export const BREACH_MIN_Y = 0.062
/** The same clearance measured off sculpted ground (no lawn plane there). */
export const BREACH_TERRAIN_LIFT = BREACH_MIN_Y - 0.05

// --- Ground-relative helpers --------------------------------------------------

/** Per-vertex height offset for a crater patch, local XZ → Δy (see
 * craterDrapeFor). */
export type CraterDrape = (localX: number, localZ: number) => number

/**
 * Patch base height at a world XZ. On a flat or void scene this is exactly
 * CRATER_BASE_Y — the lawn-disc epsilon the whole crater look was tuned
 * against. On a sculpted site the lawn disc doesn't exist and the ground is
 * wherever the heightfield says, so the patch rides that instead.
 */
export function craterBaseYAt(x: number, z: number): number {
  if (!hasGroundSurfaceProbe()) return CRATER_BASE_Y
  return groundSurfaceY(x, z) + CRATER_TERRAIN_LIFT
}

/**
 * A crater patch is a flat-based disc; on a slope its rim would knife into
 * the hill on the uphill side and hang in the air downhill. This bends the
 * patch to the terrain: Δy from the patch center, sampled per vertex off the
 * same analytic height everything else reads. ~120 samples once at spawn (a
 * crater is built in a useMemo, never per frame). Returns undefined on a flat
 * lot so the geometry stays bit-identical there.
 */
export function craterDrapeFor(x: number, z: number): CraterDrape | undefined {
  if (!hasGroundSurfaceProbe()) return undefined
  const baseline = groundSurfaceY(x, z)
  return (localX, localZ) => groundSurfaceY(x + localX, z + localZ) - baseline
}
/** Lift over the slab's grid base — clears the dirt underlay plane at
 * base − 0.004 (voxel-walls UNDERLAY_DROP) without z-fighting it. */
export const BREACH_LIFT = 0.006

// --- Pure math (exported for tests) ------------------------------------------

/**
 * Radial height profile (m) at normalized radius t: −CRATER_DEPTH at 0,
 * +CRATER_RIM_HEIGHT at CRATER_RIM_T, exactly 0 from t = 1 outward.
 * Smoothstep eased on both flanks so the bowl and the rim shed no facets.
 */
export function craterProfile(t: number): number {
  if (t >= 1) return 0
  if (t <= CRATER_RIM_T) {
    const u = t / CRATER_RIM_T
    const s = u * u * (3 - 2 * u)
    return -CRATER_DEPTH + (CRATER_DEPTH + CRATER_RIM_HEIGHT) * s
  }
  const u = (t - CRATER_RIM_T) / (1 - CRATER_RIM_T)
  const s = u * u * (3 - 2 * u)
  return CRATER_RIM_HEIGHT * (1 - s)
}

/** Crater radius (m) for a blast radius — diameter 1.6–2.4 m, clamped. */
export function craterRadiusFor(blastRadius: number): number {
  const diameter = Math.min(
    CRATER_MAX_DIAMETER,
    Math.max(CRATER_MIN_DIAMETER, blastRadius * 0.65),
  )
  return diameter / 2
}

/**
 * Green check: near GROUND height (|y − groundY| ≤ CRATER_MAX_BLAST_Y — a
 * blast on an upper floor or roof never scars the lawn below), NOT on any
 * hard-surface footprint (roads, driveways, pads — world.roadFootprints
 * via world.ts's exported pointOnRoad), and NOT under the building AABB
 * (host slabs/floors own that ground).
 */
export function craterEligible(
  world: Pick<GameWorld, 'roadFootprints' | 'buildingAabb'>,
  x: number,
  y: number,
  z: number,
): boolean {
  const groundY = groundSurfaceY(x, z)
  if (y > groundY + CRATER_MAX_BLAST_Y || y < groundY - CRATER_MAX_BLAST_Y) return false
  const aabb = world.buildingAabb
  if (
    !aabb.isEmpty() &&
    x >= aabb.min.x &&
    x <= aabb.max.x &&
    z >= aabb.min.z &&
    z <= aabb.max.z
  ) {
    return false
  }
  if (pointOnRoad(world.roadFootprints, x, z)) return false
  return true
}

/** Deterministic RNG — same generator nature.tsx uses for its scatter. */
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The displaced patch: center vertex + CRATER_RINGS rings of
 * CRATER_SEGMENTS, y from craterProfile with per-vertex jitter that fades
 * to ZERO at the outer ring (the edge must meet the lawn flush — tests
 * assert exact 0 there). Vertex colors run char → soil along the radius;
 * the `breach` variant runs dark-earth → soil instead (a broken floor is
 * torn ground, not a scorch site).
 */
export function buildCraterGeometry(
  radius: number,
  seed: number,
  breach = false,
  drape?: CraterDrape,
): BufferGeometry {
  const rand = mulberry32(seed)
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const r0 = breach ? EARTH_R : CHAR_R
  const g0 = breach ? EARTH_G : CHAR_G
  const b0 = breach ? EARTH_B : CHAR_B
  const pushColor = (t: number) => {
    const u = Math.min(1, t / CRATER_RIM_T)
    const mix = u * u * (3 - 2 * u)
    const shade = 0.92 + rand() * 0.16
    colors.push(
      (r0 + (SOIL_R - r0) * mix) * shade,
      (g0 + (SOIL_G - g0) * mix) * shade,
      (b0 + (SOIL_B - b0) * mix) * shade,
    )
  }
  positions.push(0, craterProfile(0), 0)
  pushColor(0)
  for (let ring = 1; ring <= CRATER_RINGS; ring++) {
    const t = ring / CRATER_RINGS
    const edge = ring === CRATER_RINGS
    for (let s = 0; s < CRATER_SEGMENTS; s++) {
      const angle = (s / CRATER_SEGMENTS) * Math.PI * 2
      const r = t * radius + (edge ? 0 : (rand() - 0.5) * 0.16 * (radius / CRATER_RINGS))
      const y = craterProfile(t) + (edge ? 0 : (rand() - 0.5) * 0.03 * (1 - t))
      const px = Math.cos(angle) * r
      const pz = Math.sin(angle) * r
      positions.push(px, drape ? y + drape(px, pz) : y, pz)
      pushColor(t)
    }
  }
  // Winding: CCW seen from above (+y), so lighting reads the top face.
  for (let s = 0; s < CRATER_SEGMENTS; s++) {
    indices.push(0, 1 + ((s + 1) % CRATER_SEGMENTS), 1 + s)
  }
  for (let ring = 1; ring < CRATER_RINGS; ring++) {
    const inner = 1 + (ring - 1) * CRATER_SEGMENTS
    const outer = inner + CRATER_SEGMENTS
    for (let s = 0; s < CRATER_SEGMENTS; s++) {
      const s1 = (s + 1) % CRATER_SEGMENTS
      indices.push(inner + s, inner + s1, outer + s1)
      indices.push(inner + s, outer + s1, outer + s)
    }
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The scorch decal: a flat disc with RGBA vertex colors — near-opaque char
 * at the center, soil at the crater edge, alpha 0 at 1.55× the radius.
 * Rendered unlit, NormalBlending, no depth write: it darkens the lawn it
 * floats over and carries the depth read where the real bowl is occluded.
 * The `breach` variant centers on dark earth instead of char — same
 * machinery, dirt read.
 */
export function buildScorchGeometry(
  radius: number,
  breach = false,
  drape?: CraterDrape,
): BufferGeometry {
  const positions: number[] = [0, 0, 0]
  const colors: number[] = breach ? [0.14, 0.1, 0.062, 0.8] : [0.09, 0.075, 0.06, 0.85]
  const indices: number[] = []
  const rings: Array<[number, number, number, number, number]> = [
    [radius * 1.02, 0.33, 0.24, 0.155, 0.5],
    [radius * 1.55, 0.33, 0.24, 0.155, 0],
  ]
  for (const [r, cr, cg, cb, ca] of rings) {
    for (let s = 0; s < CRATER_SEGMENTS; s++) {
      const angle = (s / CRATER_SEGMENTS) * Math.PI * 2
      const px = Math.cos(angle) * r
      const pz = Math.sin(angle) * r
      positions.push(px, drape ? drape(px, pz) : 0, pz)
      colors.push(cr, cg, cb, ca)
    }
  }
  for (let s = 0; s < CRATER_SEGMENTS; s++) {
    indices.push(0, 1 + ((s + 1) % CRATER_SEGMENTS), 1 + s)
  }
  const inner = 1
  const outer = 1 + CRATER_SEGMENTS
  for (let s = 0; s < CRATER_SEGMENTS; s++) {
    const s1 = (s + 1) % CRATER_SEGMENTS
    indices.push(inner + s, inner + s1, outer + s1)
    indices.push(inner + s, outer + s1, outer + s)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 4))
  geometry.setIndex(indices)
  return geometry
}

// --- Ring buffer --------------------------------------------------------------

export type CraterSlot = {
  alive: boolean
  /** Bumped on every (re)use — the React key, so a reused slot remounts. */
  gen: number
  x: number
  z: number
  /** Patch base height — CRATER_BASE_Y for lawn craters; floor breaches
   * ride their slab's height (see spawnFloorBreach). */
  y: number
  radius: number
  seed: number
  /** Floor-breach decal (soil palette, no char) vs blast crater. */
  breach: boolean
}

const slots: CraterSlot[] = Array.from({ length: CRATER_CAP }, () => ({
  alive: false,
  gen: 0,
  x: 0,
  z: 0,
  y: CRATER_BASE_Y,
  radius: 1,
  seed: 1,
  breach: false,
}))
let cursor = 0
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getVersion(): number {
  return version
}

/** The live slots (tests/debug) — read-only by contract. */
export function craterSlots(): readonly CraterSlot[] {
  return slots
}

/** Craters currently rendered. */
export function liveCraters(): number {
  let n = 0
  for (const slot of slots) if (slot.alive) n++
  return n
}

export function resetCraters(): void {
  for (const slot of slots) slot.alive = false
  cursor = 0
  emit()
}

const SOIL = new Color(SOIL_R, SOIL_G, SOIL_B)
const _dustAt = new Vector3()

/**
 * Detonation hook (grenade.tsx calls this from explodeAt): if the blast
 * point is on the green, claim the next ring-buffer slot, strip the
 * blades inside the scar (nature.clearScatterInRadius — one O(instances)
 * pass, never per-frame), and kick a dirt burst. Returns true when a
 * crater spawned.
 */
export function spawnCrater(
  world: Pick<GameWorld, 'roadFootprints' | 'buildingAabb'>,
  center: Vector3,
  blastRadius: number,
): boolean {
  if (!craterEligible(world, center.x, center.y, center.z)) return false
  const slot = slots[cursor]!
  cursor = (cursor + 1) % CRATER_CAP
  slot.alive = true
  slot.gen++
  slot.x = center.x
  slot.z = center.z
  slot.y = craterBaseYAt(center.x, center.z)
  slot.breach = false
  slot.radius = craterRadiusFor(blastRadius)
  slot.seed = (Math.random() * 0xffffffff) >>> 0
  // Nothing grows on scorched dirt — clear the blades to just past the rim.
  clearScatterInRadius(slot.x, slot.z, slot.radius * 1.05)
  // Dirt burst: brown cubes out of the hole + one plume over it. Thrown from
  // just over the GROUND at the hole (0.2–0.45 m up), not over y = 0.
  const burstY = groundSurfaceY(slot.x, slot.z)
  for (let i = 0; i < 10; i++) {
    spawnDebris(
      slot.x + (Math.random() - 0.5) * slot.radius,
      burstY + 0.2 + Math.random() * 0.25,
      slot.z + (Math.random() - 0.5) * slot.radius,
      0.035 + Math.random() * 0.045,
      SOIL,
      3.2,
      1.6,
    )
  }
  _dustAt.set(slot.x, center.y + 0.35, slot.z)
  spawnDust(_dustAt, 0.9, { kind: 'plume' })
  emit()
  return true
}

/**
 * Floor-breach decal (destruction.ts calls this when a carve opens a
 * floor slab clean through): stamp broken earth at the hole so the ground
 * under the breach never reads as pristine lawn or bare void. BYPASSES
 * craterEligible by design — the road/AABB veto exists to keep BLAST scars
 * off hard surfaces, and a breach is by definition under one. Policy:
 *   - upper storeys (slabBaseY more than BREACH_MAX_BASE_Y above the ground
 *     under the hole) no-op — the hole must show the room below;
 *   - base height rides the slab: max(ground clearance, slabBaseY +
 *     BREACH_LIFT) — above the ground AND the slab's dirt underlay;
 *   - modest size: ≈ the carve radius, 1.2× at most (never the blast
 *     clamps — a bullet-drilled breach stays a small scar);
 *   - repeat carves widening one hole GROW the existing decal in place
 *     instead of stacking slots (shared CRATER_CAP budget).
 * No dust/debris burst here — the carve that opened the hole already
 * voiced. Returns true when a new slot spawned.
 */
export function spawnFloorBreach(
  x: number,
  z: number,
  slabBaseY: number,
  carveRadius: number,
): boolean {
  // "Upper storey" is a height ABOVE THE GROUND HERE, and the decal's own
  // floor clears whatever ground that is — on the owner's site a ground slab
  // sits at −4.6 m and used to read as a basement, so its breach never
  // stamped; one that did stamped 4.6 m overhead.
  const groundY = groundSurfaceY(x, z)
  if (slabBaseY - groundY > BREACH_MAX_BASE_Y) return false
  const radius = Math.min(carveRadius * 1.2, CRATER_MAX_DIAMETER / 2)
  if (radius <= 0.05) return false
  const minY = hasGroundSurfaceProbe() ? groundY + BREACH_TERRAIN_LIFT : BREACH_MIN_Y
  const y = Math.max(minY, slabBaseY + BREACH_LIFT)
  for (const slot of slots) {
    if (!slot.alive || !slot.breach) continue
    const dx = slot.x - x
    const dz = slot.z - z
    const reach = Math.max(slot.radius, radius)
    if (dx * dx + dz * dz < reach * reach) {
      if (radius > slot.radius) {
        // The same hole, widened — grow in place (gen bump remounts).
        slot.radius = radius
        slot.gen++
        emit()
      }
      return false
    }
  }
  const slot = slots[cursor]!
  cursor = (cursor + 1) % CRATER_CAP
  slot.alive = true
  slot.gen++
  slot.x = x
  slot.z = z
  slot.y = y
  slot.breach = true
  slot.radius = radius
  slot.seed = (Math.random() * 0xffffffff) >>> 0
  emit()
  return true
}

// --- Rendering ----------------------------------------------------------------

function CraterMesh({ crater }: { crater: CraterSlot }) {
  // Keyed by gen in <Craters/>, so a reused slot remounts and rebuilds —
  // deps here only guard against in-place slot mutation.
  // Blast craters are cut into the GROUND, so they bend with it. Floor
  // breaches ride a flat slab (see spawnFloorBreach) and must stay flat.
  const drape = useMemo(
    () => (crater.breach ? undefined : craterDrapeFor(crater.x, crater.z)),
    [crater.breach, crater.x, crater.z],
  )
  const geometry = useMemo(
    () => buildCraterGeometry(crater.radius, crater.seed, crater.breach, drape),
    [crater.radius, crater.seed, crater.breach, drape],
  )
  const scorch = useMemo(
    () => buildScorchGeometry(crater.radius, crater.breach, drape),
    [crater.radius, crater.breach, drape],
  )
  useEffect(
    () => () => {
      geometry.dispose()
      scorch.dispose()
    },
    [geometry, scorch],
  )
  return (
    <group position={[crater.x, crater.y, crater.z]}>
      <mesh geometry={geometry}>
        <meshStandardMaterial
          polygonOffset
          polygonOffsetFactor={-1}
          polygonOffsetUnits={-1}
          roughness={1}
          vertexColors
        />
      </mesh>
      <mesh geometry={scorch} position={[0, SCORCH_LIFT, 0]}>
        <meshBasicMaterial
          blending={NormalBlending}
          depthWrite={false}
          polygonOffset
          polygonOffsetFactor={-2}
          polygonOffsetUnits={-2}
          transparent
          vertexColors
        />
      </mesh>
    </group>
  )
}

/**
 * The session's scars. Mounted by <Nature/>; module state outlives React
 * across Jump ins, so clear on mount AND unmount (same rule as the
 * grenade pool) — exit disposes every mesh with the tree.
 */
export function Craters() {
  useSyncExternalStore(subscribe, getVersion, getVersion)
  useEffect(() => {
    resetCraters()
    return resetCraters
  }, [])
  return (
    <group userData={{ __boots: true }}>
      {slots.map((slot, i) =>
        slot.alive ? <CraterMesh crater={slot} key={`${i}:${slot.gen}`} /> : null,
      )}
    </group>
  )
}
