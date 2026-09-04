'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  type InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import { sfx, type TreeCrackleHandle } from './audio'
import { spawnDebris } from './debris'
import { spawnDust } from './dust'
import { groundSurfaceY } from './ground'
import { isHordeAuthority } from './horde-sync'
import { scatter, scatterGroundY } from './nature'
import {
  ROAD_RENDER_HALF_LENGTH,
  ROAD_WIDTH,
  roadLocalPoint,
  roadLoopFrame,
} from './road-loop'
import { hideForGame } from './session'
import { registerTreeRoutes } from './shooting'
import { MAX_BLOBS, MAX_TIERS, type TreeParams, treeParamsAt } from './tree-species'
import {
  recordTreeDamage,
  startTreeSync,
  stepTreeSync,
  stopTreeSync,
  TREE_SYNC_CAP,
  type TreeFrame,
  type TreeStateWire,
} from './tree-sync'
import { collectHostForestMeshes, type GameWorld, type HostTreeNode } from './world'

/**
 * Combat trees — the grove is a target class now. Same deterministic
 * scatter (seed/params) nature.tsx used, so the lot looks unchanged, but
 * every tree runs a little destruction state machine:
 *
 *   healthy ── trunk shredded (hp ≤ 0) ──────────────► voxel FELL → stump
 *      │
 *      └── canopy damage ≥ IGNITE ──► burning (crackle + smoke + embers,
 *            canopy color chars over BURN_SECONDS)
 *                 burning ──► charred: the canopy collapses into charcoal
 *            voxels; what's left is a black trunk + bare branch sticks.
 *            Each further hit snaps a branch (charcoal-stick break); after
 *            CHAR_HITS the trunk itself bursts into voxels → stump.
 *
 * SPECIES (2026-08-28): every tree derives a species + full silhouette
 * parameters from its position via tree-species.ts (treeParamsAt — the
 * pure, position-hash-seeded generator), so the grove mixes tiered
 * conifers, blob-crowned broadleaves and tall thin birches with seeded
 * height/crown/lean/bark variation — and a felled birch chars as a birch.
 * Everything is still InstancedMesh: shared UNIT geometries per PART
 * (trunk cylinder, cone tier ×MAX_TIERS slots, crown blob ×MAX_BLOBS
 * slots, branch sticks ×CHAR_HITS+1 — the +1 is the broadleaf bark stub —
 * and stumps: five draw calls for the whole grove); bursts ride the
 * shared debris ring, so a felled tree costs nothing persistent. Raycasts
 * are analytic (vertical trunk cylinder + per-species canopy sphere from
 * params; the 2–4° visual lean is ignored — at crown height that is
 * ≤0.35 m, well inside every crown radius), CPU-only, ~46 trees per shot.
 *
 * REAL host-scene trees join the grove (phase 4): world.hostTrees (scene
 * vegetation nodes — see world.ts isTreeKind / collectHostTrees) are
 * hidden for the session THROUGH THE RESTORE LEDGER ONLY (hideForGame:
 * the per-node registered roots plus the collective forest InstancedMeshes
 * via collectHostForestMeshes — never the scene store; Esc restores them
 * untouched) and replaced by combat trees at the same world transforms
 * (hostTreePlacements: x/z/y base, yaw, scale from node height). Scattered
 * trees landing within HOST_TREE_CLEARANCE of a host tree are dropped so
 * the grove never doubles up (withoutHostOverlap).
 *
 * ── API ────────────────────────────────────────────────────────────────
 *   <TreesDestruct world={world} />  builds the grove for the session
 *       (scattered + host replacements), hides host trees via the restore
 *       ledger, and registers shooting.ts's tree routes on mount (routes
 *       cleared on unmount; visibility restored by exitGame's ledger).
 *   treesDebug.dump()  plain per-tree state for `__boots.trees()`:
 *       { id, nodeId?, x, y, z, scale, species, state, hp, canopyDamage,
 *         burnT, charHits } — nodeId set exactly on host-tree replacements.
 *   Pure helpers exported for tests: buildTreesFrom, raycastTrees,
 *       damageTree, updateBurning, hostTreePlacements, withoutHostOverlap,
 *       charBurstDir (no rendering/sfx inside — the component wraps them
 *       with effects).
 *
 * Char-collapse feel (phase 6): when a burning crown finishes, the leaf
 * shower launches OUTWARD-DOWN (charBurstDir — radial away from the trunk,
 * always falling) in scorched leaf greens with 2–3 ember-orange chunks, a
 * brief kind-guarded 'puff' of dust, sfx.emberCrackle soft pops — and the
 * crackle loop FADES over CRACKLE_FADE_S instead of cutting (fade also
 * stops the handle, freeing its timer; reignition mid-fade re-drives it).
 * Char snaps deepen per successive break on the same tree:
 * sfx.charSnap(CHAR_HITS - charHits - 1) — snap count is derived, no new
 * per-tree state.
 * ───────────────────────────────────────────────────────────────────────
 */

export type TreeState = 'healthy' | 'burning' | 'charred' | 'stump'

export type TreePlacement = {
  x: number
  z: number
  /** Ground/base elevation (m); omitted = 0. Host trees on decks carry it. */
  y?: number
  scale: number
  yaw: number
  /** Canopy rgb 0..1 (bark comes from the species params). */
  color: [number, number, number]
  /** Scene node id when this placement replaces a REAL host tree. */
  nodeId?: string
  /** Species silhouette; omitted = derived from (x, z) via treeParamsAt. */
  params?: TreeParams
}

export type CombatTree = TreePlacement & {
  id: number
  /** Resolved base elevation (placement y, defaulted to 0). */
  y: number
  /** Resolved species silhouette (placement params or position-derived). */
  params: TreeParams
  state: TreeState
  hp: number
  canopyDamage: number
  burnT: number
  charHits: number
}

