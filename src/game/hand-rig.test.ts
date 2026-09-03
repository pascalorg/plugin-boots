import { describe, expect, test } from 'bun:test'
import { Box3, type BufferGeometry, Vector3 } from 'three'
import { handBounds, HAND_POSES, type HandPoseId } from './hand-pose'
import { buildHandGeometry, flipWinding, FOREARM_PARTS, HAND_SKIN, HAND_SLEEVE, segmentGeometry } from './hand-rig'

/**
 * THE MERGED HAND GEOMETRY. Cache identity (one geometry per key for the
 * module's life), extents that match the pure anatomy, a left hand that is
 * the exact x-mirror of the right with the same triangle count — and the one
 * that bites: after `scale(−1,1,1)` the winding must be swapped WITHOUT
 * touching the normals (three's applyMatrix4 already flipped them), so on BOTH
 * sides the geometric normal of a triangle agrees with its stored normals.
 */

const POSES: HandPoseId[] = ['fist', 'trigger', 'wrap', 'can']

/** For the first `n` triangles: cross(b−a, c−a) · mean(stored normals) > 0. */
function windingAgreesWithNormals(geo: BufferGeometry, n = 50): { agree: number; total: number } {
  const pos = geo.getAttribute('position')
  const nor = geo.getAttribute('normal')
  const index = geo.getIndex()
  expect(index).not.toBeNull()
  const a = new Vector3()
  const b = new Vector3()
  const c = new Vector3()
  const na = new Vector3()
  const gn = new Vector3()
  let agree = 0
  let total = 0
  const triCount = index!.count / 3
  const step = Math.max(1, Math.floor(triCount / n))
  for (let t = 0; t < triCount && total < n; t += step) {
    const i0 = index!.getX(t * 3)
    const i1 = index!.getX(t * 3 + 1)
    const i2 = index!.getX(t * 3 + 2)
    a.fromBufferAttribute(pos, i0)
    b.fromBufferAttribute(pos, i1)
    c.fromBufferAttribute(pos, i2)
    gn.subVectors(b, a).cross(new Vector3().subVectors(c, a))
    if (gn.lengthSq() < 1e-16) continue // degenerate (capsule pole)
    na.fromBufferAttribute(nor, i0)
    na.add(new Vector3().fromBufferAttribute(nor, i1))
    na.add(new Vector3().fromBufferAttribute(nor, i2))
    total++
    if (gn.dot(na) > 0) agree++
  }
  return { agree, total }
}

