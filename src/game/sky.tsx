'use client'

import { useMemo } from 'react'
import { BackSide, CanvasTexture, SRGBColorSpace, Vector3 } from 'three'
import type { GameWorld } from './world'

/**
 * Game-session sky dome — replaces the editor's flat void with an overcast
 * ceiling: mostly light WARM gray (never blue), a gentle vertical gradient
 * (bright warm horizon → dimmer zenith) and a few soft brighter patches, as
 * if light leaks through cloud gaps. One BackSide sphere + CanvasTexture on
 * a meshBasicMaterial: zero per-frame cost, WebGPU-safe, no scene.fog (the
 * horizon-side brightening of the gradient is the distance softening).
 *
 * Mount `<GameSky world={world} />` in the game-root fragment; it centers
 * on the building footprint and unmounts with the session (nothing to
 * restore — it's a game-only object, `__boots`-tagged so world collection
 * ignores it).
 */

const RADIUS = 180

let skyTexture: CanvasTexture | null = null

/**
 * Painted once per module life. Canvas y=0 maps to the dome zenith (sphere
 * uv v=1), the vertical middle is the horizon, the bottom half sits below
 * ground and stays a muted earth-gray so nothing weird peeks through gaps.
 */
function getSkyTexture(): CanvasTexture | null {
  if (skyTexture) return skyTexture
  if (typeof document === 'undefined') return null
  const w = 512
  const h = 256
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const g = canvas.getContext('2d')!

  // Overcast gradient — warm grays only, brightest at the horizon.
  const grad = g.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0, '#a8a7a3') // zenith: mid warm gray
  grad.addColorStop(0.28, '#bcb9b2')
  grad.addColorStop(0.46, '#d6d0c5') // approaching the horizon: warm light
  grad.addColorStop(0.52, '#ddd7ca') // horizon band — the "less gray" lift
  grad.addColorStop(0.62, '#c2bcb1')
  grad.addColorStop(1, '#9a968e') // below ground: muted, never visible much
  g.fillStyle = grad
  g.fillRect(0, 0, w, h)

  // Soft darker smudges — cloud weight, keeps the ceiling from being flat.
  const smudges: Array<[number, number, number, number]> = [
    [0.16, 0.14, 0.2, 0.09],
    [0.44, 0.08, 0.24, 0.08],
    [0.68, 0.18, 0.18, 0.09],
    [0.88, 0.1, 0.16, 0.07],
    [0.3, 0.26, 0.22, 0.06],
    [0.58, 0.3, 0.2, 0.06],
  ]
  for (const [fx, fy, fr, alpha] of smudges) {
    const r = fr * w
    const blob = g.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, r)
    blob.addColorStop(0, `rgba(118,117,114,${alpha})`)
    blob.addColorStop(1, 'rgba(118,117,114,0)')
    g.fillStyle = blob
    g.beginPath()
    g.arc(fx * w, fy * h, r, 0, Math.PI * 2)
    g.fill()
  }

  // Brighter breaks — light through cloud gaps. Warm white, soft, sparse,
  // kept off the texture's u-seam (x within 0.1..0.9).
  const breaks: Array<[number, number, number, number]> = [
    [0.24, 0.2, 0.15, 0.32],
    [0.55, 0.13, 0.12, 0.26],
    [0.78, 0.26, 0.17, 0.3],
    [0.4, 0.34, 0.11, 0.18],
  ]
  for (const [fx, fy, fr, alpha] of breaks) {
    const r = fr * w
    const glow = g.createRadialGradient(fx * w, fy * h, 0, fx * w, fy * h, r)
    glow.addColorStop(0, `rgba(246,241,230,${alpha})`)
    glow.addColorStop(0.5, `rgba(246,241,230,${alpha * 0.4})`)
    glow.addColorStop(1, 'rgba(246,241,230,0)')
    g.fillStyle = glow
    g.beginPath()
    g.arc(fx * w, fy * h, r, 0, Math.PI * 2)
    g.fill()
  }

  // Pole cap: every u-column of canvas row y=0 collapses onto the dome's
  // single zenith point, so ANY x-variation near the top (smudge/break
  // tails) smears into concentric rings around the pole. Painting the top
  // rows back to one uniform color removes the banding — and making that
  // color a touch BRIGHTER than the zenith gray doubles as the subtle
  // light-through-clouds lift straight overhead (warm gray, never blue).
  const cap = g.createLinearGradient(0, 0, 0, h * 0.14)
  cap.addColorStop(0, 'rgba(185,182,176,1)') // uniform, slightly lifted zenith
  cap.addColorStop(0.55, 'rgba(185,182,176,0.55)')
  cap.addColorStop(1, 'rgba(185,182,176,0)')
  g.fillStyle = cap
  g.fillRect(0, 0, w, Math.ceil(h * 0.14))

  skyTexture = new CanvasTexture(canvas)
  skyTexture.colorSpace = SRGBColorSpace
  return skyTexture
}

export function GameSky({ world }: { world: GameWorld }) {
  const center = useMemo(
    () => (world.buildingAabb.isEmpty() ? new Vector3() : world.buildingAabb.getCenter(new Vector3())),
    [world],
  )
  const texture = getSkyTexture()
  // PARITY RULE (same gate as the boots ground disc): a scene with a host
  // `site` owns its whole presentation — terrain, horizon disc AND sky.
  // The overcast dome COVERED the editor's blue-gradient sky, the single
  // hottest delta on every horizon vantage of the parity harness. No site
  // → the dome stays (it exists for the editor's flat void).
  if (world.site) return null
  if (!texture) return null
  return (
    <mesh
      frustumCulled={false}
      position={[center.x, 0, center.z]}
      renderOrder={-100}
      userData={{ __boots: true }}
    >
      <sphereGeometry args={[RADIUS, 48, 24]} />
      <meshBasicMaterial depthWrite={false} fog={false} map={texture} side={BackSide} toneMapped={false} />
    </mesh>
  )
}