/** Total hitpoints of a healthy tree (pistol 34 / rifle 24 / minigun 10). */
export const TREE_HP = 70
/** Cumulative CANOPY damage that sets the crown on fire (≈ 2 rifle hits). */
export const IGNITE_CANOPY = 48
/** Seconds from ignition to a fully charred crown. */
export const BURN_SECONDS = 4.5
/** Branch snaps a charred tree takes before the trunk bursts to a stump. */
export const CHAR_HITS = 3

export function buildTreesFrom(placements: TreePlacement[]): CombatTree[] {
  return placements.map((p, id) => ({
    ...p,
    id,
    // No y on the placement = probe the ground (0 on a flat lot, as before).
    y: p.y ?? groundSurfaceY(p.x, p.z),
    params: p.params ?? treeParamsAt(p.x, p.z),
    state: 'healthy' as TreeState,
    hp: TREE_HP,
    canopyDamage: 0,
    burnT: 0,
    charHits: CHAR_HITS,
  }))
}

// --- Host-tree replacement placements --------------------------------------

/** Sanity clamp on host-derived scales (a 60 m sequoia node still spawns a
 * shootable tree; a 0.5 m sapling stays raycastable). */
const HOST_SCALE_MIN = 0.45
const HOST_SCALE_MAX = 2.6
/** Scattered trees this close (m, XZ) to a host tree are dropped — the
 * replacement stands exactly there. */
export const HOST_TREE_CLEARANCE = 1.6

/**
 * Combat placements standing in for the REAL host trees, same world
 * transforms: XZ + base elevation from the node's registered root, yaw from
 * the node, scale from node height (height / the species apex at this
 * position, clamped — the replacement tops out where the host tree did).
 * Hidden-branch trees get no replacement. Species + canopy color come from
 * the position-hash generator, same as the scattered grove.
 */
export function hostTreePlacements(hostTrees: readonly HostTreeNode[]): TreePlacement[] {
  const placements: TreePlacement[] = []
  for (const tree of hostTrees) {
    if (tree.hidden) continue
    const params = treeParamsAt(tree.x, tree.z)
    const scale = Math.min(HOST_SCALE_MAX, Math.max(HOST_SCALE_MIN, tree.height / params.apex))
    placements.push({
      x: tree.x,
      z: tree.z,
      y: tree.y,
      scale,
      yaw: tree.yaw,
      color: params.color,
      nodeId: tree.nodeId,
      params,
    })
  }
  return placements
}

/** Scattered placements minus any landing within HOST_TREE_CLEARANCE (XZ)
 * of a host tree — the replacement owns that spot. */
export function withoutHostOverlap(
  placements: TreePlacement[],
  hostTrees: readonly HostTreeNode[],
): TreePlacement[] {
  if (hostTrees.length === 0) return placements
  const clearanceSq = HOST_TREE_CLEARANCE * HOST_TREE_CLEARANCE
  return placements.filter((p) => {
    for (const tree of hostTrees) {
      const dx = p.x - tree.x
      const dz = p.z - tree.z
      if (dx * dx + dz * dz < clearanceSq) return false
    }
    return true
  })
}

export type TreePart = 'trunk' | 'canopy'

export type TreeHit = {
  distance: number
  point: Vector3
  treeId: number
  part: TreePart
}

const _hitPoint = new Vector3()

/**
 * Nearest live tree part along the ray. Trunk = finite vertical cylinder;
 * canopy = sphere for blob species, vertical capped cylinder (skirt→apex,
 * widest tier as radius) for conifers — see the crownCY/crownR doc in
 * tree-species.ts for why the old conifer bounding sphere ate shots beside
 * the crown. Stumps don't block shots. Allocation-free except the returned
 * hit (one small object per SUCCESSFUL shot, not per tree).
 */
