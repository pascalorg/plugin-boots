import { afterEach, describe, expect, test } from 'bun:test'
import {
  Box3,
  BoxGeometry,
  Group,
  Matrix4,
  Mesh,
  Path,
  PlaneGeometry,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three'
import { groundSurfaceY, hasGroundSurfaceProbe, lotFloorY, resetGround } from './ground'
import {
  adoptLotPlate,
  bvhFor,
  type ColliderEntry,
  installGroundProbes,
  type SiteSnapshot,
  siteGroundYAt,
  spawnGroundY,
} from './world'

/**
 * THE LOT EDGE — walkable ground past the parcel.
 *
 * The terrain audit gave every system one ground height, but only ON the lot.
 * Off it the session had ground you could see and not stand on: the host draws
 * a 400 m+ horizon plate at y = −0.07 under every site, boots deliberately
 * refuses it as a collider (isPresentationStrip — an unconditional 800 m floor
 * would answer every XZ probe on the map), so a player who walked off a
 * sculpted lot sank through the visible grass onto the collision backstop
 * (−5.61 m on the owner's project) and stood metres under the world.
 *
 * adoptLotPlate makes that plate — the one the host ALREADY renders — solid,
 * but only when it is punched open over the terrain, and only on a sculpted
 * site. These tests pin both halves: what gets adopted, and what must not
 * (an unholed plate would lay a lid over every excavation; a flat site and a
 * void lot must come out byte-identical to before).
 *
 * Everything is headless three.js: real geometry, real BVH probes, no host.
 */

/** The site's terrain field: 60 × 50 m, sculpted from −5 m to +1.5 m. */
const TERRAIN = { minX: -30, maxX: 30, minZ: -25, maxZ: 25 }
/** Where the host's plate sits — HORIZON_PLANE_Y in the editor's SiteRenderer. */
const PLATE_Y = -0.07

afterEach(() => {
  resetGround()
})

function makeSite(overrides: Partial<SiteSnapshot> = {}): SiteSnapshot {
  const root = new Group()
  return {
    nodeId: 'site_1',
    root,
    polygon: [
      [TERRAIN.minX, TERRAIN.minZ],
      [TERRAIN.maxX, TERRAIN.minZ],
      [TERRAIN.maxX, TERRAIN.maxZ],
      [TERRAIN.minX, TERRAIN.maxZ],
    ],
    hasTerrain: true,
    surfaceHeightAt: null,
    ...overrides,
  }
}

function entryFor(mesh: Mesh, nodeType = 'site', nodeId = 'site_1'): ColliderEntry {
  mesh.updateMatrixWorld(true)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox: new Box3().setFromObject(mesh),
    root: mesh,
    nodeId,
    nodeType,
  }
}

/**
 * The site's terrain surface: a 60 × 50 m heightfield tilted so height reads
 * `0.1 · x` (−3 m at the west edge, +3 m at the east), i.e. a lot whose BORDER
 * is sculpted — the case that makes the analytic clamp visible.
 */
function terrainCollider(): ColliderEntry {
  const geometry = new PlaneGeometry(60, 50, 12, 10)
  geometry.rotateX(-Math.PI / 2)
  const position = geometry.getAttribute('position')
  for (let i = 0; i < position.count; i++) position.setY(i, 0.1 * position.getX(i))
  geometry.computeBoundingBox()
  return entryFor(new Mesh(geometry))
}

/** The terrain's edge curtain: reaches BELOW the lowest vertex, so it is the
 * collider installGroundProbes measures the lot floor from. */
function skirtCollider(): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(60, 1, 50))
  mesh.position.set(0, -3.5, 0)
  return entryFor(mesh)
}

/**
 * The host's horizon plate: a flat disc-ish plate at PLATE_Y, optionally with
 * the terrain footprint punched out as a hole (which is exactly what
 * SiteRenderer does whenever the site carries terrain).
 *
 * Built in the shape's XY and rotated into XZ; rotateX(−π/2) maps a shape
 * point (x, y) to world (x, 0, −y), so world Z is fed in negated.
 */
function platePlate(
  half: number,
  hole: { minX: number; maxX: number; minZ: number; maxZ: number } | null,
  thickness = 0,
): Mesh {
  const shape = new Shape()
  shape.moveTo(-half, -half)
  shape.lineTo(half, -half)
  shape.lineTo(half, half)
  shape.lineTo(-half, half)
  shape.closePath()
  if (hole) {
    const path = new Path()
    path.moveTo(hole.minX, -hole.minZ)
    path.lineTo(hole.maxX, -hole.minZ)
    path.lineTo(hole.maxX, -hole.maxZ)
    path.lineTo(hole.minX, -hole.maxZ)
    path.closePath()
    shape.holes.push(path)
  }
  const geometry = new ShapeGeometry(shape)
  geometry.rotateX(-Math.PI / 2)
  if (thickness > 0) {
    // A "plate" with real depth — not the host's disc, and refused as such.
    const position = geometry.getAttribute('position')
    position.setY(0, thickness)
  }
  geometry.computeBoundingBox()
  const mesh = new Mesh(geometry)
  mesh.userData.pascalExport = 'strip'
  mesh.position.y = PLATE_Y
  mesh.updateMatrixWorld(true)
  return mesh
}

