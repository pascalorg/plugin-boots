import { describe, expect, test } from 'bun:test'
import { useBoots } from '../store'
import {
  bilinearHeight,
  classifyRoofShape,
  CORNER_RISE,
  cornerRoofGeometry,
  nearestCorner,
  raycastRoofCorner,
  type RoofCorners,
  rotateQuarter,
  SLOPE_CORNERS,
  toggleCorner,
} from './roof-corners'

describe('corner ring math', () => {
  test('rotateQuarter carries the high edge +Z → +X', () => {
    // SLOPE_CORNERS is high at c2/c3 (+Z); one quarter puts it at c1/c2 (+X).
    expect(rotateQuarter(SLOPE_CORNERS)).toEqual([0, 1, 1, 0])
    // Four quarters is the identity.
    let c: RoofCorners = [0, 1, 1, 0]
    for (let i = 0; i < 4; i++) c = rotateQuarter(c)
    expect(c).toEqual([0, 1, 1, 0])
  })

  test('toggleCorner flips exactly one corner, immutably', () => {
    const base: RoofCorners = [0, 0, 1, 1]
    expect(toggleCorner(base, 0)).toEqual([1, 0, 1, 1])
    expect(toggleCorner(base, 3)).toEqual([0, 0, 1, 0])
    expect(base).toEqual([0, 0, 1, 1])
  })

  test('nearestCorner quadrants', () => {
    expect(nearestCorner(-1, -1)).toBe(0)
    expect(nearestCorner(1, -1)).toBe(1)
    expect(nearestCorner(1, 1)).toBe(2)
    expect(nearestCorner(-1, 1)).toBe(3)
  })

  test('bilinear heights hit corners exactly and blend the center', () => {
    const c: RoofCorners = [0, 1, 1, 0]
    expect(bilinearHeight(c, 0, 0)).toBe(0)
    expect(bilinearHeight(c, 1, 0)).toBe(1)
    expect(bilinearHeight(c, 1, 1)).toBe(1)
    expect(bilinearHeight(c, 0, 1)).toBe(0)
    expect(bilinearHeight(c, 0.5, 0.5)).toBeCloseTo(0.5)
  })
})

describe('classifyRoofShape', () => {
  test('all 16 patterns classify with the right kind', () => {
    const kinds = new Map<string, string>()
    for (let bits = 0; bits < 16; bits++) {
      const c: RoofCorners = [bits & 1, (bits >> 1) & 1, (bits >> 2) & 1, (bits >> 3) & 1]
      kinds.set(c.join(''), classifyRoofShape(c).kind)
    }
    expect(kinds.get('0000')).toBe('flat')
    expect(kinds.get('1111')).toBe('flat')
    expect(kinds.get('0011')).toBe('slope') // SLOPE_CORNERS
    expect(kinds.get('0110')).toBe('slope')
    expect(kinds.get('1100')).toBe('slope')
    expect(kinds.get('1001')).toBe('slope')
    expect(kinds.get('1010')).toBe('saddle')
    expect(kinds.get('0101')).toBe('saddle')
    const counts = [...kinds.values()].reduce<Record<string, number>>((acc, k) => {
      acc[k] = (acc[k] ?? 0) + 1
      return acc
    }, {})
    expect(counts).toEqual({ flat: 2, slope: 4, saddle: 2, corner: 4, valley: 4 })
  })

  test('slope quarters rotate the canonical pattern onto the input', () => {
    expect(classifyRoofShape([0, 0, 1, 1])).toEqual({ kind: 'slope', quarter: 0 })
    let pattern: RoofCorners = SLOPE_CORNERS
    for (let q = 0; q < 4; q++) {
      const shape = classifyRoofShape(pattern)
      expect(shape).toEqual({ kind: 'slope', quarter: q })
      pattern = rotateQuarter(pattern)
    }
  })

  test('flat reports high vs low', () => {
    expect(classifyRoofShape([0, 0, 0, 0])).toEqual({ kind: 'flat', high: false })
    expect(classifyRoofShape([1, 1, 1, 1])).toEqual({ kind: 'flat', high: true })
  })
})

