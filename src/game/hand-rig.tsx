'use client'

import type { RefObject } from 'react'
import {
  type BufferGeometry,
  CylinderGeometry,
  Euler,
  type Group,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  AVATAR_SKIN_HEX,
  CUFF_HEX,
  fingerSegmentTransforms,
  HAND_POSES,
  type HandPoseId,
  indexChain,
  INDEX_SEGMENTS,
  makeSegments,
  PALM,
  type SegmentXform,
  SLEEVE_HEX,
  WRIST,
} from './hand-pose'
import type { ArmDir, HandSide } from './hand-grips'

/**
 * THE SHARED HAND RENDERER. One procedural hand — palm + four three-segment
 * fingers + a two-segment thumb, from hand-pose.ts — merged into ONE
 * BufferGeometry per (pose, side, options) and cached for the module's life,
 * so a hand is one draw call for the avatar and seven for the first-person
 * right hand (the articulated index is three nested meshes on top of the
 * merged rest). Plain BufferGeometry + MeshStandardMaterial only: WebGPU-safe.
 *
 * The LEFT hand is built by mirroring the right at BUILD time: `scale(−1,1,1)`
 * (three's applyMatrix4 already flips the normals through the normal matrix)
 * and a triangle winding swap so back-face culling still sees the outside.
 * No negative-scale objects ever reach the scene graph.
 */

export const HAND_SKIN = new MeshStandardMaterial({ color: AVATAR_SKIN_HEX, roughness: 0.55 })
export const HAND_SLEEVE = new MeshStandardMaterial({ color: SLEEVE_HEX, roughness: 0.7 })
/** The knit cuff: its own colour so the wrist reads against the sleeve. */
export const HAND_CUFF = new MeshStandardMaterial({ color: CUFF_HEX, roughness: 0.9 })

const _m = new Matrix4()
const _q = new Quaternion()
const _e = new Euler()
const _p = new Vector3()
const _one = new Vector3(1, 1, 1)

/**
 * A finger/thumb segment along −Z from the joint (its origin) to −len: a cone
 * from `r` at the joint to `r1` at the far end, a sphere of radius `joint` AT
 * the origin (the knuckle, or a smooth bend that stays smooth however the next
 * segment turns) and one of radius `tip` at the far end (a rounded fingertip).
 * Zeros leave the spheres out. One sphere per joint — not a capsule per
 * segment, whose two hemispheres met at every bend as a double bead and made
 * the round-1 hand read as a bunch of grapes. Eight radial segments: a whole
 * hand is ≈ 2 k vertices.
 */
const segmentCache = new Map<string, BufferGeometry>()
export function segmentGeometry(len: number, r: number, r1 = r, joint = 0, tip = 0): BufferGeometry {
  const key = `${len}|${r}|${r1}|${joint}|${tip}`
  let g = segmentCache.get(key)
  if (!g) {
    const L = Math.max(0.001, len)
    const parts: BufferGeometry[] = [new CylinderGeometry(r, r1, L, 8, 1).rotateX(Math.PI / 2).translate(0, 0, -L / 2)]
    if (joint > 0) parts.push(new SphereGeometry(joint, 8, 6))
    if (tip > 0) parts.push(new SphereGeometry(tip, 8, 6).translate(0, 0, -L))
    if (parts.length === 1) g = parts[0] as BufferGeometry
    else {
      const merged = mergeGeometries(parts, false)
      if (!merged) throw new Error('hand-rig: segment merge failed')
      for (const p of parts) p.dispose()
      g = merged
    }
    segmentCache.set(key, g)
  }
  return g
}

function placedSegment(seg: SegmentXform): BufferGeometry {
  const g = segmentGeometry(seg.len, seg.r, seg.r1, seg.joint, seg.tip).clone()
  _p.set(seg.px, seg.py, seg.pz)
  _q.setFromEuler(_e.set(seg.rx, seg.ry, seg.rz, 'XYZ'))
  _m.compose(_p, _q, _one)
  g.applyMatrix4(_m)
  return g
}