export function raycastTrees(
  trees: CombatTree[],
  origin: Vector3,
  direction: Vector3,
  maxDist: number,
): TreeHit | null {
  let bestDist = maxDist
  let bestTree = -1
  let bestPart: TreePart = 'trunk'
  for (const tree of trees) {
    if (tree.state === 'stump') continue
    const s = tree.scale
    const p = tree.params
    // Trunk: infinite cylinder about (x, z), then clamp hit height.
    {
      const r = p.trunkR * s
      const ox = origin.x - tree.x
      const oz = origin.z - tree.z
      const dx = direction.x
      const dz = direction.z
      const a = dx * dx + dz * dz
      if (a > 1e-8) {
        const b = ox * dx + oz * dz
        const c = ox * ox + oz * oz - r * r
        const disc = b * b - a * c
        if (disc >= 0) {
          const t = (-b - Math.sqrt(disc)) / a
          if (t > 0 && t < bestDist) {
            const y = origin.y + direction.y * t - tree.y
            if (y >= 0 && y <= p.trunkH * s) {
              bestDist = t
              bestTree = tree.id
              bestPart = 'trunk'
            }
          }
        }
      }
    }
    // Canopy — only while the crown exists (burned crowns are gone).
    if (tree.state !== 'charred') {
      const r = p.crownR * s
      if (p.tiers.length > 0) {
        // Conifer capped cylinder on the trunk axis, skirt→apex: wall hits
        // clamp to the y-range, the ends are FLAT discs — the stack sits on
        // a flat skirt (a sphere cap would bulge a whole tier radius below
        // it and eat trunk shots) and the apex tapers to a point. First
        // boundary from outside is the wall inside the range or a disc, so
        // testing all three and keeping the smallest t is exact for
        // entering rays.
        const y0 = tree.y + p.tiers[0]!.y * s
        const y1 = tree.y + p.apex * s
        const ox = origin.x - tree.x
        const oz = origin.z - tree.z
        let t = -1
        const a = direction.x * direction.x + direction.z * direction.z
        if (a > 1e-8) {
          const b = ox * direction.x + oz * direction.z
          const c = ox * ox + oz * oz - r * r
          const disc = b * b - a * c
          if (disc >= 0) {
            const tc = (-b - Math.sqrt(disc)) / a
            if (tc > 0) {
              const y = origin.y + direction.y * tc
              if (y >= y0 && y <= y1) t = tc
            }
          }
        }
        if (Math.abs(direction.y) > 1e-8) {
          const invDy = 1 / direction.y
          for (let cap = 0; cap < 2; cap++) {
            const ts = ((cap === 0 ? y0 : y1) - origin.y) * invDy
            if (ts > 0 && (t < 0 || ts < t)) {
              const hx = ox + direction.x * ts
              const hz = oz + direction.z * ts
              if (hx * hx + hz * hz <= r * r) t = ts
            }
          }
        }
        if (t > 0 && t < bestDist) {
          bestDist = t
          bestTree = tree.id
          bestPart = 'canopy'
        }
      } else {
        const cx = origin.x - tree.x
        const cy = origin.y - (tree.y + p.crownCY * s)
        const cz = origin.z - tree.z
        const b = cx * direction.x + cy * direction.y + cz * direction.z
        const c = cx * cx + cy * cy + cz * cz - r * r
        const disc = b * b - c
        if (disc >= 0) {
          const t = -b - Math.sqrt(disc)
          if (t > 0 && t < bestDist) {
            bestDist = t
            bestTree = tree.id
            bestPart = 'canopy'
          }
        }
      }
    }
  }
  if (bestTree < 0) return null
  _hitPoint.copy(origin).addScaledVector(direction, bestDist)
  const tree = trees[bestTree]!
  return { distance: bestDist, point: _hitPoint.clone(), treeId: tree.id, part: bestPart }
}

export type TreeDamageEvent =
  | 'none' // stump — nothing to do
  | 'chip' // splinters/leaves, no state change
  | 'ignite' // canopy caught fire
  | 'fell' // whole tree bursts to voxels → stump
  | 'charHit' // charred: one branch snapped off
  | 'collapse' // charred trunk broke to voxels → stump

/**
 * Apply one hit. Pure state machine — the component layers voxel bursts,
 * dust and sfx on the returned event. Trunk fire fells; canopy fire
 * ignites (then keeps hurting the tree, so burning trees can still be
 * shot down early).
 */
export function damageTree(tree: CombatTree, part: TreePart, damage: number): TreeDamageEvent {
  if (tree.state === 'stump') return 'none'
  if (tree.state === 'charred') {
    tree.charHits -= 1
    if (tree.charHits <= 0) {
      tree.state = 'stump'
      return 'collapse'
    }
    return 'charHit'
  }
  tree.hp -= damage
  if (tree.hp <= 0) {
    tree.state = 'stump'
    return 'fell'
  }
  if (tree.state === 'healthy' && part === 'canopy') {
    tree.canopyDamage += damage
    if (tree.canopyDamage >= IGNITE_CANOPY) {
      tree.state = 'burning'
      tree.burnT = 0
      return 'ignite'
    }
  }
  return 'chip'
}

/**
 * Advance every burning tree by dt; crowns that finish charring flip to
 * 'charred' and their ids are appended to `out` (caller bursts the canopy).
 * Returns how many trees are still burning.
 */
export function updateBurning(trees: CombatTree[], dt: number, out: number[]): number {
  let burning = 0
  for (const tree of trees) {
    if (tree.state !== 'burning') continue
    tree.burnT += dt
    if (tree.burnT >= BURN_SECONDS) {
      tree.state = 'charred'
      tree.charHits = CHAR_HITS
      out.push(tree.id)
    } else {
      burning++
    }
  }
  return burning
}

// --- Session singleton the routes + debug dump read -----------------------

let liveTrees: CombatTree[] = []
let revision = 0
const _ramPoint = new Vector3()

/** Fell every live trunk touched by a vehicle-sized XZ circle. The regular
 * damage wrapper owns debris, dust, sound and renderer revision, so ramming a
 * tree looks exactly like finishing it with a weapon instead of silently
 * deleting an instance. Returns the number newly felled. */
export function ramTreesAt(x: number, z: number, radius: number, damage = TREE_HP * 2): number {
  if (!isHordeAuthority()) return 0
  let felled = 0
  for (const tree of liveTrees) {
    if (tree.state === 'stump') continue
    const reach = radius + Math.max(0.18, tree.params.trunkR * tree.scale)
    const dx = tree.x - x
    const dz = tree.z - z
    if (dx * dx + dz * dz > reach * reach) continue
    _ramPoint.set(tree.x, tree.y + Math.min(1.1, tree.params.trunkH * tree.scale * 0.45), tree.z)
    let event = applyTreeDamage(
      liveTrees,
      { distance: Math.hypot(dx, dz), point: _ramPoint, treeId: tree.id, part: 'trunk' },
      damage,
    )
    // Charred trunks normally fall over three dramatic branch snaps. A truck
    // impact completes that short state machine immediately.
    while (event === 'charHit') {
      event = applyTreeDamage(
        liveTrees,
        { distance: 0, point: _ramPoint, treeId: tree.id, part: 'trunk' },
        damage,
      )
    }
    if (event === 'fell' || event === 'collapse') felled++
  }
  return felled
}

