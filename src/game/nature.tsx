'use client'

import { useMemo } from 'react'
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  type InstancedMesh,
  Matrix4,
  Path,
  Quaternion,
  RepeatWrapping,
  Shape,
  ShapeGeometry,
  Vector3,
} from 'three'
import { type GameWorld, pointOnRoad } from './world'

/**
 * The lot: a grass field with scattered flora replacing the editor's flat
 * gray void. Optimization first — one InstancedMesh per species (grass is a
 * single draw call for ~20k blade clusters), no shadows, static transforms,
 * all placement rejected out of the building's footprint AND off every
 * hard-surface footprint (Streetscape roads, driveway slabs, parking pads —
 * world.roadFootprints) so no blade pokes through asphalt.
 *
 * The lawn disc itself is NOT cut around roads: roads render at ground +
 * surfaceThickness (>= 0.1 m in every Streetscape preset), well above the
 * disc's y = 0.05, so the pavement fully occludes it — and the disc's hole
 * mechanism only supports a single rectangle fully inside the contour
 * (overlapping / edge-crossing holes break ShapeGeometry triangulation),
 * which arbitrary road ribbons would violate.
 */

/** Deterministic RNG so re-entry looks identical. */
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

function groundTexture(): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.fillStyle = '#4e7c3a'
  g.fillRect(0, 0, size, size)
  const rand = mulberry32(7)
  g.globalAlpha = 0.28
  for (let i = 0; i < 2600; i++) {
    const shade = 0.82 + rand() * 0.36
    g.fillStyle = `rgb(${Math.round(78 * shade)}, ${Math.round(124 * shade)}, ${Math.round(58 * shade)})`
    const r = 1 + rand() * 3
    g.beginPath()
    g.arc(rand() * size, rand() * size, r, 0, Math.PI * 2)
    g.fill()
  }
  g.globalAlpha = 1
  const texture = new CanvasTexture(canvas)
  texture.wrapS = RepeatWrapping
  texture.wrapT = RepeatWrapping
  texture.repeat.set(30, 30)
  return texture
}

/**
 * One clump of five tapered blades baked into a single indexed geometry.
 * Each blade is a two-segment strip (root quad + tip triangle) with a
 * baked bend and outward lean. Vertex colors run dark at the root to a
 * light, slightly warm tip and multiply with the per-instance green.
 */
function grassClusterGeometry(): BufferGeometry {
  const rand = mulberry32(5)
  const blades = 5
  const positions: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  for (let b = 0; b < blades; b++) {
    const angle = (b / blades) * Math.PI * 2 + rand() * 1.1
    const dirX = Math.cos(angle)
    const dirZ = Math.sin(angle)
    const spread = rand() * 0.05
    const rootX = dirX * spread
    const rootZ = dirZ * spread
    const height = 0.26 + rand() * 0.18
    const half = 0.024 + rand() * 0.012
    const lean = 0.06 + rand() * 0.16
    const sideX = -dirZ * half
    const sideZ = dirX * half
    const midY = height * 0.55
    const midX = rootX + dirX * lean * 0.35
    const midZ = rootZ + dirZ * lean * 0.35
    const base = positions.length / 3
    // biome-ignore format: vertex rows read better unwrapped
    positions.push(
      rootX - sideX, 0, rootZ - sideZ,
      rootX + sideX, 0, rootZ + sideZ,
      midX - sideX * 0.42, midY, midZ - sideZ * 0.42,
      midX + sideX * 0.42, midY, midZ + sideZ * 0.42,
      rootX + dirX * lean, height, rootZ + dirZ * lean,
    )
    // biome-ignore format: one rgb triple per row
    colors.push(
      0.4, 0.45, 0.34,
      0.4, 0.45, 0.34,
      0.78, 0.8, 0.62,
      0.78, 0.8, 0.62,
      1, 1, 0.82,
    )
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3, base + 2, base + 4, base + 3)
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3))
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(colors), 3))
  // All normals point up so blades shade like the ground plane — no dark
  // backfaces, keeps the field reading flat and cartoony.
  const normals = new Float32Array(positions.length)
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setIndex(indices)
  return geometry
}

const GROUND_RADIUS = 95

