'use client'

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useRef } from 'react'
import {
  AdditiveBlending,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  type InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'

/**
 * Impact dust + lingering haze — the "legendary shootout" air. Two ring
 * buffers of camera-facing quads on shared InstancedMeshes (one draw call
 * each), soft radial-gradient CanvasTexture, additive-ish blending with
 * depthWrite off so puffs never z-fight; per-instance fade rides
 * instanceColor (gray → black reads as dissolve under additive blending).
 * Zero allocations per frame; strict caps.
 *
 * API (callers should feature-check the named exports):
 *   spawnDust(x, y, z, intensity)  — impact puff cluster at a world point.
 *     intensity 0..1: bullet chip ≈ 0.25, voxel-cluster carve ≈ 0.6,
 *     column cut ≈ 1. Grows + fades over ~0.8 s. Pool: 256.
 *   spawnHaze(x, y, z)             — one large, very faint, slow-rising
 *     quad, 4–6 s — call ONCE per crumble/collapse. Pool: 24.
 *   clearDust()                    — session teardown (also runs on
 *     <DustSystem/> unmount).
 *   <DustSystem/>                  — renders both pools; mount in the
 *     game-root fragment.
 */

const PUFF_CAP = 256
const HAZE_CAP = 24

type QuadSlot = {
  alive: boolean
  px: number
  py: number
  pz: number
  vx: number
  vy: number
  vz: number
  /** Base quad size (m); the life curve scales it up as it disperses. */
  size: number
  /** Roll around the view axis + its angular speed — cheap variety. */
  roll: number
  spin: number
  /** Peak additive brightness 0..1 (kept low — dust, not glow). */
  tint: number
  ttl: number
  ttl0: number
}

function makePool(n: number): QuadSlot[] {
  return Array.from({ length: n }, () => ({
    alive: false,
    px: 0,
    py: 0,
    pz: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    size: 1,
    roll: 0,
    spin: 0,
    tint: 0.2,
    ttl: 0,
    ttl0: 1,
  }))
}

const puffs = makePool(PUFF_CAP)
const haze = makePool(HAZE_CAP)
let puffCursor = 0
let hazeCursor = 0
let puffLive = 0
let hazeLive = 0

/** Warm concrete-dust gray, straight from drywall carnage. */
const DUST_R = 0.78
const DUST_G = 0.75
const DUST_B = 0.7

export function spawnDust(x: number, y: number, z: number, intensity: number): void {
  const k = Math.min(1, Math.max(0, intensity))
  const count = 1 + Math.round(k * 2)
  for (let n = 0; n < count; n++) {
    const s = puffs[puffCursor]!
    puffCursor = (puffCursor + 1) % PUFF_CAP
    if (!s.alive) puffLive++
    s.alive = true
    s.px = x + (Math.random() - 0.5) * 0.25
    s.py = y + (Math.random() - 0.5) * 0.25
    s.pz = z + (Math.random() - 0.5) * 0.25
    const theta = Math.random() * Math.PI * 2
    const speed = 0.3 + k * 1.1 * Math.random()
    s.vx = Math.cos(theta) * speed
    s.vy = 0.2 + Math.random() * 0.5
    s.vz = Math.sin(theta) * speed
    s.size = 0.3 + k * 0.85 + Math.random() * 0.25
    s.roll = Math.random() * Math.PI * 2
    s.spin = (Math.random() - 0.5) * 1.6
    s.tint = 0.14 + k * 0.12
    s.ttl = 0.6 + Math.random() * 0.4
    s.ttl0 = s.ttl
  }
}

export function spawnHaze(x: number, y: number, z: number): void {
  const s = haze[hazeCursor]!
  hazeCursor = (hazeCursor + 1) % HAZE_CAP
  if (!s.alive) hazeLive++
  s.alive = true
  s.px = x + (Math.random() - 0.5) * 0.6
  s.py = y + 0.2
  s.pz = z + (Math.random() - 0.5) * 0.6
  s.vx = (Math.random() - 0.5) * 0.1
  s.vy = 0.1 + Math.random() * 0.08
  s.vz = (Math.random() - 0.5) * 0.1
  s.size = 2.4 + Math.random() * 1.2
  s.roll = Math.random() * Math.PI * 2
  s.spin = (Math.random() - 0.5) * 0.24
  s.tint = 0.06
  s.ttl = 4 + Math.random() * 2
  s.ttl0 = s.ttl
}

export function clearDust(): void {
  for (const s of puffs) s.alive = false
  for (const s of haze) s.alive = false
  puffLive = 0
  hazeLive = 0
}

// --- Rendering ---------------------------------------------------------

let dustTexture: CanvasTexture | null = null

/** Soft radial gradient with a few faint blotches — drawn once, no assets. */
function getDustTexture(): CanvasTexture | null {
  if (dustTexture) return dustTexture
  if (typeof document === 'undefined') return null
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  const c = size / 2
  const base = g.createRadialGradient(c, c, 0, c, c, c)
  base.addColorStop(0, 'rgba(255,255,255,0.85)')
  base.addColorStop(0.35, 'rgba(255,255,255,0.5)')
  base.addColorStop(0.7, 'rgba(255,255,255,0.16)')
  base.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = base
  g.fillRect(0, 0, size, size)
  // A few off-center blotches so overlapping puffs don't read as one blob.
  for (let i = 0; i < 5; i++) {
    const angle = (i / 5) * Math.PI * 2 + 0.7
    const bx = c + Math.cos(angle) * size * 0.18
    const by = c + Math.sin(angle) * size * 0.18
    const r = size * (0.14 + (i % 3) * 0.05)
    const blob = g.createRadialGradient(bx, by, 0, bx, by, r)
    blob.addColorStop(0, 'rgba(255,255,255,0.22)')
    blob.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = blob
    g.beginPath()
    g.arc(bx, by, r, 0, Math.PI * 2)
    g.fill()
  }
  dustTexture = new CanvasTexture(canvas)
  return dustTexture
}

const _matrix = new Matrix4()
const _pos = new Vector3()
const _scale = new Vector3()
const _quat = new Quaternion()
const _roll = new Quaternion()
const _viewAxis = new Vector3(0, 0, 1)
const _color = new Color()
const ZERO = new Matrix4().makeScale(0, 0, 0)

/** Air drag for puffs (haze barely moves, its drift stays constant). */
const PUFF_DRAG = 3.2

/**
 * Advance one pool + upload matrices/colors. Growth: quads start small and
 * disperse to ~2.2× base size; fade-in is a snap (~10% of life), fade-out
 * eases across the rest — dust blooms then hangs.
 */
function stepPool(
  pool: QuadSlot[],
  mesh: InstancedMesh,
  dt: number,
  camQuat: Quaternion,
  isPuff: boolean,
): number {
  let live = 0
  for (let i = 0; i < pool.length; i++) {
    const s = pool[i]!
    if (!s.alive) continue
    s.ttl -= dt
    if (s.ttl <= 0) {
      s.alive = false
      mesh.setMatrixAt(i, ZERO)
      continue
    }
    live++
    if (isPuff) {
      const drag = 1 / (1 + PUFF_DRAG * dt)
      s.vx *= drag
      s.vy *= drag
      s.vz *= drag
    }
    s.px += s.vx * dt
    s.py += s.vy * dt
    s.pz += s.vz * dt
    s.roll += s.spin * dt
    const k = 1 - s.ttl / s.ttl0 // 0 → 1 over life
    const grow = s.size * (0.55 + 1.65 * k)
    const fade = Math.min(1, k / 0.1) * (1 - k) * (1 - k)
    _roll.setFromAxisAngle(_viewAxis, s.roll)
    _quat.copy(camQuat).multiply(_roll)
    _pos.set(s.px, s.py, s.pz)
    _scale.set(grow, grow, 1)
    _matrix.compose(_pos, _quat, _scale)
    mesh.setMatrixAt(i, _matrix)
    const v = s.tint * fade
    _color.setRGB(DUST_R * v, DUST_G * v, DUST_B * v)
    mesh.setColorAt(i, _color)
  }
  mesh.instanceMatrix.needsUpdate = true
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  return live
}

function initMesh(mesh: InstancedMesh): void {
  mesh.instanceMatrix.setUsage(DynamicDrawUsage)
  for (let i = 0; i < mesh.count; i++) mesh.setMatrixAt(i, ZERO)
  mesh.instanceMatrix.needsUpdate = true
  mesh.frustumCulled = false
}

export function DustSystem() {
  const puffRef = useRef<InstancedMesh>(null!)
  const hazeRef = useRef<InstancedMesh>(null!)
  const texture = getDustTexture()

  useLayoutEffect(() => {
    if (!texture) return
    initMesh(puffRef.current)
    initMesh(hazeRef.current)
    return clearDust
  }, [texture])

  useFrame((state, rawDt) => {
    const puffMesh = puffRef.current
    const hazeMesh = hazeRef.current
    if (!puffMesh || !hazeMesh) return
    if (puffLive === 0 && hazeLive === 0) return
    const dt = Math.min(rawDt, 1 / 30)
    const camQuat = state.camera.quaternion
    puffLive = stepPool(puffs, puffMesh, dt, camQuat, true)
    hazeLive = stepPool(haze, hazeMesh, dt, camQuat, false)
  })

  if (!texture) return null
  return (
    <group userData={{ __boots: true }}>
      <instancedMesh args={[undefined, undefined, PUFF_CAP]} ref={puffRef} userData={{ __boots: true }}>
        <planeGeometry />
        <meshBasicMaterial
          blending={AdditiveBlending}
          depthWrite={false}
          map={texture}
          toneMapped={false}
          transparent
        />
      </instancedMesh>
      <instancedMesh args={[undefined, undefined, HAZE_CAP]} ref={hazeRef} userData={{ __boots: true }}>
        <planeGeometry />
        <meshBasicMaterial
          blending={AdditiveBlending}
          depthWrite={false}
          map={texture}
          toneMapped={false}
          transparent
        />
      </instancedMesh>
    </group>
  )
}