export const treesDebug = {
  dump: (): Array<Record<string, unknown>> =>
    liveTrees.map((t) => ({
      id: t.id,
      nodeId: t.nodeId,
      x: t.x,
      y: t.y,
      z: t.z,
      scale: t.scale,
      species: t.params.species,
      state: t.state,
      hp: t.hp,
      canopyDamage: t.canopyDamage,
      burnT: t.burnT,
      charHits: t.charHits,
    })),
}

// --- Effects (voxel bursts, dust, sfx) — component/route side -------------

const CHARCOAL = new Color('#2b2724')
const EMBER = new Color('#e8703a')
const _burstColor = new Color()
const _canopyColor = new Color()

/** Seconds the burning-crackle loop fades once the last crown finishes. */
export const CRACKLE_FADE_S = 0.6
/** Ember-orange debris chunks mixed into each char-collapse leaf shower. */
const CHAR_EMBER_MIN = 2 // + 0..1 more at random → 2–3

/**
 * Launch direction for one char-collapse leaf voxel: OUTWARD along the
 * radial angle `theta` (the voxel's own bearing from the trunk) and DOWN.
 * `down` 0..1 biases the fall steeper (y −0.45 → −0.85); the result is
 * unit length by construction. Pure + exported for tests; the component
 * feeds it a reused out-object (no hot-loop allocation).
 */
export function charBurstDir(
  theta: number,
  down: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const dy = -(0.45 + 0.4 * Math.min(1, Math.max(0, down)))
  const h = Math.sqrt(1 - dy * dy)
  out.x = Math.cos(theta) * h
  out.y = dy
  out.z = Math.sin(theta) * h
  return out
}

const _charDir = { x: 0, y: 0, z: 0 }

const _canopyPoint = { x: 0, y: 0, z: 0 }

/**
 * Random point inside the tree's canopy volume for burst voxels — matches
 * the raycast shapes so debris never spawns in air the crown doesn't fill:
 * blob species sample the crown sphere, conifers pick a cone tier and
 * sample its disc band (the old crownR sphere put voxels a metre outside
 * tall pines). theta is passed in so char bursts can reuse the bearing for
 * their radial launch direction.
 */
function canopyBurstPoint(
  tree: CombatTree,
  theta: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const s = tree.scale
  const p = tree.params
  if (p.tiers.length > 0) {
    const tier = p.tiers[Math.floor(Math.random() * p.tiers.length)]!
    const radial = tier.r * s * Math.sqrt(Math.random())
    out.x = tree.x + Math.cos(theta) * radial
    out.y = tree.y + (tier.y + Math.random() * tier.h) * s
    out.z = tree.z + Math.sin(theta) * radial
    return out
  }
  const r = p.crownR * s * Math.cbrt(Math.random())
  const u = Math.random() * 2 - 1
  const h = Math.sqrt(1 - u * u)
  out.x = tree.x + Math.cos(theta) * h * r
  out.y = tree.y + p.crownCY * s + u * r
  out.z = tree.z + Math.sin(theta) * h * r
  return out
}

/**
 * Char-collapse shower — the burnt crown lets go. Unlike burstCanopy's
 * omni fell burst, every voxel launches outward-down along its own radial
 * bearing (charBurstDir), so the crown visibly SHEDS. Colors are the
 * tree's leaf green scorched partway to charcoal, with 2–3 ember-orange
 * chunks glowing in the fall.
 */
function burstCanopyChar(tree: CombatTree): void {
  const s = tree.scale
  const n = 26
  const embers = CHAR_EMBER_MIN + (Math.random() < 0.5 ? 1 : 0)
  for (let i = 0; i < n; i++) {
    // Positions are random, so ember slots can be the first indices.
    if (i < embers) _burstColor.copy(EMBER)
    else {
      _burstColor
        .setRGB(tree.color[0], tree.color[1], tree.color[2])
        .lerp(CHARCOAL, 0.2 + Math.random() * 0.3)
    }
    const theta = Math.random() * Math.PI * 2
    charBurstDir(theta, Math.random(), _charDir)
    canopyBurstPoint(tree, theta, _canopyPoint)
    spawnDebris(
      _canopyPoint.x,
      _canopyPoint.y,
      _canopyPoint.z,
      (0.1 + Math.random() * 0.07) * s,
      _burstColor,
      1.6,
      2.2,
      _charDir,
    )
  }
}

/** Voxel burst filling the canopy volume — the "becomes voxels" collapse. */
function burstCanopy(tree: CombatTree, charcoal: boolean): void {
  const s = tree.scale
  const n = 26
  for (let i = 0; i < n; i++) {
    if (charcoal) _burstColor.copy(CHARCOAL)
    else _burstColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
    canopyBurstPoint(tree, Math.random() * Math.PI * 2, _canopyPoint)
    spawnDebris(
      _canopyPoint.x,
      _canopyPoint.y,
      _canopyPoint.z,
      (0.11 + Math.random() * 0.08) * s,
      _burstColor,
      1.1,
      2.4,
    )
  }
}

/** Voxel burst along the trunk (bark or charcoal), sparing the stump. */
function burstTrunk(tree: CombatTree, charcoal: boolean): void {
  const s = tree.scale
  const n = 12
  for (let i = 0; i < n; i++) {
    if (charcoal) _burstColor.copy(CHARCOAL)
    else _burstColor.setRGB(tree.params.bark[0], tree.params.bark[1], tree.params.bark[2])
    const y = tree.y + (0.35 + ((tree.params.trunkH - 0.35) * i) / n) * s
    spawnDebris(
      tree.x + (Math.random() - 0.5) * 0.3 * s,
      y,
      tree.z + (Math.random() - 0.5) * 0.3 * s,
      (0.09 + Math.random() * 0.06) * s,
      _burstColor,
      0.9,
      2.2,
    )
  }
}