/**
 * The lawn disc with the building footprint CUT OUT of it (AABB + 1 m
 * margin): host slabs sit on the same ground plane, and any lawn surface
 * running under them z-fights their bottom faces from grazing angles. A
 * hole in the geometry kills that coplanar pair by construction — no
 * offset tuning, nothing rendered where the building stands.
 */
function groundGeometry(world: GameWorld): BufferGeometry {
  const shape = new Shape()
  shape.absarc(0, 0, GROUND_RADIUS, 0, Math.PI * 2, false)
  const aabb = world.buildingAabb
  if (!aabb.isEmpty()) {
    const center = aabb.getCenter(new Vector3())
    const pad = 1
    // Shape space is the disc's local XY; the mesh rotates -PI/2 about X,
    // so local (x, y) lands at world (x, -z) around the building center.
    const x0 = aabb.min.x - pad - center.x
    const x1 = aabb.max.x + pad - center.x
    const y0 = center.z - (aabb.max.z + pad)
    const y1 = center.z - (aabb.min.z - pad)
    // Only cut when the rectangle sits fully inside the disc — a hole
    // crossing the outer contour would break triangulation.
    if (Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) < GROUND_RADIUS * 0.95) {
      const hole = new Path()
      hole.moveTo(x0, y0)
      hole.lineTo(x1, y0)
      hole.lineTo(x1, y1)
      hole.lineTo(x0, y1)
      hole.closePath()
      shape.holes.push(hole)
    }
  }
  const geometry = new ShapeGeometry(shape, 48)
  // ShapeGeometry UVs are raw meters — normalize to [0, 1] across the disc
  // so the shared grass texture keeps its CircleGeometry-era repeat grain.
  const uv = geometry.getAttribute('uv')
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, uv.getX(i) / (GROUND_RADIUS * 2) + 0.5, uv.getY(i) / (GROUND_RADIUS * 2) + 0.5)
  }
  return geometry
}

export type Scatter = { matrices: Matrix4[]; colors: Color[] }

/**
 * Deterministic ring scatter around the building, rejecting the footprint
 * (+ pad) and every hard-surface footprint (roads, driveways, pads) with a
 * 0.3 m clearance margin. `make` fills the matrix and returns the instance
 * color; it may also record placements into its own side arrays —
 * trees-destruct.tsx does exactly that to build combat trees on the same
 * layout (so trees stay off the road too). Exported so flora placement
 * stays one algorithm across modules.
 */
export function scatter(
  world: GameWorld,
  seed: number,
  count: number,
  rMin: number,
  rMax: number,
  make: (rand: () => number, position: Vector3, matrix: Matrix4, t: number) => Color,
  bias = 0.5,
): Scatter {
  const rand = mulberry32(seed)
  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())
  const pad = 1.6
  const min = world.buildingAabb.min
  const max = world.buildingAabb.max
  const matrices: Matrix4[] = []
  const colors: Color[] = []
  const position = new Vector3()
  let guard = count * 6
  while (matrices.length < count && guard-- > 0) {
    const angle = rand() * Math.PI * 2
    const radius = rMin + (rMax - rMin) * rand() ** bias
    position.set(center.x + Math.cos(angle) * radius, 0, center.z + Math.sin(angle) * radius)
    if (
      !world.buildingAabb.isEmpty() &&
      position.x > min.x - pad &&
      position.x < max.x + pad &&
      position.z > min.z - pad &&
      position.z < max.z + pad
    ) {
      continue
    }
    // No flora on pavement: roads, driveways, parking pads (default margin
    // keeps blades clear of the kerb line, not just the centerline).
    if (pointOnRoad(world.roadFootprints, position.x, position.z)) continue
    const matrix = new Matrix4()
    const t = rMax > rMin ? (radius - rMin) / (rMax - rMin) : 0
    colors.push(make(rand, position, matrix, t))
    matrices.push(matrix)
  }
  return { matrices, colors }
}

function setInstances(mesh: InstancedMesh | null, data: Scatter): void {
  if (!mesh) return
  for (let i = 0; i < data.matrices.length; i++) {
    mesh.setMatrixAt(i, data.matrices[i]!)
    mesh.setColorAt(i, data.colors[i]!)
  }
  mesh.count = data.matrices.length
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
}

const GRASS_A = new Color('#79b054')
const GRASS_B = new Color('#55853c')
const FLOWER_WHITE = new Color('#f6f3e7')
const FLOWER_YELLOW = new Color('#f2c14e')
const _quat = new Quaternion()
const _scale = new Vector3()
const _yAxis = new Vector3(0, 1, 0)