describe('buildHandGeometry', () => {
  test('caches by pose/side/options and never returns a disposed geometry', () => {
    const a = buildHandGeometry('fist', 'R')
    const b = buildHandGeometry('fist', 'R')
    expect(a).toBe(b)
    expect(buildHandGeometry('fist', 'L')).not.toBe(a)
    expect(buildHandGeometry('fist', 'R', { wrist: true })).not.toBe(a)
    expect(buildHandGeometry('fist', 'R', { articulatedIndex: true })).not.toBe(a)
    expect(buildHandGeometry('trigger', 'R')).not.toBe(a)
    expect(a.getAttribute('position').count).toBeGreaterThan(100)
    expect(a.getIndex()).not.toBeNull()
  })

  test('extents match the pure anatomy (≤ 12 cm, and within handBounds + 1 mm)', () => {
    for (const pose of POSES) {
      const geo = buildHandGeometry(pose, 'R', { wrist: true })
      geo.computeBoundingBox()
      const bb = geo.boundingBox!
      const size = bb.getSize(new Vector3())
      expect(size.x).toBeLessThanOrEqual(0.12)
      expect(size.y).toBeLessThanOrEqual(0.12)
      expect(size.z).toBeLessThanOrEqual(0.16) // wrist stub to an extended index
      const pure = handBounds(HAND_POSES[pose], true)
      expect(bb.min.x).toBeGreaterThanOrEqual(pure.min[0] - 0.001)
      expect(bb.min.y).toBeGreaterThanOrEqual(pure.min[1] - 0.001)
      expect(bb.min.z).toBeGreaterThanOrEqual(pure.min[2] - 0.001)
      expect(bb.max.x).toBeLessThanOrEqual(pure.max[0] + 0.001)
      expect(bb.max.y).toBeLessThanOrEqual(pure.max[1] + 0.001)
      expect(bb.max.z).toBeLessThanOrEqual(pure.max[2] + 0.001)
    }
  })

  test('the left hand is the x-mirror of the right: mirrored bounding box, same index count', () => {
    for (const pose of POSES) {
      const r = buildHandGeometry(pose, 'R', { wrist: true })
      const l = buildHandGeometry(pose, 'L', { wrist: true })
      const rb = new Box3().setFromBufferAttribute(r.getAttribute('position') as never)
      const lb = new Box3().setFromBufferAttribute(l.getAttribute('position') as never)
      expect(lb.min.x).toBeCloseTo(-rb.max.x, 6)
      expect(lb.max.x).toBeCloseTo(-rb.min.x, 6)
      expect(lb.min.y).toBeCloseTo(rb.min.y, 6)
      expect(lb.max.y).toBeCloseTo(rb.max.y, 6)
      expect(lb.min.z).toBeCloseTo(rb.min.z, 6)
      expect(lb.max.z).toBeCloseTo(rb.max.z, 6)
      expect(l.getIndex()!.count).toBe(r.getIndex()!.count)
      expect(l.getAttribute('position').count).toBe(r.getAttribute('position').count)
    }
  })

  test('WINDING: geometric normals agree with stored normals on BOTH sides (no double flip)', () => {
    for (const pose of POSES) {
      for (const side of ['R', 'L'] as const) {
        const { agree, total } = windingAgreesWithNormals(buildHandGeometry(pose, side, { wrist: true }), 60)
        expect(total).toBeGreaterThan(30)
        expect(agree, `${pose} ${side}: ${agree}/${total} triangles face out`).toBe(total)
      }
    }
  })

  test('flipWinding alone inverts every triangle (so a mirrored geometry needs exactly one)', () => {
    const g = segmentGeometry(0.03, 0.01).clone()
    const before = windingAgreesWithNormals(g, 40)
    expect(before.agree).toBe(before.total)
    flipWinding(g)
    const after = windingAgreesWithNormals(g, 40)
    expect(after.agree).toBe(0)
    g.dispose()
  })

  test('the articulated rest leaves the index out (fewer triangles) and keeps the wrist', () => {
    const full = buildHandGeometry('trigger', 'R', { wrist: true })
    const rest = buildHandGeometry('trigger', 'R', { wrist: true, articulatedIndex: true })
    expect(rest.getIndex()!.count).toBeLessThan(full.getIndex()!.count)
    const noWrist = buildHandGeometry('trigger', 'R', { articulatedIndex: true })
    expect(rest.getIndex()!.count).toBeGreaterThan(noWrist.getIndex()!.count)
  })
})

describe('segments, materials, forearm', () => {
  test('segmentGeometry runs from the joint along −Z to −len and is cached', () => {
    const g = segmentGeometry(0.03, 0.0095)
    expect(segmentGeometry(0.03, 0.0095)).toBe(g)
    g.computeBoundingBox()
    expect(g.boundingBox!.max.z).toBeCloseTo(0, 6)
    expect(g.boundingBox!.min.z).toBeCloseTo(-0.03, 6)
    expect(g.boundingBox!.max.x).toBeCloseTo(0.0095, 3)
  })

  test('materials are standard (WebGPU-safe) with the shared skin/sleeve colours', () => {
    expect(HAND_SKIN.type).toBe('MeshStandardMaterial')
    expect(HAND_SLEEVE.type).toBe('MeshStandardMaterial')
    expect(`#${HAND_SKIN.color.getHexString()}`).toBe('#efc7b3')
    expect(`#${HAND_SLEEVE.color.getHexString()}`).toBe('#22242a')
  })

  test('forearm parts stack along +Z from the wrist ball without gaps', () => {
    const ballEnd = FOREARM_PARTS.ball.z + FOREARM_PARTS.ball.r
    const cuffStart = FOREARM_PARTS.cuff.z - FOREARM_PARTS.cuff.len / 2
    const cuffEnd = FOREARM_PARTS.cuff.z + FOREARM_PARTS.cuff.len / 2
    const sleeveStart = FOREARM_PARTS.sleeve.z - FOREARM_PARTS.sleeve.len / 2
    expect(cuffStart).toBeLessThanOrEqual(ballEnd + 0.005)
    expect(sleeveStart).toBeLessThanOrEqual(cuffEnd + 0.001)
    expect(FOREARM_PARTS.sleeve.z + FOREARM_PARTS.sleeve.len / 2).toBeLessThan(0.45)
  })
})