const _dustPos = new Vector3()
const PUFF = { kind: 'puff' } as const

/** Route-side damage wrapper: state machine + all the audiovisual fallout. */
function applyTreeDamage(trees: CombatTree[], hit: TreeHit, damage: number): TreeDamageEvent {
  const tree = trees[hit.treeId]
  if (!tree) return 'none'
  const wasBurning = tree.state === 'burning'
  const event = damageTree(tree, hit.part, damage)
  switch (event) {
    case 'chip': {
      // Splinters/leaf voxels at the impact, in the part's color (a birch
      // trunk chips pale, a pine chips brown — bark rides the species).
      if (hit.part === 'canopy') _burstColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      else if (wasBurning) _burstColor.copy(CHARCOAL)
      else _burstColor.setRGB(tree.params.bark[0], tree.params.bark[1], tree.params.bark[2])
      for (let i = 0; i < 3; i++) {
        spawnDebris(hit.point.x, hit.point.y, hit.point.z, 0.06, _burstColor, 1.3, 1.4)
      }
      sfx.voxelCrunch(0.25)
      break
    }
    case 'ignite': {
      _dustPos.set(tree.x, tree.y + tree.params.crownCY * tree.scale, tree.z)
      spawnDust(_dustPos, 0.7, PUFF)
      sfx.voxelCrunch(0.35)
      revision++
      break
    }
    case 'fell': {
      burstCanopy(tree, wasBurning)
      burstTrunk(tree, wasBurning)
      _dustPos.set(tree.x, tree.y + 1.2 * tree.scale, tree.z)
      spawnDust(_dustPos, 0.9, PUFF)
      if (wasBurning) sfx.charSnap()
      sfx.woodCrumble(0.7)
      revision++
      break
    }
    case 'charHit': {
      for (let i = 0; i < 4; i++) {
        spawnDebris(hit.point.x, hit.point.y, hit.point.z, 0.07, CHARCOAL, 1.5, 1.6)
      }
      // Successive snaps on the SAME tree land deeper: prior snap count is
      // derived from charHits (post-decrement) — 0 on the first break.
      sfx.charSnap(CHAR_HITS - tree.charHits - 1)
      revision++
      break
    }
    case 'collapse': {
      burstTrunk(tree, true)
      _dustPos.set(tree.x, tree.y + 1 * tree.scale, tree.z)
      spawnDust(_dustPos, 0.7, PUFF)
      // charHits is 0 here — the deepest snap in the tree's run.
      sfx.charSnap(CHAR_HITS - 1)
      sfx.woodCrumble(0.5)
      revision++
      break
    }
    case 'none':
      break
  }
  return event
}

function applySharedTreeDamage(trees: CombatTree[], hit: TreeHit, damage: number): TreeDamageEvent {
  const event = applyTreeDamage(trees, hit, damage)
  recordTreeDamage(hit.treeId, hit.part, damage)
  return event
}

const TREE_STATE_TO_WIRE: Record<TreeState, TreeStateWire> = {
  healthy: 0,
  burning: 1,
  charred: 2,
  stump: 3,
}
const TREE_WIRE_TO_STATE: readonly TreeState[] = ['healthy', 'burning', 'charred', 'stump']

function snapshotTrees(trees: readonly CombatTree[]): TreeFrame {
  const t: TreeFrame['t'] = []
  for (let i = 0; i < trees.length && i < TREE_SYNC_CAP; i++) {
    const tree = trees[i]!
    t.push([
      tree.id,
      TREE_STATE_TO_WIRE[tree.state],
      Math.round(tree.hp * 100) / 100,
      Math.round(tree.canopyDamage * 100) / 100,
      Math.round(tree.burnT * 100) / 100,
      tree.charHits,
    ])
  }
  return {
    v: 1,
    t,
  }
}

function applyTreeSnapshot(trees: CombatTree[], frame: TreeFrame): void {
  for (const [id, stateCode, hp, canopyDamage, burnT, charHits] of frame.t) {
    const tree = trees[id]
    if (!tree) continue
    const state = TREE_WIRE_TO_STATE[stateCode]!
    if (tree.state !== state || tree.charHits !== charHits) revision++
    tree.state = state
    tree.hp = hp
    tree.canopyDamage = canopyDamage
    tree.burnT = burnT
    tree.charHits = charHits
  }
}

// --- Rendering -------------------------------------------------------------

const _matrix = new Matrix4()
const _treeMatrix = new Matrix4()
const _local = new Matrix4()
const _pos = new Vector3()
const _quat = new Quaternion()
const _leanQuat = new Quaternion()
const _quatIdentity = new Quaternion()
const _scaleV = new Vector3()
const _yAxis = new Vector3(0, 1, 0)
const _leanAxis = new Vector3()
const ZERO = new Matrix4().makeScale(0, 0, 0)
/** Branch stick orientations for charred crowns (tilt out + around). */
const BRANCH_YAWS = [0.3, 2.4, 4.5]
/** Branch-mesh slots per tree: CHAR_HITS charcoal sticks + 1 bark stub. */
export const BRANCH_SLOTS = CHAR_HITS + 1

/** Whole-tree world matrix: position × (yaw ∘ 2–4° lean) × uniform scale.
 * Every part multiplies its LOCAL offset/dims against this, so crowns and
 * stubs lean with their trunk. */
function composeTreeMatrix(tree: CombatTree): Matrix4 {
  const p = tree.params
  _pos.set(tree.x, tree.y, tree.z)
  _quat.setFromAxisAngle(_yAxis, tree.yaw)
  _leanAxis.set(Math.cos(p.leanDir), 0, Math.sin(p.leanDir))
  _leanQuat.setFromAxisAngle(_leanAxis, p.lean)
  _quat.multiply(_leanQuat)
  _scaleV.setScalar(tree.scale)
  return _treeMatrix.compose(_pos, _quat, _scaleV)
}

