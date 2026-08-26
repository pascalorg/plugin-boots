'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import {
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  type InstancedMesh,
  Matrix4,
  Quaternion,
  Vector3,
} from 'three'
import { sfx, type TreeCrackleHandle } from './audio'
import { spawnDebris } from './debris'
import { spawnDust } from './dust'
import { scatter } from './nature'
import { hideForGame } from './session'
import { registerTreeRoutes } from './shooting'
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
 * Everything is InstancedMesh (trunks, canopies, branches, stumps — four
 * draw calls for the whole grove); bursts ride the shared debris ring, so
 * a felled tree costs nothing persistent. Raycasts are analytic (vertical
 * trunk cylinder + canopy sphere), CPU-only, ~46 trees per shot.
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
 *       { id, nodeId?, x, y, z, scale, state, hp, canopyDamage, burnT,
 *         charHits } — nodeId set exactly on host-tree replacements.
 *   Pure helpers exported for tests: buildTreesFrom, raycastTrees,
 *       damageTree, updateBurning, hostTreePlacements, withoutHostOverlap
 *       (no rendering/sfx inside — the component wraps them with effects).
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
  /** Canopy rgb 0..1 (trunks share one bark brown). */
  color: [number, number, number]
  /** Scene node id when this placement replaces a REAL host tree. */
  nodeId?: string
}

