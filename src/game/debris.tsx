'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import { Color, DynamicDrawUsage, Euler, type InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three'

/**
 * One global ring buffer of tumbling debris cubes — voxel chunks, sparks,
 * glass shards all ride the same InstancedMesh. Hand-rolled ballistics:
 * gravity, one damped ground bounce, shrink-out. No physics engine; a few
 * hundred live pieces cost one draw call.
 */

const CAPACITY = 512

type DebrisSlot = {
  alive: boolean
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  rx: number
  ry: number
  rz: number
  wx: number
  wy: number
  wz: number
  size: number
  ttl: number
  ttl0: number
  bounced: boolean
}

const slots: DebrisSlot[] = Array.from({ length: CAPACITY }, () => ({
  alive: false,
  px: 0,
  py: 0,
  pz: 0,
  vx: 0,
  vy: 0,
  vz: 0,
  rx: 0,
  ry: 0,
  rz: 0,
  wx: 0,
  wy: 0,
  wz: 0,
  size: 0.1,
  ttl: 0,
  ttl0: 1,
  bounced: false,
}))
const colors: Color[] = Array.from({ length: CAPACITY }, () => new Color(1, 1, 1))
let cursor = 0
let liveCount = 0

export function spawnDebris(
  x: number,
  y: number,
  z: number,
  size: number,
  color: Color,
  speed: number,
  ttl = 2.6,
): void {
  const slot = slots[cursor]!
  colors[cursor]!.copy(color).offsetHSL(0, 0, (Math.random() - 0.5) * 0.08)
  cursor = (cursor + 1) % CAPACITY
  if (!slot.alive) liveCount++
  slot.alive = true
  slot.px = x
  slot.py = y
  slot.pz = z
  const theta = Math.random() * Math.PI * 2
  const up = 0.5 + Math.random() * 1.6
  slot.vx = Math.cos(theta) * speed * (0.3 + Math.random() * 0.7)
  slot.vy = up * speed * 0.55
  slot.vz = Math.sin(theta) * speed * (0.3 + Math.random() * 0.7)
  slot.rx = Math.random() * Math.PI
  slot.ry = Math.random() * Math.PI
  slot.rz = Math.random() * Math.PI
  slot.wx = (Math.random() - 0.5) * 9
  slot.wy = (Math.random() - 0.5) * 9
  slot.wz = (Math.random() - 0.5) * 9
  slot.size = size
  slot.ttl = ttl * (0.7 + Math.random() * 0.6)
  slot.ttl0 = slot.ttl
  slot.bounced = false
}

export function clearDebris(): void {
  for (const slot of slots) slot.alive = false
  liveCount = 0
}

const GRAVITY = 14
const _matrix = new Matrix4()
const _quat = new Quaternion()
const _euler = new Euler()
const _pos = new Vector3()
const _scale = new Vector3()
const ZERO = new Matrix4().makeScale(0, 0, 0)

export function Debris() {
  const meshRef = useRef<InstancedMesh>(null!)

  useLayoutEffect(() => {
    const mesh = meshRef.current
    mesh.instanceMatrix.setUsage(DynamicDrawUsage)
    for (let i = 0; i < CAPACITY; i++) mesh.setMatrixAt(i, ZERO)
    mesh.instanceMatrix.needsUpdate = true
    mesh.frustumCulled = false
    return clearDebris
  }, [])

  useFrame((_, rawDt) => {
    const mesh = meshRef.current
    if (!mesh) return
    if (liveCount === 0) return
    const dt = Math.min(rawDt, 1 / 30)
    for (let i = 0; i < CAPACITY; i++) {
      const s = slots[i]!
      if (!s.alive) continue
      s.ttl -= dt
      if (s.ttl <= 0) {
        s.alive = false
        liveCount--
        mesh.setMatrixAt(i, ZERO)
        continue
      }
      s.vy -= GRAVITY * dt
      s.px += s.vx * dt
      s.py += s.vy * dt
      s.pz += s.vz * dt
      s.rx += s.wx * dt
      s.ry += s.wy * dt
      s.rz += s.wz * dt
      const half = s.size / 2
      if (s.py < half && s.vy < 0) {
        s.py = half
        if (s.bounced) {
          s.vx *= 0.7
          s.vy = 0
          s.vz *= 0.7
        } else {
          s.vy = -s.vy * 0.3
          s.vx *= 0.75
          s.vz *= 0.75
          s.bounced = true
        }
      }
      const fade = Math.min(1, s.ttl / (s.ttl0 * 0.3))
      const scale = s.size * fade
      _euler.set(s.rx, s.ry, s.rz)
      _quat.setFromEuler(_euler)
      _pos.set(s.px, s.py, s.pz)
      _scale.setScalar(scale)
      _matrix.compose(_pos, _quat, _scale)
      mesh.setMatrixAt(i, _matrix)
      mesh.setColorAt(i, colors[i]!)
    }
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })

  return (
    <instancedMesh
      args={[undefined, undefined, CAPACITY]}
      ref={meshRef}
      userData={{ __boots: true }}
    >
      <boxGeometry />
      <meshStandardMaterial roughness={0.9} />
    </instancedMesh>
  )
}