/** Part matrix: tree matrix × local(translate, optional yaw, dims). */
function setPartMatrix(
  mesh: InstancedMesh,
  slot: number,
  tree: Matrix4,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  yaw = 0,
): void {
  _pos.set(x, y, z)
  if (yaw !== 0) _leanQuat.setFromAxisAngle(_yAxis, yaw)
  _scaleV.set(sx, sy, sz)
  _matrix.multiplyMatrices(tree, _local.compose(_pos, yaw !== 0 ? _leanQuat : _quatIdentity, _scaleV))
  mesh.setMatrixAt(slot, _matrix)
}

type TreeMeshes = {
  trunks: InstancedMesh | null
  cones: InstancedMesh | null
  blobs: InstancedMesh | null
  branches: InstancedMesh | null
  stumps: InstancedMesh | null
}

/** Rebuild every instance matrix/color from tree states (runs on revision
 * bumps only — burning color animation is the frame loop's job). */
function syncInstances(trees: CombatTree[], meshes: TreeMeshes): void {
  const { trunks, cones, blobs, branches, stumps } = meshes
  if (!trunks || !cones || !blobs || !branches || !stumps) return
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i]!
    const p = tree.params
    const s = tree.scale
    const crownUp = tree.state === 'healthy' || tree.state === 'burning'
    const world = composeTreeMatrix(tree)
    // Trunk stands until the tree is a stump; charred trunks go black.
    if (tree.state === 'stump') trunks.setMatrixAt(i, ZERO)
    else setPartMatrix(trunks, i, world, 0, 0, 0, p.trunkR, p.trunkH, p.trunkR)
    if (tree.state === 'charred') trunks.setColorAt(i, CHARCOAL)
    else trunks.setColorAt(i, _canopyColor.setRGB(p.bark[0], p.bark[1], p.bark[2]))
    // Conifer cone tiers — radii shrink up the stack, tint lightens a touch.
    for (let k = 0; k < MAX_TIERS; k++) {
      const j = i * MAX_TIERS + k
      const tier = p.tiers[k]
      if (crownUp && tier) setPartMatrix(cones, j, world, 0, tier.y, 0, tier.r, tier.h, tier.r)
      else cones.setMatrixAt(j, ZERO)
      // Color EVERY slot, not just live ones: the mount-time sync must
      // create instanceColor before the WebGPU pipeline first compiles, or
      // parts that appear mid-session render white (wiring, 2026-08-25).
      _canopyColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      cones.setColorAt(j, _canopyColor.multiplyScalar(1 + 0.05 * k))
    }
    // Broadleaf/birch crown blobs (slightly squashed spheres).
    for (let k = 0; k < MAX_BLOBS; k++) {
      const j = i * MAX_BLOBS + k
      const blob = p.blobs[k]
      if (crownUp && blob) {
        setPartMatrix(blobs, j, world, blob.x, blob.y, blob.z, blob.r, blob.r * 0.85, blob.r)
      } else blobs.setMatrixAt(j, ZERO)
      _canopyColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      blobs.setColorAt(j, _canopyColor.multiplyScalar(k === 0 ? 1 : 0.95 + 0.09 * k))
    }
    // Branch sticks: CHAR_HITS bare charcoal branches on charred trees
    // (one hides per snap taken) + the broadleaf bark stub while standing.
    for (let b = 0; b < CHAR_HITS; b++) {
      const j = i * BRANCH_SLOTS + b
      if (tree.state === 'charred' && b < tree.charHits) {
        setPartMatrix(branches, j, world, 0, p.trunkH - 0.25, 0, 1, 1, 1, BRANCH_YAWS[b]!)
      } else branches.setMatrixAt(j, ZERO)
      branches.setColorAt(j, CHARCOAL)
    }
    {
      const j = i * BRANCH_SLOTS + CHAR_HITS
      if (p.stub && tree.state !== 'stump') {
        setPartMatrix(branches, j, world, 0, p.stub.y, 0, 1.9, 0.62, 1.9, p.stub.yaw)
      } else branches.setMatrixAt(j, ZERO)
      if (tree.state === 'charred') branches.setColorAt(j, CHARCOAL)
      else branches.setColorAt(j, _canopyColor.setRGB(p.bark[0], p.bark[1], p.bark[2]))
    }
    // Stump appears the moment the tree above it is gone (kept upright —
    // it reads as the cut base, so the lean stays with the felled tree).
    if (tree.state === 'stump') {
      _pos.set(tree.x, tree.y, tree.z)
      _leanQuat.setFromAxisAngle(_yAxis, tree.yaw)
      _scaleV.set(p.trunkR * 1.25 * s, 0.35 * s, p.trunkR * 1.25 * s)
      stumps.setMatrixAt(i, _matrix.compose(_pos, _leanQuat, _scaleV))
    } else stumps.setMatrixAt(i, ZERO)
    stumps.setColorAt(i, _canopyColor.setRGB(p.bark[0], p.bark[1], p.bark[2]))
  }
  trunks.instanceMatrix.needsUpdate = true
  cones.instanceMatrix.needsUpdate = true
  blobs.instanceMatrix.needsUpdate = true
  branches.instanceMatrix.needsUpdate = true
  stumps.instanceMatrix.needsUpdate = true
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true
  if (cones.instanceColor) cones.instanceColor.needsUpdate = true
  if (blobs.instanceColor) blobs.instanceColor.needsUpdate = true
  if (branches.instanceColor) branches.instanceColor.needsUpdate = true
  if (stumps.instanceColor) stumps.instanceColor.needsUpdate = true
}