/** Flip triangle winding in place (after a negative-determinant transform). */
export function flipWinding(geo: BufferGeometry): BufferGeometry {
  const index = geo.getIndex()
  if (index) {
    const a = index.array as Uint16Array | Uint32Array
    for (let i = 0; i + 2 < a.length; i += 3) {
      const t = a[i + 1] as number
      a[i + 1] = a[i + 2] as number
      a[i + 2] = t
    }
    index.needsUpdate = true
  } else {
    const pos = geo.getAttribute('position')
    const arr = pos.array as Float32Array
    const n = pos.itemSize
    for (let i = 0; i + 2 * n < arr.length; i += 3 * n) {
      for (let k = 0; k < n; k++) {
        const t = arr[i + n + k] as number
        arr[i + n + k] = arr[i + 2 * n + k] as number
        arr[i + 2 * n + k] = t
      }
    }
    pos.needsUpdate = true
  }
  return geo
}

export type HandGeometryOptions = {
  /** Leave the index finger out (the articulated chain renders it). */
  articulatedIndex?: boolean
  /** Add the wrist stub behind the palm (first-person only). */
  wrist?: boolean
}

const handCache = new Map<string, BufferGeometry>()
const _segs = makeSegments()

/**
 * The merged, posed hand in the HAND frame (hand-pose.ts header). Cached by
 * pose/side/options; callers never dispose it.
 */
export function buildHandGeometry(pose: HandPoseId, side: HandSide, opts: HandGeometryOptions = {}): BufferGeometry {
  const articulated = !!opts.articulatedIndex
  const wrist = !!opts.wrist
  const key = `${pose}|${side}|${articulated ? 1 : 0}|${wrist ? 1 : 0}`
  const cached = handCache.get(key)
  if (cached) return cached
  const parts: BufferGeometry[] = []
  // RoundedBoxGeometry (r185) is NON-indexed while capsules/cylinders are
  // indexed, and mergeGeometries refuses to mix — index the palm first.
  const rounded = new RoundedBoxGeometry(PALM.t, PALM.w, PALM.l, 2, 0.01)
  const palm = mergeVertices(rounded)
  rounded.dispose()
  palm.translate(PALM.x + PALM.t / 2, 0, 0)
  parts.push(palm)
  if (wrist) {
    // An ellipse across the hand's thickness (x), not a ball behind a slab.
    const w = new CylinderGeometry(WRIST.r0, WRIST.r1, WRIST.len, 12)
    w.rotateX(Math.PI / 2)
    w.scale(WRIST.sx, 1, 1)
    w.translate(WRIST.x, 0, WRIST.z)
    parts.push(w)
  }
  fingerSegmentTransforms(HAND_POSES[pose], _segs)
  for (let i = 0; i < _segs.length; i++) {
    if (articulated && (INDEX_SEGMENTS as readonly number[]).includes(i)) continue
    parts.push(placedSegment(_segs[i] as SegmentXform))
  }
  const merged = mergeGeometries(parts, false)
  for (const p of parts) p.dispose()
  if (!merged) throw new Error('hand-rig: mergeGeometries failed')
  if (side === 'L') {
    merged.scale(-1, 1, 1)
    flipWinding(merged)
  }
  merged.computeBoundingBox()
  merged.computeBoundingSphere()
  handCache.set(key, merged)
  return merged
}

/** One mesh: the whole hand. Avatars use this for both hands. */
export function HandMesh({
  pose,
  side,
  wrist = false,
  scale,
}: {
  pose: HandPoseId
  side: HandSide
  wrist?: boolean
  scale?: number
}) {
  const geo = buildHandGeometry(pose, side, { wrist })
  return <mesh geometry={geo} material={HAND_SKIN} scale={scale} />
}

