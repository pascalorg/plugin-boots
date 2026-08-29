/**
 * Tree species — the pure silhouette generator both flora modules share.
 *
 * The owner's note on the old grove: "the shape of the trees is boring, no
 * variation, no detail" — every tree was the same cone on a cylinder. This
 * module derives a SPECIES plus a full parameter set for any tree from its
 * position alone (quantized-XZ hash → mulberry32 stream), so:
 *
 *   - nature.tsx and trees-destruct.tsx agree on every tree without
 *     passing state around: a felled birch chars as a birch,
 *   - the mix is stable across sessions (same lot → same forest),
 *   - everything stays instanced: a species is a fixed set of PARTS
 *     (trunk / stacked cones / crown blobs / branch stub), and a tree is
 *     just per-part matrices + instanceColor on shared unit geometries.
 *
 * Species (all low-poly cartoon):
 *   conifer   — 2–3 stacked cones on a short trunk (tier count + overlap
 *               vary, radii shrink up the stack)
 *   broadleaf — 2–3 clustered crown blobs on a mid trunk with one bark
 *               branch stub poking out
 *   birch     — tall thin light-barked trunk, small high crown (main blob
 *               + a top tuft)
 *   (bush     — low, trunkless; lives in nature.tsx as a baked blob
 *               cluster, not a combat tree)
 *
 * Per-instance seeded variation: height 0.7–1.4×, crown width, green hue
 * jitter inside the existing palette family, 2–4° lean with a random
 * bearing, trunk thickness. Pure numbers only — no three.js imports, so
 * tests run headless and trees-destruct keeps its analytic raycasts.
 */

export type TreeSpecies = 'conifer' | 'broadleaf' | 'birch'

/** One stacked cone of a conifer (unit-tree meters; scale per instance). */
export type TierSpec = { y: number; r: number; h: number }

/** One crown blob of a broadleaf/birch (offset from the trunk axis). */
export type BlobSpec = { x: number; y: number; z: number; r: number }

export type TreeParams = {
  species: TreeSpecies
  /** Overall height multiplier, 0.7..1.4. */
  height: number
  /** Crown width multiplier, 0.8..1.25. */
  crown: number
  /** Lean off vertical (rad), 2°..4°. */
  lean: number
  /** Lean bearing (rad, 0..2π). */
  leanDir: number
  /** Crown rgb 0..1 — species palette lerp + jitter (palette family). */
  color: [number, number, number]
  /** Bark rgb 0..1 (birch is light, others brown; slight jitter). */
  bark: [number, number, number]
  /** Trunk height / radius (unit-tree meters, height mult baked in). */
  trunkH: number
  trunkR: number
  /** Conifer cone stack (empty for other species). */
  tiers: TierSpec[]
  /** Crown blobs (empty for conifers). */
  blobs: BlobSpec[]
  /** Broadleaf branch stub (null on other species). */
  stub: { yaw: number; y: number } | null
  /** Analytic canopy sphere for raycasts (center height / radius). */
  crownCY: number
  crownR: number
  /** Total unit-tree height — host trees scale to match node height. */
  apex: number
}

/** Default seed for the lot's species field. */
export const SPECIES_SEED = 1913

/** Cap on cone tiers / crown blobs — the instanced slot count per tree. */
export const MAX_TIERS = 3
export const MAX_BLOBS = 3

/** Same deterministic RNG family nature.tsx scatters with. */
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
 * Position hash: XZ quantized to a 0.25 m grid (scatter positions are
 * deterministic floats; quantizing kills any last-bit noise), mixed with
 * the seed into one uint32. Stable across sessions by construction.
 */
export function hashXZ(x: number, z: number, seed: number = SPECIES_SEED): number {
  let h = seed | 0
  h = (Math.imul(h ^ Math.round(x * 4), 0x9e3779b1) ^ (h >>> 13)) | 0
  h = (Math.imul(h ^ Math.round(z * 4), 0x85ebca77) ^ (h >>> 11)) | 0
  h ^= h >>> 16
  return h >>> 0
}

// Palette family: greens around the grove's #3f6d33, per-species band.
// rgb triples 0..1; color = lerp(A, B, rand) keeps every jitter in-family.
const CONIFER_A: [number, number, number] = [0.18, 0.36, 0.2] // deep pine
const CONIFER_B: [number, number, number] = [0.27, 0.46, 0.26]
const BROADLEAF_A: [number, number, number] = [0.25, 0.43, 0.2] // #3f6d33
const BROADLEAF_B: [number, number, number] = [0.36, 0.56, 0.27]
const BIRCH_A: [number, number, number] = [0.38, 0.58, 0.28] // light, warm
const BIRCH_B: [number, number, number] = [0.5, 0.68, 0.34]
const BARK_A: [number, number, number] = [0.42, 0.31, 0.21] // #6b4f35
const BARK_B: [number, number, number] = [0.5, 0.38, 0.26]
const BIRCH_BARK_A: [number, number, number] = [0.8, 0.78, 0.71] // pale bark
const BIRCH_BARK_B: [number, number, number] = [0.88, 0.86, 0.79]

