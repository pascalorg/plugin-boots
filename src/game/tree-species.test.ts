import { describe, expect, test } from 'bun:test'
import {
  hashXZ,
  MAX_BLOBS,
  MAX_TIERS,
  SPECIES_SEED,
  speciesAt,
  type TreeSpecies,
  treeParamsAt,
} from './tree-species'

/**
 * The pure species generator behind the varied grove: species mix seeded by
 * a quantized position hash (stable across sessions), per-instance ranges
 * exactly as mandated (height 0.7–1.4×, crown width, in-family green
 * jitter, 2–4° lean, trunk thickness), and per-species silhouettes whose
 * numbers the combat replica reads verbatim (trees-destruct raycasts and
 * bursts against crownCY/crownR/trunkH/trunkR — so a felled birch chars as
 * a birch by construction).
 */

const DEG = Math.PI / 180

/** A spread of deterministic sample spots across the lot. */
function samples(n: number): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    // Irrational strides — no accidental alignment with the hash grid.
    out.push([((i * 7.31) % 120) - 60, ((i * 11.17) % 120) - 60])
  }
  return out
}

describe('hashXZ + determinism', () => {
  test('same position, same seed → identical params (deep)', () => {
    for (const [x, z] of samples(24)) {
      expect(treeParamsAt(x, z)).toEqual(treeParamsAt(x, z))
    }
  })

  test('sub-quantum float noise does not change the tree', () => {
    // The hash quantizes to a 0.25 m grid; ±0.02 m never crosses a cell
    // from a cell-center position, so re-derived params stay identical.
    expect(hashXZ(10.5, -3.25)).toBe(hashXZ(10.52, -3.23))
    expect(treeParamsAt(10.5, -3.25)).toEqual(treeParamsAt(10.52, -3.27))
  })

  test('seed changes the field; nearby positions decorrelate', () => {
    const spots = samples(60)
    let seedDiffers = 0
    let neighborDiffers = 0
    for (const [x, z] of spots) {
      if (speciesAt(x, z, SPECIES_SEED) !== speciesAt(x, z, 999)) seedDiffers++
      if (speciesAt(x, z) !== speciesAt(x + 5, z + 5)) neighborDiffers++
    }
    expect(seedDiffers).toBeGreaterThan(10)
    expect(neighborDiffers).toBeGreaterThan(10)
  })
})

describe('species distribution', () => {
  test('all three species show up in sane proportions on a lot-sized grid', () => {
    const counts: Record<TreeSpecies, number> = { conifer: 0, broadleaf: 0, birch: 0 }
    let total = 0
    for (let x = -60; x <= 60; x += 3) {
      for (let z = -60; z <= 60; z += 3) {
        counts[speciesAt(x, z)]++
        total++
      }
    }
    // Weights 0.40 / 0.38 / 0.22 — generous bands, no flakiness.
    expect(counts.conifer / total).toBeGreaterThan(0.3)
    expect(counts.conifer / total).toBeLessThan(0.5)
    expect(counts.broadleaf / total).toBeGreaterThan(0.28)
    expect(counts.broadleaf / total).toBeLessThan(0.48)
    expect(counts.birch / total).toBeGreaterThan(0.13)
    expect(counts.birch / total).toBeLessThan(0.32)
  })

  test('speciesAt matches the species inside the full params', () => {
    for (const [x, z] of samples(40)) {
      expect(treeParamsAt(x, z).species).toBe(speciesAt(x, z))
    }
  })
})

describe('per-instance parameter ranges (the variation mandate)', () => {
  test('height 0.7–1.4×, crown width, 2–4° lean, positive trunk', () => {
    for (const [x, z] of samples(120)) {
      const p = treeParamsAt(x, z)
      expect(p.height).toBeGreaterThanOrEqual(0.7)
      expect(p.height).toBeLessThanOrEqual(1.4)
      expect(p.crown).toBeGreaterThanOrEqual(0.8)
      expect(p.crown).toBeLessThanOrEqual(1.25)
      expect(p.lean).toBeGreaterThanOrEqual(2 * DEG)
      expect(p.lean).toBeLessThanOrEqual(4 * DEG)
      expect(p.leanDir).toBeGreaterThanOrEqual(0)
      expect(p.leanDir).toBeLessThan(Math.PI * 2)
      expect(p.trunkR).toBeGreaterThan(0)
      expect(p.trunkH).toBeGreaterThan(0)
      expect(p.apex).toBeGreaterThan(p.crownCY)
      expect(p.crownR).toBeGreaterThan(0)
    }
  })

  test('crown greens stay in the palette family (green-dominant, in gamut)', () => {
    for (const [x, z] of samples(120)) {
      const { color } = treeParamsAt(x, z)
      for (const c of color) {
        expect(c).toBeGreaterThan(0)
        expect(c).toBeLessThanOrEqual(1)
      }
      expect(color[1]).toBeGreaterThan(color[0]) // green over red
      expect(color[1]).toBeGreaterThan(color[2]) // green over blue
    }
  })

  test('heights actually vary across the lot (no uniform forest)', () => {
    const heights = samples(80).map(([x, z]) => treeParamsAt(x, z).height)
    expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.4)
  })
})

