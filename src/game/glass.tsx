'use client'

import { useMemo } from 'react'
import { CanvasTexture, Color, Matrix4, type Mesh, Quaternion, Ray, Vector3 } from 'three'
import { create } from 'zustand'
import { sfx } from './audio'
import { spawnDebris } from './debris'
import { hideForGame } from './session'
import { bvhFor, type GameWorld, type GlassPane } from './world'

/**
 * Two-stage glass: bullet hits pin a radial crack sprite to the pane; the
 * third hit shatters it — the host mesh hides (session ledger restores it)
 * and shards ride the shared debris buffer. Crack texture is drawn once on
 * a small canvas at runtime; no assets.
 */

export type CrackDecal = {
  id: number
  position: [number, number, number]
  quaternion: [number, number, number, number]
}

type GlassState = {
  hits: Map<Mesh, number>
  cracks: CrackDecal[]
  shattered: Set<Mesh>
  version: number
}

export const useGlass = create<GlassState>(() => ({
  hits: new Map(),
  cracks: [],
  shattered: new Set(),
  version: 0,
}))

export function resetGlass(): void {
  useGlass.setState({ hits: new Map(), cracks: [], shattered: new Set(), version: 0 })
}

let crackId = 1
const _ray = new Ray()
const _inverse = new Matrix4()
const _normalMat = new Vector3()

export type GlassHit = { pane: GlassPane; distance: number; point: Vector3; normal: Vector3 }

export function raycastGlass(
  world: GameWorld,
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): GlassHit | null {
  const shattered = useGlass.getState().shattered
  let best: GlassHit | null = null
  for (const pane of world.glass) {
    if (shattered.has(pane.mesh)) continue
    _inverse.copy(pane.mesh.matrixWorld).invert()
    _ray.origin.copy(origin).applyMatrix4(_inverse)
    _ray.direction.copy(direction).transformDirection(_inverse)
    const hit = bvhFor(pane.mesh).raycastFirst(_ray, 2)
    if (!hit) continue
    const point = hit.point.clone().applyMatrix4(pane.mesh.matrixWorld)
    const distance = point.distanceTo(origin)
    if (distance > maxDist) continue
    if (!best || distance < best.distance) {
      const normal = (hit.face?.normal
        ? _normalMat.copy(hit.face.normal).transformDirection(pane.mesh.matrixWorld).clone()
        : direction.clone().negate()) as Vector3
      best = { pane, distance, point, normal }
    }
  }
  return best
}

const GLASS_COLOR = new Color('#bcd8e2')

export function shatterPane(pane: GlassPane): void {
  const state = useGlass.getState()
  if (state.shattered.has(pane.mesh)) return
  hideForGame(pane.mesh)
  if (!pane.mesh.geometry.boundingBox) pane.mesh.geometry.computeBoundingBox()
  const box = pane.mesh.geometry.boundingBox!
  const corner = new Vector3()
  const shardCount = 26
  for (let i = 0; i < shardCount; i++) {
    corner
      .set(
        box.min.x + Math.random() * (box.max.x - box.min.x),
        box.min.y + Math.random() * (box.max.y - box.min.y),
        box.min.z + Math.random() * (box.max.z - box.min.z),
      )
      .applyMatrix4(pane.mesh.matrixWorld)
    spawnDebris(corner.x, corner.y, corner.z, 0.05 + Math.random() * 0.08, GLASS_COLOR, 1.2, 1.8)
  }
  const shattered = new Set(state.shattered)
  shattered.add(pane.mesh)
  useGlass.setState({
    shattered,
    cracks: state.cracks, // pane cracks keep floating in the frame — reads as broken edge bits
    version: state.version + 1,
  })
  sfx.glassShatter()
}

export function hitGlass(hit: GlassHit): void {
  const state = useGlass.getState()
  const count = (state.hits.get(hit.pane.mesh) ?? 0) + 1
  state.hits.set(hit.pane.mesh, count)
  if (count >= 3) {
    shatterPane(hit.pane)
    return
  }
  const quaternion = crackQuaternion(hit.normal)
  useGlass.setState({
    cracks: [
      ...state.cracks,
      {
        id: crackId++,
        position: [
          hit.point.x + hit.normal.x * 0.006,
          hit.point.y + hit.normal.y * 0.006,
          hit.point.z + hit.normal.z * 0.006,
        ],
        quaternion,
      },
    ],
    version: state.version + 1,
  })
  sfx.glassCrack()
}

const _z = new Vector3(0, 0, 1)
const _q = new Quaternion()

function crackQuaternion(normal: Vector3): [number, number, number, number] {
  _q.setFromUnitVectors(_z, normal.clone().normalize())
  return [_q.x, _q.y, _q.z, _q.w]
}

let crackTexture: CanvasTexture | null = null

function getCrackTexture(): CanvasTexture | null {
  if (crackTexture) return crackTexture
  if (typeof document === 'undefined') return null
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const g = canvas.getContext('2d')!
  g.clearRect(0, 0, size, size)
  g.strokeStyle = 'rgba(235,245,250,0.9)'
  const cx = size / 2
  for (let i = 0; i < 9; i++) {
    const angle = (i / 9) * Math.PI * 2 + Math.random() * 0.5
    g.lineWidth = 1.5
    g.beginPath()
    g.moveTo(cx, cx)
    let r = 8
    let x = cx
    let y = cx
    while (r < size / 2 - 4) {
      r += 8 + Math.random() * 10
      x = cx + Math.cos(angle + (Math.random() - 0.5) * 0.4) * r
      y = cx + Math.sin(angle + (Math.random() - 0.5) * 0.4) * r
      g.lineTo(x, y)
    }
    g.stroke()
  }
  for (const radius of [10, 22, 36]) {
    g.lineWidth = 1
    g.beginPath()
    g.arc(cx, cx, radius + Math.random() * 5, 0, Math.PI * 2)
    g.stroke()
  }
  crackTexture = new CanvasTexture(canvas)
  return crackTexture
}

export function GlassCracks() {
  const version = useGlass((s) => s.version)
  const cracks = useMemo(() => {
    void version
    return useGlass.getState().cracks
  }, [version])
  const texture = getCrackTexture()
  if (!texture) return null
  return (
    <group userData={{ __boots: true }}>
      {cracks.map((crack) => (
        <mesh key={crack.id} position={crack.position} quaternion={crack.quaternion}>
          <planeGeometry args={[0.34, 0.34]} />
          <meshBasicMaterial depthWrite={false} map={texture} transparent />
        </mesh>
      ))}
    </group>
  )
}
