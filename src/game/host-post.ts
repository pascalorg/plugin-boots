'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useViewer } from '@pascal-app/viewer'
import { useEffect, useRef } from 'react'
import type { Object3D } from 'three'

/**
 * Host post-processing tuning for the session (perf fix 5, 2026-08-29).
 *
 * WHAT THE INVESTIGATION FOUND — the "every frame renders twice" pairing
 * (a ~92k-tri submit before the full multi-million-tri scene submit) is
 * NOT the selection-outline pass:
 *
 *  - The host builds its outline as ONE merged node
 *    (viewer/src/lib/merged-outline-node.ts) fed by the viewer store's
 *    `outliner.selectedObjects` / `outliner.hoveredObjects` arrays, which
 *    the host mutates IN PLACE (use-viewer.ts: "No setter as we will
 *    manipulate directly the arrays"). Its updateBefore has a hard
 *    early-out: both arrays empty and nothing drawn last frame → ZERO
 *    passes, renderer untouched. session.ts already clears the selection
 *    and hover for the whole session, and the editor's outliner sync
 *    (EditorOutlinerSync) empties the arrays in response — a per-render
 *    census on a real scene showed no `MergedOutline [...]` render calls
 *    at all in game. Rebuilding the pipeline to flip `outline` off (the
 *    `?disable=outline` flag is read ONCE at pipeline build,
 *    post-processing.tsx) would pay the multi-second TSL recompile for a
 *    pass that already costs nothing.
 *
 *  - The REAL paired submit is the SHADOW MAP: three's WebGPU ShadowNode
 *    re-renders every shadow-casting light's map EVERY FRAME
 *    (`shadow.needsUpdate || shadow.autoUpdate`, ShadowNode.updateBefore)
 *    and the host never sets `autoUpdate = false` (viewer lights.tsx).
 *    Census on scene 65fbacdc1faf in-game: `Shadow Map [ ID: 22 ]`,
 *    66,654 tris / ~3.1 ms GPU + one full CPU scene traversal, every
 *    frame — for casters that are STATIC during a session (host geometry;
 *    the game's voxel replicas / debris / bots never cast).
 *
 * WHAT THIS MODULE DOES — two cheap, supported, NON-rebuilding levers,
 * engaged on session mount and fully restored on unmount (the effect
 * cleanup runs on GameBoundary crashes too):
 *
 *  1. Shadow throttle: `light.shadow.autoUpdate = false` on every
 *     shadow-casting light (three's documented freeze knob — renderer
 *     state only, no material or pipeline recompile), then
 *     `shadow.needsUpdate = true` every SHADOW_REFRESH_INTERVAL frames so
 *     session-visible caster changes (a wall voxelizing away, a placed
 *     builder piece, the gun table) land within ~1/6–1/3 s. Release
 *     restores each light's previous autoUpdate and forces one resync
 *     render.
 *
 *  2. Outline dormancy guard: snapshot + clear the outliner arrays on
 *     mount and re-clear per frame if anything arms them mid-session
 *     (panel preview-hover, collab writes) — each armed frame would cost
 *     a full-scene depth pre-render plus 13 smaller passes. Same
 *     mutate-in-place idiom the host itself uses (post-processing.tsx
 *     clears these arrays at pipeline build). Restore puts the snapshot
 *     back only if the host hasn't already repopulated, dropping objects
 *     that lost their parent (mirrors the host's sanitizeOutlineObjects).
 *
 * Everything is feature-detected structurally: hosts without the outliner
 * arrays or without `shadow.autoUpdate` degrade to a no-op.
 */

/** Frames between forced shadow-map refreshes while throttled (~10 Hz at
 * 60 fps). 20 was measured first (−3.9 ms mean) but robot shadows visibly
 * stutter-stepped at ~3 Hz during waves; 6 keeps ~83 % of the saving with
 * shadow lag capped at ~0.1 s — imperceptible on moving enemies. */
export const SHADOW_REFRESH_INTERVAL = 6

/** Frames between rescans for late-mounting shadow lights (theme swaps,
 * pooled item lights) — one scene traversal every ~3–5 s. */
export const SHADOW_RESCAN_INTERVAL = 300

/** Structural shape of a throttleable light — feature-detected, never a
 * three class check, so pinned-typing drift can't break older hosts. */
export type ThrottleableLight = {
  castShadow?: boolean
  shadow?: { autoUpdate?: boolean; needsUpdate?: boolean } | null
}

/** Every shadow-casting light under `root` that exposes the standard
 * `shadow.autoUpdate` knob. Lights without it are left alone. */
export function collectShadowLights(root: Object3D): ThrottleableLight[] {
  const out: ThrottleableLight[] = []
  root.traverse((object) => {
    const light = object as Object3D & ThrottleableLight & { isLight?: boolean }
    if (light.isLight !== true || light.castShadow !== true) return
    if (!light.shadow || typeof light.shadow.autoUpdate !== 'boolean') return
    out.push(light)
  })
  return out
}

export type ShadowThrottle = {
  /** Adopt lights: remember their autoUpdate, freeze them, refresh once.
   * Already-adopted lights are untouched (their original value is kept). */
  engage: (lights: ThrottleableLight[]) => void
  /** Per-frame: forces a map refresh every SHADOW_REFRESH_INTERVAL frames. */
  tick: (frame: number) => void
  /** Restore every adopted light's previous autoUpdate + one resync render.
   * Idempotent; lights whose shadow was disposed mid-session are skipped. */
  release: () => void
  /** Lights currently throttled (QA introspection). */
  size: () => number
}

