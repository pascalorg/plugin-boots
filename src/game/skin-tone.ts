import { Color } from 'three'

/**
 * The per-cell PRIMED skin color — voxel-walls.tsx's primeSkin math,
 * extracted as a shared pure helper so paint.tsx can feather coats FROM the
 * true base tone a cell was primed with (drain lerps base → coat by
 * strength). Must stay bit-identical to what primeSkin writes:
 *
 *   - item targets (cellColors): the sampled per-voxel sub-mesh tone
 *   - slab sandwiches: bottom skin (grid Y = 0) lightens toward drywall
 *   - roof planes: inner skin (grid Z ≠ 0) pales toward bare deck; outer
 *     skin stripes every ~3rd up-slope row darker (shingle courses) and
 *     jitters harder (per-shingle scatter)
 *   - everything wears the two-hash value/saturation jitter on top
 *
 * voxel-walls.tsx should call this from its prime loop instead of keeping
 * a private copy (manager wiring — the extraction diff ships with the
 * spray lane's report). Pure math + module scratch: zero allocations per
 * call, safe inside frame loops.
 */

/** The VoxelTarget subset the tone math reads (structural — destruction's
 * VoxelTarget satisfies it directly). */
export type SkinToneSource = {
  kind: 'wall' | 'slab' | 'volume' | 'roof'
  baseColor: Color
  /** Per-voxel RGB, 3 floats per index (item silhouette lane). */
  cellColors?: Float32Array
  grid: { coords: Int16Array }
}

const _cellTone = new Color()
const _derived = new Color()

/**
 * Write cell `i`'s primed skin color into `out` and return it. Mirrors
 * primeSkin exactly: tone pick (cellColors / slab ceiling / roof deck +
 * course striping) then the deterministic per-cell jitter — a value spread
 * plus a whisper of saturation drift so voxel runs never band flat.
 */
export function primedCellColor(out: Color, wall: SkinToneSource, i: number): Color {
  const j1 = ((i * 2654435761) % 97) / 97
  const j2 = ((i * 1597334677) % 89) / 89
  const cellColors = wall.cellColors
  let base: Color = wall.baseColor
  let jitter = 0.1
  if (cellColors) {
    // Item palette (destruction.ts sampleItemCellColors): each voxel wears
    // its sub-mesh region tone; keep the gentle wall jitter below.
    base = _cellTone.setRGB(cellColors[i * 3]!, cellColors[i * 3 + 1]!, cellColors[i * 3 + 2]!)
  } else if (wall.kind === 'slab' && wall.grid.coords[i * 3 + 1] === 0) {
    // Bottom skin — the ceiling face a player looks up at — renders as
    // slightly lighter, desaturated drywall.
    base = _derived.copy(wall.baseColor).offsetHSL(0, -0.06, 0.14)
  } else if (wall.kind === 'roof') {
    if (wall.grid.coords[i * 3 + 2] !== 0) {
      // Inner skin: the underside seen from the attic — pale bare deck.
      base = _derived.copy(wall.baseColor).offsetHSL(0, -0.08, 0.16)
    } else {
      // Outer skin: every ~3rd in-plane row (grid Y = up the slope)
      // darkens slightly — the shingle course striping.
      base =
        wall.grid.coords[i * 3 + 1]! % 3 === 2
          ? _derived.copy(wall.baseColor).offsetHSL(0, 0, -0.055)
          : wall.baseColor
      jitter = 0.16
    }
  }
  return out.copy(base).offsetHSL(0, (j2 - 0.5) * 0.04, (j1 - 0.5) * jitter)
}