/** A site with terrain colliders + the host's holed plate mounted under it. */
function sculptedSite(plate: Mesh | null = platePlate(400, TERRAIN)): {
  site: SiteSnapshot
  colliders: ColliderEntry[]
} {
  const site = makeSite()
  if (plate) site.root.add(plate)
  site.root.updateMatrixWorld(true)
  return { site, colliders: [terrainCollider(), skirtCollider()] }
}

// ---------------------------------------------------------------------------
// adoptLotPlate — what becomes ground
// ---------------------------------------------------------------------------

describe('adoptLotPlate', () => {
  test('adopts the host plate and reports the terrain rect it stops at', () => {
    const { site, colliders } = sculptedSite()
    const edge = adoptLotPlate(colliders, site, undefined)
    expect(edge).not.toBeNull()
    expect(edge!.y).toBeCloseTo(PLATE_Y, 9)
    expect(edge!.minX).toBeCloseTo(TERRAIN.minX, 6)
    expect(edge!.maxX).toBeCloseTo(TERRAIN.maxX, 6)
    expect(edge!.minZ).toBeCloseTo(TERRAIN.minZ, 6)
    expect(edge!.maxZ).toBeCloseTo(TERRAIN.maxZ, 6)
    // Exactly one entry, and it wears the site's own identity.
    expect(colliders).toHaveLength(3)
    const apron = colliders[2]!
    expect(apron.nodeType).toBe('site')
    expect(apron.nodeId).toBe('site_1')
    expect(apron.root).toBe(site.root)
    expect(apron.disabled).toBeUndefined()
  })

  test('the plate is READ, never written — the host mesh comes out untouched', () => {
    // The non-destructive fence: a session may not mutate the host scene.
    const plate = platePlate(400, TERRAIN)
    const before = JSON.stringify(plate.userData)
    const site = makeSite()
    site.root.add(plate)
    site.root.updateMatrixWorld(true)
    adoptLotPlate([terrainCollider(), skirtCollider()], site, undefined)
    expect(JSON.stringify(plate.userData)).toBe(before)
    expect(plate.visible).toBe(true)
    expect(plate.position.y).toBeCloseTo(PLATE_Y, 9)
  })

  test('refuses an UNHOLED plate rather than lid the excavation at −0.07', () => {
    const { site, colliders } = sculptedSite(platePlate(400, null))
    expect(adoptLotPlate(colliders, site, undefined)).toBeNull()
    expect(colliders).toHaveLength(2)
  })

  test('refuses a strip mesh that does not reach past the terrain', () => {
    // Holed correctly, but only 5 m of apron — decoration inside the lot, not
    // the horizon plate.
    const { site, colliders } = sculptedSite(platePlate(35, TERRAIN))
    expect(adoptLotPlate(colliders, site, undefined)).toBeNull()
    expect(colliders).toHaveLength(2)
  })

  test('refuses a strip mesh with real thickness (a volume, not a plate)', () => {
    const { site, colliders } = sculptedSite(platePlate(400, TERRAIN, 2))
    expect(adoptLotPlate(colliders, site, undefined)).toBeNull()
    expect(colliders).toHaveLength(2)
  })

  test('no site, no terrain, no colliders: nothing is adopted', () => {
    const { colliders } = sculptedSite()
    expect(adoptLotPlate(colliders, null, undefined)).toBeNull()
    // A FLAT site (polygon fill at −0.05, no terrain) keeps today's behaviour:
    // off the lot the backstop already holds bodies at FLAT_LOT_Y.
    const flat = sculptedSite()
    expect(adoptLotPlate(flat.colliders, makeSite({ hasTerrain: false }), undefined)).toBeNull()
    // Terrain flagged but no site collider collected yet — no rect to be the
    // edge OF, so no apron.
    const bare = sculptedSite()
    expect(adoptLotPlate([], bare.site, undefined)).toBeNull()
  })

  test('a site with no strip mesh at all is simply left alone', () => {
    const { site, colliders } = sculptedSite(null)
    expect(adoptLotPlate(colliders, site, undefined)).toBeNull()
    expect(colliders).toHaveLength(2)
  })

  test('two candidates: the widest one wins, deterministically', () => {
    const site = makeSite()
    const small = platePlate(120, TERRAIN)
    const big = platePlate(400, TERRAIN)
    site.root.add(small)
    site.root.add(big)
    site.root.updateMatrixWorld(true)
    const colliders = [terrainCollider(), skirtCollider()]
    const edge = adoptLotPlate(colliders, site, undefined)
    expect(edge).not.toBeNull()
    expect(colliders[2]!.mesh).toBe(big)
  })

  test('the fence applies: a plate under ANOTHER registered node is not swept', () => {
    const site = makeSite()
    const child = new Group()
    const plate = platePlate(400, TERRAIN)
    child.add(plate)
    site.root.add(child)
    site.root.updateMatrixWorld(true)
    const colliders = [terrainCollider(), skirtCollider()]
    expect(adoptLotPlate(colliders, site, new Set([child]))).toBeNull()
    // …and without the fence the same plate is found.
    expect(adoptLotPlate(colliders, site, undefined)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The adopted apron as ground
// ---------------------------------------------------------------------------

describe('the apron answers ground probes', () => {
  test('off the lot: a BVH probe that used to find nothing now finds the plate', () => {
    const { site, colliders } = sculptedSite()
    // The bug, first: 40 m past the parcel there is no site collider at all.
    expect(siteGroundYAt({ colliders }, 0, -60)).toBeNull()
    adoptLotPlate(colliders, site, undefined)
    expect(siteGroundYAt({ colliders }, 0, -60)).toBeCloseTo(PLATE_Y, 6)
    expect(siteGroundYAt({ colliders }, -80, 40)).toBeCloseTo(PLATE_Y, 6)
  })

  test('on the lot: the terrain still wins — the hole is real', () => {
    const { site, colliders } = sculptedSite()
    const before = siteGroundYAt({ colliders }, 20, 0)!
    expect(before).toBeCloseTo(2, 6) // 0.1 · 20
    adoptLotPlate(colliders, site, undefined)
    expect(siteGroundYAt({ colliders }, 20, 0)).toBeCloseTo(before, 6)
    // …including where the terrain dips BELOW the plate, which is the whole
    // point of refusing an unholed one.
    const dip = siteGroundYAt({ colliders }, -25, 0)!
    expect(dip).toBeCloseTo(-2.5, 6)
    expect(dip).toBeLessThan(PLATE_Y)
  })

  test('a spawn off the lot settles ON the apron instead of falling through', () => {
    const { site, colliders } = sculptedSite()
    const edge = adoptLotPlate(colliders, site, undefined)
    installGroundProbes({ colliders, site }, edge)
    // Feet just above the plate, not at the −4 m backstop the skirt implies.
    const y = spawnGroundY(colliders, 0, -60)
    expect(y).toBeGreaterThan(PLATE_Y)
    expect(y).toBeLessThan(PLATE_Y + 0.2)
    expect(lotFloorY()).toBeLessThan(-4)
  })
})

// ---------------------------------------------------------------------------
// installGroundProbes + the lot edge
// ---------------------------------------------------------------------------

describe('installGroundProbes with a lot edge', () => {
  /** The host core's analytic field for the ramp terrain — clamped to the
   * border height outside the field, exactly like the real one. */
  const analytic = (x: number, _z: number): number =>
    0.1 * Math.min(TERRAIN.maxX, Math.max(TERRAIN.minX, x))

  test('past the field the apron answers, not the clamped border height', () => {
    const site = makeSite({ surfaceHeightAt: analytic })
    const colliders = [terrainCollider(), skirtCollider()]
    installGroundProbes({ colliders, site }, {
      y: PLATE_Y,
      ...TERRAIN,
    })
    // On the lot: the terrain field, untouched.
    expect(groundSurfaceY(20, 0)).toBeCloseTo(2, 9)
    expect(groundSurfaceY(-20, 10)).toBeCloseTo(-2, 9)
    // Off it: the plate. The border clamp would have said +3 m here — a bot
    // walking east off the parcel would have hovered three metres up.
    expect(groundSurfaceY(60, 0)).toBeCloseTo(PLATE_Y, 9)
    expect(groundSurfaceY(-90, 0)).toBeCloseTo(PLATE_Y, 9)
    expect(groundSurfaceY(0, -60)).toBeCloseTo(PLATE_Y, 9)
    expect(groundSurfaceY(0, 40)).toBeCloseTo(PLATE_Y, 9)
  })

  test('the regression it fixes: without an edge the border height leaks out', () => {
    const site = makeSite({ surfaceHeightAt: analytic })
    installGroundProbes({ colliders: [terrainCollider(), skirtCollider()], site })
    // Old behaviour, pinned so the two paths stay distinguishable.
    expect(groundSurfaceY(60, 0)).toBeCloseTo(3, 9)
  })

  test('the edge does not move the lot floor (still the skirt underside)', () => {
    const plate = platePlate(400, TERRAIN)
    const site = makeSite({ surfaceHeightAt: analytic })
    site.root.add(plate)
    site.root.updateMatrixWorld(true)
    const colliders = [terrainCollider(), skirtCollider()]
    const edge = adoptLotPlate(colliders, site, undefined)
    expect(colliders[2]!.mesh).toBe(plate) // the apron really is in the set
    installGroundProbes({ colliders, site }, edge)
    // The skirt bottoms out at −4; the plate at −0.07 must not raise the floor
    // (setLotFloorY clamps upward anyway, but the measurement is a min()).
    expect(lotFloorY()).toBeCloseTo(-4.5, 6)
  })

  test('BVH fallback (no host field): the apron carries the probe', () => {
    const { site, colliders } = sculptedSite()
    const edge = adoptLotPlate(colliders, site, undefined)
    expect(installGroundProbes({ colliders, site }, edge)).toBe(true)
    expect(groundSurfaceY(20, 0)).toBeCloseTo(2, 1)
    expect(groundSurfaceY(0, -60)).toBeCloseTo(PLATE_Y, 6)
    // Beyond the plate's own reach there is nothing left to probe; the apron
    // height is the last resort, not zero.
    expect(groundSurfaceY(5000, 5000)).toBeCloseTo(PLATE_Y, 9)
  })
})

// ---------------------------------------------------------------------------
// Void-lot parity — the horizon rig must not notice any of this
// ---------------------------------------------------------------------------

describe('void lot parity', () => {
  test('no site node: no apron, no probe, no floor — exactly as before', () => {
    const colliders: ColliderEntry[] = []
    expect(adoptLotPlate(colliders, null, undefined)).toBeNull()
    expect(colliders).toHaveLength(0)
    expect(installGroundProbes({ colliders, site: null }, null)).toBe(false)
    expect(hasGroundSurfaceProbe()).toBe(false)
    expect(groundSurfaceY(0, 0)).toBe(0)
    expect(groundSurfaceY(300, -300)).toBe(0)
    expect(lotFloorY()).toBe(0)
  })

  test('a flat site is equally untouched (no terrain ⇒ no edge, no probe)', () => {
    const flat = makeSite({ hasTerrain: false })
    const fill = new Mesh(new PlaneGeometry(60, 50))
    fill.geometry.rotateX(-Math.PI / 2)
    fill.position.y = -0.05
    const colliders = [entryFor(fill)]
    const edge = adoptLotPlate(colliders, flat, undefined)
    expect(edge).toBeNull()
    expect(colliders).toHaveLength(1)
    expect(installGroundProbes({ colliders, site: flat }, edge)).toBe(false)
    expect(hasGroundSurfaceProbe()).toBe(false)
    expect(groundSurfaceY(0, -60)).toBe(0)
    expect(lotFloorY()).toBe(0)
  })

  test('the horizon plate is never adopted twice across two collects', () => {
    // collectWorld runs once per session, but a re-collect (level switch) must
    // not stack aprons: each call gets a fresh collider array, and the same
    // plate adopted from it is still exactly one entry.
    const site = makeSite()
    const plate = platePlate(400, TERRAIN)
    site.root.add(plate)
    site.root.updateMatrixWorld(true)
    for (let i = 0; i < 3; i++) {
      const colliders = [terrainCollider(), skirtCollider()]
      const edge = adoptLotPlate(colliders, site, undefined)
      expect(edge!.y).toBeCloseTo(PLATE_Y, 9)
      expect(colliders.filter((c) => c.mesh === plate)).toHaveLength(1)
    }
  })
})

// ---------------------------------------------------------------------------
// The apron is ground and NOTHING else
// ---------------------------------------------------------------------------

describe('the apron stays in its lane', () => {
  test("it is a 'site' collider, so every existing site guard covers it", () => {
    const { site, colliders } = sculptedSite()
    adoptLotPlate(colliders, site, undefined)
    const apron = colliders[2]!
    // buildingAabb: collectWorld unions non-site kinds only.
    expect(apron.nodeType).toBe('site')
    // PAD_KINDS = slab | item | block — an apron can never become a road
    // footprint that suppresses grass across the map.
    expect(['slab', 'item', 'block']).not.toContain(apron.nodeType)
    // Damage dispatch keys off wall/window/item kinds; nothing shoots a site.
    expect(apron.walkOnClad).toBeUndefined()
    expect(apron.ballistic).toBeUndefined()
  })

  test('its world box is the plate, not the world', () => {
    const { site, colliders } = sculptedSite()
    adoptLotPlate(colliders, site, undefined)
    const box = colliders[2]!.worldBox
    expect(box.max.y - box.min.y).toBeLessThanOrEqual(0.05)
    expect(box.max.y).toBeCloseTo(PLATE_Y, 6)
    const size = box.getSize(new Vector3())
    expect(size.x).toBeCloseTo(800, 0)
    expect(size.z).toBeCloseTo(800, 0)
  })
})