export type CombatTree = TreePlacement & {
  id: number
  /** Resolved base elevation (placement y, defaulted to 0). */
  y: number
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

// Shape constants — match nature.tsx's old tree look (scaled per tree).
const TRUNK_R_TOP = 0.14
const TRUNK_R_BOT = 0.2
const TRUNK_H = 2.4
/** Canopy approximated as a sphere for raycasts (cone spans y 1.9..5.3). */
const CANOPY_CY = 3.4
const CANOPY_R = 1.55

export function buildTreesFrom(placements: TreePlacement[]): CombatTree[] {
  return placements.map((p, id) => ({
    ...p,
    id,
    y: p.y ?? 0,
    state: 'healthy' as TreeState,
    hp: TREE_HP,
    canopyDamage: 0,
    burnT: 0,
    charHits: CHAR_HITS,
  }))
}

// --- Host-tree replacement placements --------------------------------------

/** Combat-tree apex height at scale 1 (canopy cone top: 3.6 + 3.4 / 2) —
 * the divisor turning a host tree's node height into a matching scale. */
export const COMBAT_TREE_APEX = 5.3
/** Sanity clamp on host-derived scales (a 60 m sequoia node still spawns a
 * shootable tree; a 0.5 m sapling stays raycastable). */
const HOST_SCALE_MIN = 0.45
const HOST_SCALE_MAX = 2.6
/** Scattered trees this close (m, XZ) to a host tree are dropped — the
 * replacement stands exactly there. */
export const HOST_TREE_CLEARANCE = 1.6

const HOST_CANOPY = new Color('#3f6d33')
const _hostColor = new Color()

/**
 * Combat placements standing in for the REAL host trees, same world
 * transforms: XZ + base elevation from the node's registered root, yaw from
 * the node, scale from node height (height / COMBAT_TREE_APEX, clamped).
 * Hidden-branch trees get no replacement. Canopy color is the scattered
 * grove's green with a deterministic per-index lightness wobble.
 */
export function hostTreePlacements(hostTrees: readonly HostTreeNode[]): TreePlacement[] {
  const placements: TreePlacement[] = []
  for (let i = 0; i < hostTrees.length; i++) {
    const tree = hostTrees[i]!
    if (tree.hidden) continue
    const scale = Math.min(HOST_SCALE_MAX, Math.max(HOST_SCALE_MIN, tree.height / COMBAT_TREE_APEX))
    _hostColor.copy(HOST_CANOPY).offsetHSL(0, 0, (((i * 7919) % 13) / 13 - 0.5) * 0.08)
    placements.push({
      x: tree.x,
      z: tree.z,
      y: tree.y,
      scale,
      yaw: tree.yaw,
      color: [_hostColor.r, _hostColor.g, _hostColor.b],
      nodeId: tree.nodeId,
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
 * Nearest live tree part along the ray. Trunk = finite vertical cylinder,
 * canopy = sphere; stumps don't block shots. Allocation-free except the
 * returned hit (one small object per SUCCESSFUL shot, not per tree).
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
    // Trunk: infinite cylinder about (x, z), then clamp hit height.
    {
      const r = TRUNK_R_BOT * s
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
            if (y >= 0 && y <= TRUNK_H * s) {
              bestDist = t
              bestTree = tree.id
              bestPart = 'trunk'
            }
          }
        }
      }
    }
    // Canopy sphere — only while the crown exists (burned crowns are gone).
    if (tree.state !== 'charred') {
      const cx = origin.x - tree.x
      const cy = origin.y - (tree.y + CANOPY_CY * s)
      const cz = origin.z - tree.z
      const r = CANOPY_R * s
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

export const treesDebug = {
  dump: (): Array<Record<string, unknown>> =>
    liveTrees.map((t) => ({
      id: t.id,
      nodeId: t.nodeId,
      x: t.x,
      y: t.y,
      z: t.z,
      scale: t.scale,
      state: t.state,
      hp: t.hp,
      canopyDamage: t.canopyDamage,
      burnT: t.burnT,
      charHits: t.charHits,
    })),
}

// --- Effects (voxel bursts, dust, sfx) — component/route side -------------

const BARK = new Color('#6b4f35')
const CHARCOAL = new Color('#2b2724')
const EMBER = new Color('#e8703a')
const _burstColor = new Color()
const _canopyColor = new Color()

/** Voxel burst filling the canopy sphere — the "becomes voxels" collapse. */
function burstCanopy(tree: CombatTree, charcoal: boolean): void {
  const s = tree.scale
  const n = 26
  for (let i = 0; i < n; i++) {
    if (charcoal) _burstColor.copy(CHARCOAL)
    else _burstColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
    const r = CANOPY_R * s * Math.cbrt(Math.random())
    const theta = Math.random() * Math.PI * 2
    const u = Math.random() * 2 - 1
    const h = Math.sqrt(1 - u * u)
    spawnDebris(
      tree.x + Math.cos(theta) * h * r,
      tree.y + CANOPY_CY * s + u * r,
      tree.z + Math.sin(theta) * h * r,
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
    _burstColor.copy(charcoal ? CHARCOAL : BARK)
    const y = tree.y + (0.35 + ((TRUNK_H - 0.35) * i) / n) * s
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
function applyTreeDamage(trees: CombatTree[], hit: TreeHit, damage: number): void {
  const tree = trees[hit.treeId]
  if (!tree) return
  const wasBurning = tree.state === 'burning'
  const event = damageTree(tree, hit.part, damage)
  switch (event) {
    case 'chip': {
      // Splinters/leaf voxels at the impact, in the part's color.
      if (hit.part === 'canopy') _burstColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      else _burstColor.copy(wasBurning ? CHARCOAL : BARK)
      for (let i = 0; i < 3; i++) {
        spawnDebris(hit.point.x, hit.point.y, hit.point.z, 0.06, _burstColor, 1.3, 1.4)
      }
      sfx.voxelCrunch(0.25)
      break
    }
    case 'ignite': {
      _dustPos.set(tree.x, tree.y + CANOPY_CY * tree.scale, tree.z)
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
      sfx.charSnap()
      revision++
      break
    }
    case 'collapse': {
      burstTrunk(tree, true)
      _dustPos.set(tree.x, tree.y + 1 * tree.scale, tree.z)
      spawnDust(_dustPos, 0.7, PUFF)
      sfx.charSnap()
      sfx.woodCrumble(0.5)
      revision++
      break
    }
    case 'none':
      break
  }
}

// --- Rendering -------------------------------------------------------------

const _matrix = new Matrix4()
const _pos = new Vector3()
const _quat = new Quaternion()
const _scaleV = new Vector3()
const _yAxis = new Vector3(0, 1, 0)
const ZERO = new Matrix4().makeScale(0, 0, 0)
/** Branch stick orientations for charred crowns (tilt out + around). */
const BRANCH_YAWS = [0.3, 2.4, 4.5]

function setTreeMatrix(mesh: InstancedMesh, i: number, tree: CombatTree): void {
  _pos.set(tree.x, tree.y, tree.z)
  _quat.setFromAxisAngle(_yAxis, tree.yaw)
  _scaleV.setScalar(tree.scale)
  _matrix.compose(_pos, _quat, _scaleV)
  mesh.setMatrixAt(i, _matrix)
}

/** Rebuild every instance matrix/color from tree states (runs on revision
 * bumps only — burning color animation is the frame loop's job). */
function syncInstances(
  trees: CombatTree[],
  trunks: InstancedMesh | null,
  canopies: InstancedMesh | null,
  branches: InstancedMesh | null,
  stumps: InstancedMesh | null,
): void {
  if (!trunks || !canopies || !branches || !stumps) return
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i]!
    const s = tree.scale
    // Trunk stands until the tree is a stump; charred trunks go black.
    if (tree.state === 'stump') trunks.setMatrixAt(i, ZERO)
    else setTreeMatrix(trunks, i, tree)
    trunks.setColorAt(i, tree.state === 'charred' ? CHARCOAL : BARK)
    // Crown exists while healthy/burning (burning tint animates per frame).
    if (tree.state === 'healthy' || tree.state === 'burning') {
      setTreeMatrix(canopies, i, tree)
      _canopyColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      canopies.setColorAt(i, _canopyColor)
    } else canopies.setMatrixAt(i, ZERO)
    // Bare branches only on charred trees, one hidden per snap taken.
    for (let b = 0; b < CHAR_HITS; b++) {
      const j = i * CHAR_HITS + b
      if (tree.state === 'charred' && b < tree.charHits) {
        _pos.set(tree.x, tree.y + (TRUNK_H - 0.25) * s, tree.z)
        _quat.setFromAxisAngle(_yAxis, tree.yaw + BRANCH_YAWS[b]!)
        _scaleV.setScalar(s)
        _matrix.compose(_pos, _quat, _scaleV)
        branches.setMatrixAt(j, _matrix)
      } else branches.setMatrixAt(j, ZERO)
      // Color EVERY slot, not just charred ones: the mount-time sync must
      // create instanceColor before the WebGPU pipeline first compiles, or
      // branches that appear mid-session render white (wiring, 2026-08-25).
      // Trunks/canopies/stumps already color unconditionally — same reason.
      branches.setColorAt(j, CHARCOAL)
    }
    // Stump appears the moment the tree above it is gone.
    if (tree.state === 'stump') setTreeMatrix(stumps, i, tree)
    else stumps.setMatrixAt(i, ZERO)
    stumps.setColorAt(i, BARK)
  }
  trunks.instanceMatrix.needsUpdate = true
  canopies.instanceMatrix.needsUpdate = true
  branches.instanceMatrix.needsUpdate = true
  stumps.instanceMatrix.needsUpdate = true
  if (trunks.instanceColor) trunks.instanceColor.needsUpdate = true
  if (canopies.instanceColor) canopies.instanceColor.needsUpdate = true
  if (branches.instanceColor) branches.instanceColor.needsUpdate = true
  if (stumps.instanceColor) stumps.instanceColor.needsUpdate = true
}

/** Same grove layout nature.tsx rendered (seed 23, 46 trees, ring 12–60 m). */
function treePlacements(world: GameWorld): TreePlacement[] {
  const placements: TreePlacement[] = []
  scatter(world, 23, 46, 12, 60, (rand, position) => {
    const yaw = rand() * Math.PI * 2
    const scale = 0.8 + rand() * 0.9
    const color = new Color('#3f6d33').offsetHSL(0, 0, (rand() - 0.5) * 0.08)
    placements.push({ x: position.x, z: position.z, scale, yaw, color: [color.r, color.g, color.b] })
    return color
  })
  return placements
}

const _finishedBurning: number[] = []
const _flickerColor = new Color()

export function TreesDestruct({ world }: { world: GameWorld }) {
  const scene = useThree((s) => s.scene)
  const trees = useMemo(() => {
    const host = world.hostTrees ?? []
    return buildTreesFrom([
      ...withoutHostOverlap(treePlacements(world), host),
      ...hostTreePlacements(host),
    ])
  }, [world])

  const trunkGeometry = useMemo(
    () => new CylinderGeometry(TRUNK_R_TOP, TRUNK_R_BOT, TRUNK_H).translate(0, TRUNK_H / 2, 0),
    [],
  )
  const canopyGeometry = useMemo(() => new ConeGeometry(1.5, 3.4, 8).translate(0, 3.6, 0), [])
  // A bare branch: thin charcoal stick leaning out from the trunk top.
  const branchGeometry = useMemo(() => {
    const g = new BoxGeometry(0.055, 1.15, 0.055)
    g.translate(0, 0.5, 0)
    g.rotateZ(0.55)
    return g
  }, [])
  const stumpGeometry = useMemo(() => new CylinderGeometry(0.18, 0.22, 0.35).translate(0, 0.175, 0), [])

  const trunksRef = useRef<InstancedMesh>(null)
  const canopiesRef = useRef<InstancedMesh>(null)
  const branchesRef = useRef<InstancedMesh>(null)
  const stumpsRef = useRef<InstancedMesh>(null)
  const seenRevision = useRef(-1)
  const crackle = useRef<TreeCrackleHandle | null>(null)
  const smokeClock = useRef(0)

  useEffect(() => {
    // Host trees leave the stage for the session: hide the per-node
    // registered roots (selection proxies — they mount real geometry while
    // hovered/selected) AND the collective forest InstancedMeshes, all
    // through the restore ledger — exitGame flips every visibility back,
    // the scene store is never written. hideForGame skips already-hidden
    // objects, so effect re-runs (world refresh, Fast Refresh) are safe.
    const host = world.hostTrees ?? []
    if (host.length > 0) {
      for (const tree of host) hideForGame(tree.root)
      for (const mesh of collectHostForestMeshes(scene, host)) hideForGame(mesh)
    }

    liveTrees = trees
    revision++
    registerTreeRoutes<TreeHit>({
      raycast: (origin, direction, maxDist) => raycastTrees(trees, origin, direction, maxDist),
      damage: (_world, hit, damage) => applyTreeDamage(trees, hit, damage),
    })
    return () => {
      registerTreeRoutes(null)
      if (liveTrees === trees) liveTrees = []
      crackle.current?.stop()
      crackle.current = null
    }
  }, [trees, world, scene])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 1 / 30)

    // Burn progress → charred transitions (canopy collapses into voxels).
    _finishedBurning.length = 0
    const burningCount = updateBurning(trees, dt, _finishedBurning)
    for (const id of _finishedBurning) {
      const tree = trees[id]!
      burstCanopy(tree, true)
      _dustPos.set(tree.x, tree.y + CANOPY_CY * tree.scale, tree.z)
      spawnDust(_dustPos, 0.8, PUFF)
      sfx.charSnap()
      revision++
    }

    // Crackle loop follows how much of the grove is on fire.
    if (burningCount > 0 && !crackle.current) crackle.current = sfx.treeCrackle()
    crackle.current?.setIntensity(Math.min(1, burningCount / 3))

    // Structural sync only when something changed.
    if (seenRevision.current !== revision) {
      seenRevision.current = revision
      syncInstances(trees, trunksRef.current, canopiesRef.current, branchesRef.current, stumpsRef.current)
    }

    if (burningCount === 0) return

    // Burning crowns: color chars green → ember → charcoal, and every
    // ~0.35s each fire sheds one smoke puff + the odd ember chunk.
    const canopies = canopiesRef.current
    smokeClock.current += dt
    const smoke = smokeClock.current >= 0.35
    if (smoke) smokeClock.current = 0
    for (const tree of trees) {
      if (tree.state !== 'burning') continue
      const t = tree.burnT / BURN_SECONDS
      _flickerColor.setRGB(tree.color[0], tree.color[1], tree.color[2])
      if (t < 0.35) _flickerColor.lerp(EMBER, t / 0.35)
      else _flickerColor.copy(EMBER).lerp(CHARCOAL, (t - 0.35) / 0.65)
      // Fire flicker on top of the char ramp.
      _flickerColor.lerp(EMBER, Math.random() * 0.25)
      canopies?.setColorAt(tree.id, _flickerColor)
      if (smoke) {
        _dustPos.set(
          tree.x + (Math.random() - 0.5) * tree.scale,
          tree.y + (CANOPY_CY + 1) * tree.scale,
          tree.z + (Math.random() - 0.5) * tree.scale,
        )
        spawnDust(_dustPos, 0.35 + t * 0.3, PUFF)
        if (Math.random() < 0.4) {
          spawnDebris(tree.x, tree.y + (CANOPY_CY + 0.5) * tree.scale, tree.z, 0.05, EMBER, 1.2, 1.1)
        }
      }
    }
    if (canopies?.instanceColor) canopies.instanceColor.needsUpdate = true
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
        args={[canopyGeometry, undefined, trees.length]}
        frustumCulled={false}
        ref={canopiesRef}
      >
        <meshStandardMaterial roughness={0.95} />
      </instancedMesh>
      <instancedMesh
        args={[branchGeometry, undefined, trees.length * CHAR_HITS]}
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