describe('species silhouettes', () => {
  const bySpecies: Record<TreeSpecies, Array<ReturnType<typeof treeParamsAt>>> = {
    conifer: [],
    broadleaf: [],
    birch: [],
  }
  for (const [x, z] of samples(300)) {
    const p = treeParamsAt(x, z)
    bySpecies[p.species].push(p)
  }

  test('every species appears in the fixture sample', () => {
    expect(bySpecies.conifer.length).toBeGreaterThan(20)
    expect(bySpecies.broadleaf.length).toBeGreaterThan(20)
    expect(bySpecies.birch.length).toBeGreaterThan(10)
  })

  test('conifer: 2–3 stacked cones, ascending, shrinking, overlapping', () => {
    let twos = 0
    let threes = 0
    for (const p of bySpecies.conifer) {
      expect(p.tiers.length === 2 || p.tiers.length === 3).toBe(true)
      expect(p.tiers.length).toBeLessThanOrEqual(MAX_TIERS)
      if (p.tiers.length === 2) twos++
      else threes++
      expect(p.blobs).toEqual([])
      expect(p.stub).toBeNull()
      for (let k = 1; k < p.tiers.length; k++) {
        const below = p.tiers[k - 1]!
        const tier = p.tiers[k]!
        expect(tier.y).toBeGreaterThan(below.y) // stacked upward
        expect(tier.r).toBeLessThan(below.r) // shrinking radii
        expect(tier.y).toBeLessThan(below.y + below.h) // tiers overlap
      }
      // Trunk pokes into the bottom skirt — no floating cone stack.
      expect(p.trunkH).toBeGreaterThan(p.tiers[0]!.y)
      // Apex tops the last cone exactly.
      const top = p.tiers[p.tiers.length - 1]!
      expect(p.apex).toBeCloseTo(top.y + top.h, 6)
    }
    // The tier-count coin actually lands on both sides across the lot.
    expect(twos).toBeGreaterThan(0)
    expect(threes).toBeGreaterThan(0)
  })

  test('broadleaf: 2–3 crown blobs on a mid trunk with one branch stub', () => {
    let twos = 0
    let threes = 0
    for (const p of bySpecies.broadleaf) {
      expect(p.tiers).toEqual([])
      expect(p.blobs.length === 2 || p.blobs.length === 3).toBe(true)
      expect(p.blobs.length).toBeLessThanOrEqual(MAX_BLOBS)
      if (p.blobs.length === 2) twos++
      else threes++
      expect(p.stub).not.toBeNull()
      expect(p.stub!.y).toBeGreaterThan(0)
      expect(p.stub!.y).toBeLessThan(p.trunkH)
      // Every blob center sits inside the analytic crown sphere, and every
      // satellite touches the main blob (no floating lobes).
      const main = p.blobs[0]!
      for (const blob of p.blobs) {
        const d = Math.hypot(blob.x, blob.y - p.crownCY, blob.z)
        expect(d).toBeLessThan(p.crownR)
        const toMain = Math.hypot(blob.x - main.x, blob.y - main.y, blob.z - main.z)
        expect(toMain).toBeLessThan(blob.r + main.r)
      }
      // Crown overlaps the trunk top — no gap under the canopy.
      expect(main.y - main.r).toBeLessThan(p.trunkH)
    }
    expect(twos).toBeGreaterThan(0)
    expect(threes).toBeGreaterThan(0)
  })

  test('birch: tall thin light-barked trunk, small high crown', () => {
    for (const p of bySpecies.birch) {
      expect(p.tiers).toEqual([])
      expect(p.stub).toBeNull()
      expect(p.blobs.length).toBe(2) // main crown + top tuft
      expect(p.blobs[1]!.r).toBeLessThan(p.blobs[0]!.r)
      // Light bark, warm-neutral: every channel bright.
      for (const c of p.bark) expect(c).toBeGreaterThan(0.6)
      // Small high crown: sits above a trunk taller than a broadleaf's.
      expect(p.trunkH).toBeGreaterThanOrEqual(3.5 * 0.7)
      expect(p.crownCY).toBeGreaterThan(p.trunkH)
    }
    // Birch trunks are thinner and taller than broadleaf trunks; crowns
    // smaller (compare the species' possible bands, not single trees).
    const maxBirchR = Math.max(...bySpecies.birch.map((p) => p.trunkR))
    const minBroadR = Math.min(...bySpecies.broadleaf.map((p) => p.trunkR))
    expect(maxBirchR).toBeLessThan(minBroadR)
    const maxBirchCrown = Math.max(...bySpecies.birch.map((p) => p.crownR))
    const minBroadCrown = Math.min(...bySpecies.broadleaf.map((p) => p.crownR))
    expect(maxBirchCrown).toBeLessThan(minBroadCrown)
  })

  test('non-birch bark stays brown (r > g > b) and in gamut', () => {
    for (const p of [...bySpecies.conifer, ...bySpecies.broadleaf]) {
      expect(p.bark[0]).toBeGreaterThan(p.bark[1])
      expect(p.bark[1]).toBeGreaterThan(p.bark[2])
      for (const c of p.bark) {
        expect(c).toBeGreaterThan(0)
        expect(c).toBeLessThan(0.6)
      }
    }
  })
})