/** Same grove layout as ever (seed 23, 46 trees, ring 12–60 m) — species
 * and color now come from the position-hash generator at each spot. */
function treePlacements(world: GameWorld): TreePlacement[] {
  const placements: TreePlacement[] = []
  scatter(world, 23, 46, 12, 60, (rand, position) => {
    const yaw = rand() * Math.PI * 2
    const scale = 0.8 + rand() * 0.9
    const params = treeParamsAt(position.x, position.z)
    // scatter() drapes `position` onto the lot surface — KEEP the y. Throwing
    // it away planted the grove on the lot plane while the grass around it
    // followed the dirt: trunks buried on a rise, floating over a dip.
    placements.push({
      x: position.x,
      y: position.y,
      z: position.z,
      scale,
      yaw,
      color: params.color,
      params,
    })
    return _canopyColor.setRGB(params.color[0], params.color[1], params.color[2]).clone()
  })
  // The long road gets two deterministic rows of trees. They join the SAME
  // five instanced combat meshes and tree-sync state as the near grove, so
  // extending the landscape adds no draw calls and a remote truck fells the
  // same roadside tree for every player. Keep a broad clear bay around the
  // initial tractor/trailer and reject the authored building footprint.
  const road = roadLoopFrame(world)
  const building = world.buildingAabb
  // 24 divides the 840 m wrap period exactly, so spacing continues across
  // the seam instead of betraying the teleport with one oversized gap.
  for (let along = -408; along <= 408; along += 24) {
    if (Math.abs(along) < 30) continue
    for (const side of [-1, 1]) {
      const hash = Math.abs(Math.sin(along * 12.9898 + side * 78.233))
      const across = side * (ROAD_WIDTH / 2 + 5.2 + hash * 3.8)
      const p = roadLocalPoint(road, along, across)
      if (
        !building.isEmpty() &&
        p.x > building.min.x - 2 &&
        p.x < building.max.x + 2 &&
        p.z > building.min.z - 2 &&
        p.z < building.max.z + 2
      ) continue
      const params = treeParamsAt(p.x, p.z)
      placements.push({
        x: p.x,
        y: scatterGroundY(world, p.x, p.z),
        z: p.z,
        scale: 0.75 + hash * 0.8,
        yaw: hash * Math.PI * 2,
        color: params.color,
        params,
      })
    }
  }
  return placements
}

const _finishedBurning: number[] = []
const _flickerColor = new Color()