function lerp3(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

const DEG = Math.PI / 180

/** Species pick alone (distribution tests + quick reads). */
export function speciesAt(x: number, z: number, seed: number = SPECIES_SEED): TreeSpecies {
  const roll = mulberry32(hashXZ(x, z, seed))()
  if (roll < 0.4) return 'conifer'
  if (roll < 0.78) return 'broadleaf'
  return 'birch'
}

/**
 * Full deterministic parameter set for the tree standing at (x, z).
 * Everything downstream (render matrices, raycast sphere, burst volumes,
 * host-scale mapping) reads these numbers — one source of truth, so the
 * combat replica always matches the silhouette.
 */
export function treeParamsAt(x: number, z: number, seed: number = SPECIES_SEED): TreeParams {
  const rand = mulberry32(hashXZ(x, z, seed))
  const roll = rand()
  const species: TreeSpecies = roll < 0.4 ? 'conifer' : roll < 0.78 ? 'broadleaf' : 'birch'
  const height = 0.7 + rand() * 0.7
  const crown = 0.8 + rand() * 0.45
  const trunk = 0.85 + rand() * 0.35
  const lean = (2 + rand() * 2) * DEG
  const leanDir = rand() * Math.PI * 2
  const colorT = rand()

  if (species === 'conifer') {
    const tierCount = rand() < 0.55 ? 3 : 2
    const overlap = 0.3 + rand() * 0.15
    const skirtY = 0.9 * height
    const tierH = (tierCount === 3 ? 1.75 : 2.2) * height
    const step = tierH * (1 - overlap)
    const tiers: TierSpec[] = []
    for (let k = 0; k < tierCount; k++) {
      tiers.push({ y: skirtY + k * step, r: 1.55 * crown * (1 - 0.26 * k), h: tierH })
    }
    const apex = skirtY + (tierCount - 1) * step + tierH
    return {
      species,
      height,
      crown,
      lean,
      leanDir,
      color: lerp3(CONIFER_A, CONIFER_B, colorT),
      bark: lerp3(BARK_A, BARK_B, rand()),
      trunkH: skirtY + 0.5,
      trunkR: 0.16 * trunk,
      tiers,
      blobs: [],
      stub: null,
      crownCY: (skirtY + apex) / 2,
      crownR: Math.max(1.55 * crown, (apex - skirtY) / 2) * 0.95,
      apex,
    }
  }

  if (species === 'broadleaf') {
    const trunkH = 2.4 * height
    const blobCount = rand() < 0.55 ? 3 : 2
    const cy = trunkH + 0.85 * crown
    const blobs: BlobSpec[] = [{ x: 0, y: cy, z: 0, r: 1.25 * crown }]
    for (let k = 1; k < blobCount; k++) {
      const bearing = rand() * Math.PI * 2
      const d = (0.5 + rand() * 0.35) * crown
      blobs.push({
        x: Math.cos(bearing) * d,
        y: cy + (rand() - 0.35) * 0.7 * crown,
        z: Math.sin(bearing) * d,
        r: (0.85 + rand() * 0.25) * crown,
      })
    }
    return {
      species,
      height,
      crown,
      lean,
      leanDir,
      color: lerp3(BROADLEAF_A, BROADLEAF_B, colorT),
      bark: lerp3(BARK_A, BARK_B, rand()),
      trunkH,
      trunkR: 0.2 * trunk,
      tiers: [],
      blobs,
      stub: { yaw: rand() * Math.PI * 2, y: trunkH * 0.62 },
      crownCY: cy,
      crownR: 1.7 * crown,
      apex: cy + 1.3 * crown,
    }
  }

  // Birch: tall thin light trunk, small high crown (main blob + top tuft).
  const trunkH = 3.5 * height
  const cy = trunkH + 0.45 * crown
  const tuftBearing = rand() * Math.PI * 2
  const blobs: BlobSpec[] = [
    { x: 0, y: cy, z: 0, r: 0.85 * crown },
    {
      x: Math.cos(tuftBearing) * 0.35 * crown,
      y: cy + 0.55 * crown,
      z: Math.sin(tuftBearing) * 0.35 * crown,
      r: 0.55 * crown,
    },
  ]
  return {
    species,
    height,
    crown,
    lean,
    leanDir,
    color: lerp3(BIRCH_A, BIRCH_B, colorT),
    bark: lerp3(BIRCH_BARK_A, BIRCH_BARK_B, rand()),
    trunkH,
    trunkR: 0.1 * trunk,
    tiers: [],
    blobs,
    stub: null,
    crownCY: cy + 0.15 * crown,
    crownR: 1.05 * crown,
    apex: cy + 1.1 * crown,
  }
}