export function createShadowThrottle(interval = SHADOW_REFRESH_INTERVAL): ShadowThrottle {
  const previousAutoUpdate = new Map<ThrottleableLight, boolean>()
  let released = false
  return {
    engage(lights) {
      if (released) return
      for (const light of lights) {
        if (previousAutoUpdate.has(light)) continue
        const shadow = light.shadow
        if (!shadow || typeof shadow.autoUpdate !== 'boolean') continue
        previousAutoUpdate.set(light, shadow.autoUpdate)
        shadow.autoUpdate = false
        // Refresh on adoption so a light frozen between cadence frames never
        // holds a stale map for up to `interval` frames.
        shadow.needsUpdate = true
      }
    },
    tick(frame) {
      if (frame % interval !== 0) return
      for (const light of previousAutoUpdate.keys()) {
        const shadow = light.shadow
        if (shadow) shadow.needsUpdate = true
      }
    },
    release() {
      released = true
      for (const [light, autoUpdate] of previousAutoUpdate) {
        const shadow = light.shadow
        if (!shadow) continue
        shadow.autoUpdate = autoUpdate
        shadow.needsUpdate = true
      }
      previousAutoUpdate.clear()
    },
    size: () => previousAutoUpdate.size,
  }
}

export type OutlinerArrays = {
  selectedObjects: Object3D[]
  hoveredObjects: Object3D[]
}

/** The viewer store's outliner arrays, or null on hosts without them.
 * Structural resolution (same defensive idiom as FrameBooster's
 * renderPaused read) — the plugin's pinned typings may drift from the
 * live host store. */
export function resolveOutliner(store: unknown): OutlinerArrays | null {
  const getState = (store as { getState?: () => unknown } | null | undefined)?.getState
  if (typeof getState !== 'function') return null
  const state = getState() as {
    outliner?: { selectedObjects?: unknown; hoveredObjects?: unknown }
  } | null
  const outliner = state?.outliner
  if (
    !outliner ||
    !Array.isArray(outliner.selectedObjects) ||
    !Array.isArray(outliner.hoveredObjects)
  ) {
    return null
  }
  return outliner as OutlinerArrays
}

export type OutlineGuard = {
  /** Snapshot then empty both arrays (outline pass early-outs from then on). */
  engage: () => void
  /** Per-frame: re-clear if anything armed the arrays mid-session. */
  tick: () => void
  /** Put the snapshot back — only into arrays the host hasn't already
   * repopulated, dropping objects that lost their parent mid-session. */
  release: () => void
  /** How many times tick() found (and cleared) an armed array. */
  clears: () => number
}

export function createOutlineGuard(outliner: OutlinerArrays | null): OutlineGuard {
  const savedSelected: Object3D[] = []
  const savedHovered: Object3D[] = []
  let clears = 0
  return {
    engage() {
      if (!outliner) return
      savedSelected.push(...outliner.selectedObjects)
      savedHovered.push(...outliner.hoveredObjects)
      outliner.selectedObjects.length = 0
      outliner.hoveredObjects.length = 0
    },
    tick() {
      if (!outliner) return
      if (outliner.selectedObjects.length > 0) {
        outliner.selectedObjects.length = 0
        clears++
      }
      if (outliner.hoveredObjects.length > 0) {
        outliner.hoveredObjects.length = 0
        clears++
      }
    },
    release() {
      if (!outliner) return
      if (outliner.selectedObjects.length === 0) {
        for (const object of savedSelected) {
          if (object.parent) outliner.selectedObjects.push(object)
        }
      }
      if (outliner.hoveredObjects.length === 0) {
        for (const object of savedHovered) {
          if (object.parent) outliner.hoveredObjects.push(object)
        }
      }
      savedSelected.length = 0
      savedHovered.length = 0
    },
    clears: () => clears,
  }
}

// --- Live-session debug handle (surfaced on `__boots.hostPost`) --------------

let live: { shadows: ShadowThrottle; outline: OutlineGuard } | null = null

/** Plain-data QA dump: is the tuning active, how many lights are frozen,
 * how often the outline guard had to re-clear. Never live refs. */
export function hostPostDebug(): {
  active: boolean
  shadowLights: number
  outlineClears: number
} {
  return {
    active: live !== null,
    shadowLights: live?.shadows.size() ?? 0,
    outlineClears: live?.outline.clears() ?? 0,
  }
}

/**
 * Session-mounted component (ActiveGame child). Engages both levers on
 * mount, ticks them per frame at default priority (0 — the refresh flag is
 * consumed by the same frame's render at priority 1, and any priority > 0
 * would flip R3F into manual-render mode, see ForeignOverlayHide), and
 * restores everything in the effect cleanup — which also runs when
 * GameBoundary catches a crash and on dev-time remounts.
 */
export function HostPostTuning(): null {
  const scene = useThree((s) => s.scene)
  const frame = useRef(0)
  const controls = useRef<{ shadows: ShadowThrottle; outline: OutlineGuard } | null>(null)

  useEffect(() => {
    const outline = createOutlineGuard(resolveOutliner(useViewer))
    const shadows = createShadowThrottle()
    outline.engage()
    shadows.engage(collectShadowLights(scene))
    controls.current = { shadows, outline }
    live = controls.current
    return () => {
      controls.current = null
      live = null
      shadows.release()
      outline.release()
    }
  }, [scene])

  useFrame(() => {
    const current = controls.current
    if (!current) return
    const f = frame.current++
    current.outline.tick()
    current.shadows.tick(f)
    if (f % SHADOW_RESCAN_INTERVAL === SHADOW_RESCAN_INTERVAL - 1) {
      current.shadows.engage(collectShadowLights(scene))
    }
  })

  return null
}