export function TreesDestruct({
  world,
  spectator = false,
}: {
  world: GameWorld
  /** Receive and draw shared tree state without becoming a simulator. */
  spectator?: boolean
}) {
  const scene = useThree((s) => s.scene)
  const trees = useMemo(() => {
    const host = world.hostTrees ?? []
    return buildTreesFrom([
      ...withoutHostOverlap(treePlacements(world), host),
      // The editor already draws its authored trees. Gameplay replaces them
      // with destructible instances; the overview keeps the originals and
      // adds only Boots' deterministic grove, avoiding double trunks.
      ...(spectator ? [] : hostTreePlacements(host)),
    ])
  }, [world, spectator])

  // UNIT geometries — every dimension lives in the instance matrices, so
  // one geometry per PART serves all species (5 draw calls total).
  const trunkGeometry = useMemo(
    () => new CylinderGeometry(0.72, 1, 1, 7).translate(0, 0.5, 0),
    [],
  )
  const coneGeometry = useMemo(() => new ConeGeometry(1, 1, 8).translate(0, 0.5, 0), [])
  const blobGeometry = useMemo(() => new IcosahedronGeometry(1, 1), [])
  // A branch: thin stick leaning out from its local origin (charcoal snaps
  // at unit scale; the broadleaf bark stub reuses it fattened + shortened).
  const branchGeometry = useMemo(() => {
    const g = new BoxGeometry(0.055, 1.15, 0.055)
    g.translate(0, 0.5, 0)
    g.rotateZ(0.55)
    return g
  }, [])
  const stumpGeometry = useMemo(() => new CylinderGeometry(0.9, 1.1, 1, 7).translate(0, 0.5, 0), [])

  const trunksRef = useRef<InstancedMesh>(null)
  const conesRef = useRef<InstancedMesh>(null)
  const blobsRef = useRef<InstancedMesh>(null)
  const branchesRef = useRef<InstancedMesh>(null)
  const stumpsRef = useRef<InstancedMesh>(null)
  const seenRevision = useRef(-1)
  const crackle = useRef<TreeCrackleHandle | null>(null)
  /** Intensity the crackle held while fires burned — the fade's start level. */
  const crackleLevel = useRef(0)
  /** Seconds left of the post-fire crackle fade (CRACKLE_FADE_S → 0). */
  const crackleFade = useRef(0)
  const smokeClock = useRef(0)

  useEffect(() => {
    // Host trees leave the stage for the session: hide the per-node
    // registered roots (selection proxies — they mount real geometry while
    // hovered/selected) AND the collective forest InstancedMeshes, all
    // through the restore ledger — exitGame flips every visibility back,
    // the scene store is never written. hideForGame skips already-hidden
    // objects, so effect re-runs (world refresh, Fast Refresh) are safe.
    const host = world.hostTrees ?? []
    if (!spectator && host.length > 0) {
      for (const tree of host) hideForGame(tree.root)
      for (const mesh of collectHostForestMeshes(scene, host)) hideForGame(mesh)
    }

    liveTrees = trees
    revision++
    startTreeSync(
      {
        snapshot: () => snapshotTrees(trees),
        applySnapshot: (frame) => applyTreeSnapshot(trees, frame),
        applyDamage: (treeId, part, damage) => {
          const tree = trees[treeId]
          if (!tree) return
          const y = part === 'canopy'
            ? tree.y + tree.params.crownCY * tree.scale
            : tree.y + tree.params.trunkH * tree.scale * 0.45
          _ramPoint.set(tree.x, y, tree.z)
          applyTreeDamage(trees, { distance: 0, point: _ramPoint, treeId, part }, damage)
        },
        pristine: () => trees.every((tree) => tree.state === 'healthy' && tree.hp === TREE_HP),
      },
      { receiveOnly: spectator },
    )
    if (!spectator) {
      registerTreeRoutes<TreeHit>({
        raycast: (origin, direction, maxDist) => raycastTrees(trees, origin, direction, maxDist),
        damage: (_world, hit, damage) => applySharedTreeDamage(trees, hit, damage),
      })
    }
    return () => {
      stopTreeSync()
      registerTreeRoutes(null)
      if (liveTrees === trees) liveTrees = []
      crackle.current?.stop()
      crackle.current = null
    }
  }, [trees, world, scene, spectator])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 30)
    stepTreeSync(dt)

    // Burn progress → charred transitions (canopy collapses into voxels).
    _finishedBurning.length = 0
    const burningCount = updateBurning(trees, dt, _finishedBurning)
    for (const id of _finishedBurning) {
      const tree = trees[id]!
      // The crown SHEDS: outward-down leaf shower with ember chunks, one
      // brief kind-guarded dust puff, and soft ember pops under the snap.
      burstCanopyChar(tree)
      _dustPos.set(tree.x, tree.y + tree.params.crownCY * tree.scale, tree.z)
      spawnDust(_dustPos, 0.55, PUFF)
      sfx.charSnap()
      sfx.emberCrackle()
      revision++
    }

    // Crackle loop follows how much of the grove is on fire; when the last
    // crown finishes it FADES over CRACKLE_FADE_S (then stops, freeing the
    // handle's timer) instead of cutting. Reignition mid-fade re-drives it.
    if (burningCount > 0) {
      if (!crackle.current) crackle.current = sfx.treeCrackle()
      crackleLevel.current = Math.min(1, burningCount / 3)
      crackleFade.current = CRACKLE_FADE_S
      crackle.current.setIntensity(crackleLevel.current)
    } else if (crackle.current) {
      crackleFade.current -= dt
      if (crackleFade.current <= 0) {
        crackle.current.stop()
        crackle.current = null
      } else {
        crackle.current.setIntensity(crackleLevel.current * (crackleFade.current / CRACKLE_FADE_S))
      }
    }

    // Structural sync only when something changed.
    if (seenRevision.current !== revision) {
      seenRevision.current = revision
      syncInstances(trees, {
        trunks: trunksRef.current,
        cones: conesRef.current,
        blobs: blobsRef.current,
        branches: branchesRef.current,
        stumps: stumpsRef.current,
      })
    }

    if (burningCount === 0) return

    // Burning crowns: color chars green → ember → charcoal, and every
    // ~0.35s each fire sheds one smoke puff + the odd ember chunk. The
    // flicker paints whichever part set the species' crown wears — cone
    // tier slots for conifers, blob slots for broadleaf/birch.
    const cones = conesRef.current
    const blobs = blobsRef.current
    smokeClock.current += dt
    const smoke = smokeClock.current >= 0.35
    if (smoke) smokeClock.current = 0
    let conesDirty = false
    let blobsDirty = false
    for (const tree of trees) {
      if (tree.state !== 'burning') continue
      const p = tree.params
      const t = tree.burnT / BURN_SECONDS
      _flickerColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      if (t < 0.35) _flickerColor.lerp(EMBER, t / 0.35)
      else _flickerColor.copy(EMBER).lerp(CHARCOAL, (t - 0.35) / 0.65)
      // Fire flicker on top of the char ramp.
      _flickerColor.lerp(EMBER, Math.random() * 0.25)
      if (p.tiers.length > 0) {
        for (let k = 0; k < p.tiers.length; k++) cones?.setColorAt(tree.id * MAX_TIERS + k, _flickerColor)
        conesDirty = true
      }
      if (p.blobs.length > 0) {
        for (let k = 0; k < p.blobs.length; k++) blobs?.setColorAt(tree.id * MAX_BLOBS + k, _flickerColor)
        blobsDirty = true
      }
      if (smoke) {
        _dustPos.set(
          tree.x + (Math.random() - 0.5) * tree.scale,
          tree.y + (p.crownCY + 1) * tree.scale,
          tree.z + (Math.random() - 0.5) * tree.scale,
        )
        spawnDust(_dustPos, 0.35 + t * 0.3, PUFF)
        if (Math.random() < 0.4) {
          spawnDebris(tree.x, tree.y + (p.crownCY + 0.5) * tree.scale, tree.z, 0.05, EMBER, 1.2, 1.1)
        }
      }
    }
    if (conesDirty && cones?.instanceColor) cones.instanceColor.needsUpdate = true
    if (blobsDirty && blobs?.instanceColor) blobs.instanceColor.needsUpdate = true
  })

  return (
    <group userData={{ __boots: true }}>
      <instancedMesh
        args={[trunkGeometry, undefined, trees.length]}
        frustumCulled={false}
        ref={trunksRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[coneGeometry, undefined, trees.length * MAX_TIERS]}
        frustumCulled={false}
        ref={conesRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[blobGeometry, undefined, trees.length * MAX_BLOBS]}
        frustumCulled={false}
        ref={blobsRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[branchGeometry, undefined, trees.length * BRANCH_SLOTS]}
        frustumCulled={false}
        ref={branchesRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[stumpGeometry, undefined, trees.length]}
        frustumCulled={false}
        ref={stumpsRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
    </group>
  )
}