export function Nature({ world }: { world: GameWorld }) {
  const texture = useMemo(groundTexture, [])

  const groundGeo = useMemo(() => groundGeometry(world), [world])

  const grassGeometry = useMemo(grassClusterGeometry, [])

  const flowerGeometry = useMemo(() => new CircleGeometry(1, 7).rotateX(-Math.PI / 2), [])

  const grass = useMemo(
    () =>
      // Bias 0.72 packs clumps denser near the building; the distance term
      // scales far clumps up so the field stays covered where it thins out.
      scatter(
        world,
        11,
        20000,
        2,
        55,
        (rand, position, matrix, t) => {
          _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
          const s = (0.75 + rand() * 0.5) * (1 + t * 0.9)
          _scale.set(s, s * (0.8 + rand() * 0.5), s)
          matrix.compose(position, _quat, _scale)
          return GRASS_A.clone().lerp(GRASS_B, rand())
        },
        0.72,
      ),
    [world],
  )

  const flowers = useMemo(
    () =>
      scatter(world, 67, 260, 3, 42, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        const s = 0.05 + rand() * 0.045
        _scale.set(s, 1, s)
        position.y = 0.07 + rand() * 0.1
        matrix.compose(position, _quat, _scale)
        return (rand() < 0.42 ? FLOWER_YELLOW : FLOWER_WHITE).clone()
      }),
    [world],
  )

  // Trees moved to trees-destruct.tsx: they are combat targets now (voxel
  // fell / burn / char / stump), so the module that damages them owns their
  // instances. Same scatter algorithm + seed, so the grove looks identical.

  const bushes = useMemo(
    () =>
      scatter(world, 37, 70, 4, 45, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.5 + rand() * 0.6, 0.35 + rand() * 0.3, 0.5 + rand() * 0.6)
        position.y = 0.15
        matrix.compose(position, _quat, _scale)
        return new Color('#54804a').offsetHSL(0, 0, (rand() - 0.5) * 0.1)
      }),
    [world],
  )

  const rocks = useMemo(
    () =>
      scatter(world, 51, 24, 6, 50, (rand, position, matrix) => {
        _quat.setFromAxisAngle(_yAxis, rand() * Math.PI * 2)
        _scale.set(0.25 + rand() * 0.5, 0.18 + rand() * 0.3, 0.25 + rand() * 0.5)
        position.y = 0.08
        matrix.compose(position, _quat, _scale)
        return new Color('#8d8d86').offsetHSL(0, 0, (rand() - 0.5) * 0.08)
      }),
    [world],
  )

  const center = world.buildingAabb.isEmpty()
    ? new Vector3()
    : world.buildingAabb.getCenter(new Vector3())

  return (
    <group userData={{ __boots: true }}>
      {/* y 0.05 clears host slab tops; the footprint hole (groundGeometry)
          keeps the lawn from ever running under the building. */}
      <mesh geometry={groundGeo} position={[center.x, 0.05, center.z]} rotation={[-Math.PI / 2, 0, 0]}>
        {texture ? (
          <meshStandardMaterial map={texture} roughness={1} />
        ) : (
          <meshStandardMaterial color="#4e7c3a" roughness={1} />
        )}
      </mesh>

      <instancedMesh
        args={[grassGeometry, undefined, grass.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, grass)}
      >
        <meshStandardMaterial roughness={1} side={2} vertexColors />
      </instancedMesh>

      {/* Flower dots: flat discs floating in the blade layer for charm. */}
      <instancedMesh
        args={[flowerGeometry, undefined, flowers.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, flowers)}
      >
        <meshStandardMaterial roughness={1} />
      </instancedMesh>

      <instancedMesh
        args={[undefined, undefined, bushes.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, bushes)}
      >
        <icosahedronGeometry args={[0.6, 1]} />
        <meshStandardMaterial roughness={1} />
      </instancedMesh>

      <instancedMesh
        args={[undefined, undefined, rocks.matrices.length]}
        frustumCulled={false}
        ref={(mesh) => setInstances(mesh, rocks)}
      >
        <icosahedronGeometry args={[0.5, 0]} />
        <meshStandardMaterial roughness={0.9} />
      </instancedMesh>
    </group>
  )
}