export type TriggerRefs = readonly [RefObject<Group | null>, RefObject<Group | null>, RefObject<Group | null>]

/**
 * The right hand with a LIVE index finger: the merged rest (no index, with the
 * wrist) plus the nested three-joint chain from `indexChain` — write
 * `rotation.y` on the three refs (LOCAL joint angles: TRIGGER_REST at rest,
 * toward TRIGGER_CURL on a squeeze) and never touch rotation.x (the spread).
 */
export function ArticulatedHand({
  pose,
  side,
  triggerRefs,
}: {
  pose: HandPoseId
  side: HandSide
  triggerRefs: TriggerRefs
}) {
  const rest = buildHandGeometry(pose, side, { articulatedIndex: true, wrist: true })
  const [j0, j1, j2] = indexChain(HAND_POSES[pose])
  const s = side === 'L' ? -1 : 1
  const seg0 = segmentGeometry(j0.len, j0.r, j0.r1, j0.joint, j0.tip)
  const seg1 = segmentGeometry(j1.len, j1.r, j1.r1, j1.joint, j1.tip)
  const seg2 = segmentGeometry(j2.len, j2.r, j2.r1, j2.joint, j2.tip)
  return (
    <>
      <mesh geometry={rest} material={HAND_SKIN} />
      <group ref={triggerRefs[0]} position={[j0.px * s, j0.py, j0.pz]} rotation={[j0.rx, j0.ry * s, 0]}>
        <mesh geometry={seg0} material={HAND_SKIN} />
        <group ref={triggerRefs[1]} position={[0, 0, j1.pz]} rotation={[0, j1.ry * s, 0]}>
          <mesh geometry={seg1} material={HAND_SKIN} />
          <group ref={triggerRefs[2]} position={[0, 0, j2.pz]} rotation={[0, j2.ry * s, 0]}>
            <mesh geometry={seg2} material={HAND_SKIN} />
          </group>
        </group>
      </group>
    </>
  )
}

// ── First-person forearm ─────────────────────────────────────────────────────

/** Wrist joint at the heel (an ellipsoid, squashed like the wrist stub), then
 * the knit CUFF (its own material) and the sleeve running along +Z, WIDENING
 * toward the elbow (cylinder top = +Z after rotateX). Module-shared. */
const WRIST_BALL_GEO = new SphereGeometry(0.023, 10, 8).scale(0.78, 1, 1)
const CUFF_GEO = new CylinderGeometry(0.032, 0.03, 0.045, 12).rotateX(Math.PI / 2)
const SLEEVE_GEO = new CylinderGeometry(0.036, 0.032, 0.3, 12).rotateX(Math.PI / 2)
export const FOREARM_PARTS = {
  ball: { z: 0.0, r: 0.023 },
  cuff: { z: 0.046, len: 0.045, r: 0.032 },
  sleeve: { z: 0.218, len: 0.3, r0: 0.033, r1: 0.036 },
} as const

/**
 * The sleeve leaving a first-person hand toward the shoulder. Mount it at the
 * hand's HEEL point (hand-grips' `heelPoint`) as a SIBLING of the rotated hand
 * group, so it heads where `arm` says regardless of the hand's roll; the ball
 * hides the wrist bend.
 */
export function Forearm({ arm, position }: { arm: ArmDir; position: readonly [number, number, number] }) {
  return (
    <group position={[position[0], position[1], position[2]]} rotation={[arm.pitch, arm.yaw, 0]}>
      <mesh geometry={WRIST_BALL_GEO} material={HAND_SKIN} position={[0, 0, FOREARM_PARTS.ball.z]} />
      <mesh geometry={CUFF_GEO} material={HAND_CUFF} position={[0, 0, FOREARM_PARTS.cuff.z]} />
      <mesh geometry={SLEEVE_GEO} material={HAND_SLEEVE} position={[0, 0, FOREARM_PARTS.sleeve.z]} />
    </group>
  )
}