describe('cornerRoofGeometry', () => {
  test('spans eave to rise and is cached per pattern', () => {
    const g = cornerRoofGeometry([0, 0, 1, 1])
    expect(g).toBe(cornerRoofGeometry([0, 0, 1, 1]))
    const box = g.boundingBox!
    expect(box.min.y).toBeCloseTo(0)
    expect(box.max.y).toBeCloseTo(CORNER_RISE + 0.12)
    expect(box.max.x).toBeCloseTo(1.5)
    expect(box.min.z).toBeCloseTo(-1.5)
    expect(g.getAttribute('position').count % 3).toBe(0)
  })
})

describe('raycastRoofCorner', () => {
  const pose = { x: 10, y: 0, z: -6, yaw: 0 }

  test('straight down onto each quadrant names its corner', () => {
    const c: RoofCorners = [0, 0, 0, 0] // flat low — surface at y ≈ 0.12
    for (const [dx, dz, corner] of [
      [-1, -1, 0],
      [1, -1, 1],
      [1, 1, 2],
      [-1, 1, 3],
    ] as const) {
      const hit = raycastRoofCorner(c, pose, pose.x + dx, 5, pose.z + dz, 0, -1, 0, 20)
      expect(hit).not.toBeNull()
      expect(hit!.corner).toBe(corner)
      expect(hit!.t).toBeCloseTo(5 - 0.12, 1)
    }
  })

  test('the raised side is hit higher (earlier) than the low side', () => {
    const hitHigh = raycastRoofCorner(SLOPE_CORNERS, pose, pose.x, 10, pose.z + 1, 0, -1, 0, 20)
    const hitLow = raycastRoofCorner(SLOPE_CORNERS, pose, pose.x, 10, pose.z - 1, 0, -1, 0, 20)
    expect(hitHigh!.t).toBeLessThan(hitLow!.t)
  })

  test('yaw rotates targeting with the piece', () => {
    // Quarter-turned piece: world +X is the piece's local +Z.
    const turned = { ...pose, yaw: Math.PI / 2 }
    const hit = raycastRoofCorner([0, 0, 0, 0], turned, turned.x + 1, 5, turned.z + 1, 0, -1, 0, 20)
    // World (+X,+Z) → local: lx = x·cos − z·sin = −1, lz = x·sin + z·cos = 1 → c3.
    expect(hit!.corner).toBe(3)
  })

  test('misses beyond the footprint and beyond maxT', () => {
    expect(raycastRoofCorner(SLOPE_CORNERS, pose, pose.x + 5, 5, pose.z, 0, -1, 0, 20)).toBeNull()
    expect(raycastRoofCorner(SLOPE_CORNERS, pose, pose.x, 50, pose.z, 0, -1, 0, 3)).toBeNull()
  })
})

describe('store contract (pyramid grammar)', () => {
  test('setPlacedCorners swaps the piece object; transformPlaced drops corners but KEEPS slotId', () => {
    const stored = useBoots.getState().addPlaced({
      piece: 'roof',
      position: [0, 0, 0],
      yaw: 0,
      slotId: 'R:0,0,0',
      corners: SLOPE_CORNERS,
    })
    useBoots.getState().setPlacedCorners(stored.id, [0, 0, 0, 1])
    const edited = useBoots.getState().placed.find((p) => p.id === stored.id)!
    expect(edited.corners).toEqual([0, 0, 0, 1])
    expect(edited).not.toBe(stored) // object swap re-registers mesh+collider

    // The folded-ramp contract: the transformed piece inherits the slot's
    // structural role (slotId retained — the p5r2/r3 QA'd behavior), and
    // the corner heights don't survive a piece-type rebuild.
    useBoots.getState().transformPlaced(stored.id, 'roof', Math.PI / 2)
    const transformed = useBoots.getState().placed.find((p) => p.id === stored.id)!
    expect(transformed.corners).toBeUndefined()
    expect(transformed.slotId).toBe('R:0,0,0')
    useBoots.getState().removePlaced(stored.id)
  })
})
