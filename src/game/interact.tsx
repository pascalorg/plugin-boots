'use client'

import { clampDoorOperationState, isOperationDoorType } from '@pascal-app/core'
import * as hostViewer from '@pascal-app/viewer'
import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Box3, Matrix4, type Object3D, Quaternion, Ray, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import {
  isPassageRegistered,
  passageBoxes,
  passageRelievesCell,
  passageReliefStats,
  registerPassage,
  resetPassageReliefStats,
  unregisterPassage,
} from './collision'
import { dropTarget, restoreOperableTarget, useDestruction } from './destruction'
import { armoryStationPosition } from './guntable'
import { releaseNodeDecals } from './paint'
import { playerRig } from './player'
import { getSession } from './session'
import type { ColliderEntry, DoorEntry, GameWorld, OperableEntry } from './world'

/**
 * E-interact: aim at an operable (door / window / cabinet), press E, it
 * opens with the right animator for its kind — then press E again to close.
 *
 * Selection is AIM-BASED like the editor's own first-person mode: a ray from
 * the camera center out to AIM_RANGE, cast against each operable's collider
 * BVHs; the nearest hit wins. Doors keep a small proximity fallback
 * (DOOR_FALLBACK_RANGE) so a point-blank shoulder against the leaf still
 * works when the crosshair slides past the jamb.
 *
 * Animators per kind:
 * - Hinged doors (hinged/double/french leaf on a frame): the classic swing —
 *   the WHOLE host root rotates ±100° about its hinge edge, away from the
 *   player. Mutates only root position/quaternion; originals live in a
 *   module restore ledger that unmount unwinds.
 * - Operation doors (sliding/pocket/barn/folding/garage-*): the host's own
 *   kinematics via the EXPORTED poseDoorMovingParts from @pascal-app/viewer
 *   (named child groups, node-driven geometry) animated over operationState
 *   0→1. Pure openings (openingKind 'opening') never swing — nothing there.
 * - Windows (sliding/casement/awning/hopper/single-hung/double-hung/
 *   louvered): poseWindowMovingParts from @pascal-app/viewer. Fixed/bay/bow
 *   panes don't operate.
 * - Cabinets (cabinet/cabinet-module): every subtree object carrying
 *   userData.cabinetPose {type:'rotate'|'translate', axis, angle|distance}
 *   lerped by openScale (a local 10-line re-implementation of the host's
 *   poseCabinetMovingParts — no @pascal-app/nodes dependency).
 *
 * Colliders: doors go non-solid TO MOVEMENT while open or mid-swing (the
 * capsule passes through the opening) but stay BALLISTIC — their entries
 * flip `disabled` + `ballistic` together, so hitscan still tests them and
 * an open leaf can be shot and broken where it actually stands (owner
 * report 2026-08-29). To make that pose true, every animation step
 * re-snapshots the moving colliders' inverse/worldBox from the live
 * meshes. Windows go passable only when the sash actually LEAVES the frame
 * volume (casement/awning/hopper swing out); sliding and hung sashes stay
 * inside the frame, so their colliders stay on. Cabinet colliders always
 * stay on — an open drawer still stops a shoulder.
 *
 * Passage relief: while a passable operable stands open, its doorway prism
 * (collider-group AABB at mount pose, thin axis padded) is registered with
 * collision.ts — foreign colliders authored ACROSS the opening (the repro
 * house's window rails spanning the front door, a perpendicular wall's end
 * corner) stop pinching the capsule inside it, while ground contacts keep
 * carrying it. Closing (or exit) retires the prism with the collider
 * re-latch.
 *
 * Stale prebuilds: prevoxelize bakes a door's dormant voxel grid at
 * BUILD-time pose (world-space centers) — waking it after a swing would
 * materialize a phantom closed voxel door across the open doorway. Every
 * toggle (and every settle, catching mid-swing rebuilds) drops the DORMANT
 * prebuild via dropTarget; the next hit voxelizes from the live transform.
 * Awake targets are never dropped — destruction owns them.
 *
 * Restore on exit, per kind: hinged doors restore the ledgered root pose;
 * operation doors / windows / cabinets are NAME-DRIVEN poses, so unmount
 * re-poses them to the node's original operationState. Either way the
 * editor gets its scene back exactly as it was.
 *
 * Once gunfire voxelizes a node, destruction owns it: no prompt, no pose,
 * and NEVER re-enable colliders over the carved voxel grid — with ONE
 * exception: a lightly-shot CLOSED door (voxelized at its closed pose, the
 * doorway sealed) stays E-operable, and the toggle hands the node back to
 * the host before swinging (see DOOR_RESTORE_MAX_DAMAGE /
 * destruction.restoreOperableTarget — the Starter House owner repro).
 */

export const AIM_RANGE = 2.5
export const DOOR_FALLBACK_RANGE = 1.2
const TABLE_RANGE = 2.4
const OPEN_ANGLE = (100 * Math.PI) / 180

/** Host pose helpers, looked up defensively: the deployed host viewer
 * exports both, but the published 0.9.1 typings (and the bun-test module
 * mock) predate them — a guarded lookup keeps tsc/tests green either way. */
type HostPoseFn = (
  node: Record<string, unknown>,
  mesh: Object3D | undefined,
  value: number,
) => boolean
const hostPose = hostViewer as unknown as {
  poseDoorMovingParts?: HostPoseFn
  poseWindowMovingParts?: HostPoseFn
}

// ---------------------------------------------------------------------------
// Kind classification (pure — the unit-testable spec of "what E can operate")
// ---------------------------------------------------------------------------

export type OperableKind = 'door-hinged' | 'door-operation' | 'window' | 'cabinet'

/** Window types with a posable sash/panel/slat rig (window-interaction
 * semantics — matches the host's poseWindowMovingParts dispatch). */
export const OPERABLE_WINDOW_TYPES = [
  'sliding',
  'casement',
  'awning',
  'hopper',
  'single-hung',
  'double-hung',
  'louvered',
]

/** Window types whose open sash leaves the frame volume (swings out of the
 * wall plane) — only these drop their colliders while open. Sliding / hung
 * sashes travel INSIDE the frame and louver slats pivot in place, so those
 * stay solid. */
export const OUTSWING_WINDOW_TYPES = ['casement', 'awning', 'hopper']

/**
 * What kind of operable is this collected node? null = E ignores it.
 * `nodeType` is the SOLID_KINDS registry kind; `node` is the scene-store
 * snapshot (DoorEntry/OperableEntry.node). Doors default to hinged when no
 * snapshot exists (hand-built test worlds) — the pre-snapshot behavior.
 */
export function classifyOperable(
  nodeType: string,
  node: Record<string, unknown> | null | undefined,
): OperableKind | null {
  if (nodeType === 'door') {
    if (!node) return 'door-hinged'
    if (node.openingKind === 'opening') return null // a pure hole — nothing to swing
    if (isOperationDoorType(node.doorType as string | undefined)) return 'door-operation'
    return 'door-hinged'
  }
  if (nodeType === 'window') {
    if (!node) return null
    if (node.openingKind === 'opening') return null
    return OPERABLE_WINDOW_TYPES.includes(node.windowType as string) ? 'window' : null
  }
  if (nodeType === 'cabinet' || nodeType === 'cabinet-module') return 'cabinet'
  return null
}

/** Does this operable go non-solid while open? (see the collider notes up top) */
export function opensPassable(kind: OperableKind, node: Record<string, unknown> | null): boolean {
  if (kind === 'door-hinged' || kind === 'door-operation') return true
  if (kind === 'window') return OUTSWING_WINDOW_TYPES.includes(node?.windowType as string)
  return false
}

/** The noun the HUD prompt uses ("Open door" / "Close window" / …). */
export function operableNoun(kind: OperableKind): 'door' | 'window' | 'cabinet' {
  if (kind === 'window') return 'window'
  if (kind === 'cabinet') return 'cabinet'
  return 'door'
}

// ---------------------------------------------------------------------------
// Cabinet pose — local re-implementation of the host's poseCabinetMovingParts
// ---------------------------------------------------------------------------

type CabinetPose =
  | { type: 'rotate'; axis: 'x' | 'y' | 'z'; angle: number }
  | { type: 'translate'; axis: 'x' | 'y' | 'z'; distance: number }

/** Lerp every cabinetPose-tagged front/drawer under `root` to `openScale`
 * (0 = closed, 1 = open). Returns true when at least one part was posed. */
export function poseCabinetParts(root: Object3D, openScale: number): boolean {
  let posed = false
  root.traverse((obj) => {
    const pose = (obj.userData as { cabinetPose?: CabinetPose }).cabinetPose
    if (!pose) return
    posed = true
    if (pose.type === 'rotate') obj.rotation[pose.axis] = pose.angle * openScale
    else obj.position[pose.axis] = pose.distance * openScale
  })
  return posed
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

/** Per-kind swing/pose durations (seconds). */
const DURATIONS: Record<OperableKind, number> = {
  'door-hinged': 0.28,
  'door-operation': 0.6,
  window: 0.4,
  cabinet: 0.32,
}

/** The hinge rig a hinged door swings on — original pose + pivot geometry. */
type HingedRig = {
  /** Original parent-local pose (also mirrored in the restore ledger). */
  position0: Vector3
  quaternion0: Quaternion
  /** Inverse of the original matrixWorld — for player-side swing choice. */
  inverse0: Matrix4
  /** Hinge pivot in parent-local space + the original pivot→position arm. */
  hingeLocal: Vector3
  arm0: Vector3
  /** Swing direction chosen when the door opens (±1). */
  sign: number
}

export type OperableState = {
  kind: OperableKind
  nodeId: string
  root: Object3D
  node: Record<string, unknown> | null
  colliders: ColliderEntry[]
  /** World-space bounds center at snapshot time — proximity anchor. */
  center: Vector3
  /** Colliders drop while open (doors, out-swing windows). */
  passable: boolean
  /** Doorway prism for passage relief (passable kinds only): collider-group
   * AABB at mount pose, thin axis padded — registered with collision.ts
   * while open, retired on the close settle / unmount. The SAME instance
   * both ways (identity-keyed registry). */
  passage: Box3 | null
  /** True while the colliders carry the `ballistic` flag (open + shootable).
   * Cleared with the close re-latch, and by the voxelize stand-down (the
   * hidden host leaf must stop answering rays once the grid owns the node). */
  ballistic: boolean
  /** Pose value 0 (closed) → 1 (open); hinged maps it onto ±OPEN_ANGLE. */
  value: number
  open: boolean
  from: number
  to: number
  /** Seconds into the current animation; >= duration means settled. */
  animT: number
  duration: number
  /** The node's original pose value — what unmount re-poses to. */
  restoreValue: number
  hinged: HingedRig | null
}

/** nodeId → original pose of a hinged door's HOST root. Unmount restores ALL. */
const rootPoseLedger = new Map<
  string,
  { root: Object3D; position0: Vector3; quaternion0: Quaternion }
>()

/** nodeId → name-driven pose restore (operation doors, windows, cabinets):
 * unmount re-poses the named parts to the node's original operationState. */
const namedPoseLedger = new Map<
  string,
  { kind: OperableKind; root: Object3D; node: Record<string, unknown>; restoreValue: number }
>()

/** The mounted component's operables — interactDebug reaches them through here. */
let activeStates: Map<string, OperableState> | null = null

const UP = new Vector3(0, 1, 0)
const tmpVec = new Vector3()
const tmpQuat = new Quaternion()
const tmpMat = new Matrix4()
const tmpBox = new Box3()
const _aimRay = new Ray()
const _localRay = new Ray()
const _inverse = new Matrix4()

/** Once a node voxelizes AWAKE, destruction owns its colliders and its
 * mesh is hidden — the interact system must stand down (no prompt, no pose,
 * and NEVER re-enable colliders over the carved voxel grid). DORMANT
 * prebuilds don't count: prevoxelize builds a sleeping replica for doors,
 * windows, slabs… at session start while the host keeps rendering and
 * colliding untouched — those stay operable until the first hit actually
 * wakes the target. ITEM-FAMILY operables (cabinets, cabinet-modules) are
 * VOXEL-FIRST since 2026-08-28 — they voxelize awake at session start, so
 * they stand down from frame one (a voxel replica has no doors to pose). */
function isVoxelized(nodeId: string): boolean {
  const target = useDestruction.getState().targets.get(nodeId)
  return !!target && !target.dormant
}

/** SEALED-DOOR HANDBACK cap (owner repro 2026-08-30, Starter House): a
 * CLOSED door that catches stray fire voxelizes AT THE CLOSED POSE — the
 * twin looks like the door, the prompt stands down, and the doorway is
 * sealed for the whole session (one pistol round walled the house's only
 * entrance shut). While the awake grid has lost NO MORE than this fraction
 * of its cells, E still owns the door: the toggle hands the node back to
 * the host (destruction.restoreOperableTarget — the bullet holes heal) and
 * swings it. Past the cap the door is visibly wrecked and destruction
 * keeps it: shoot the rest out, that's the game. */
export const DOOR_RESTORE_MAX_DAMAGE = 1 / 3

/** Can E still take this operable back from destruction? Doors only (a
 * voxel cabinet has nothing to pose), CLOSED only (a door that voxelized
 * standing open keeps its open doorway — and its passage prism — forever;
 * re-posing it would sweep the leaf through the carved grid), and only
 * while the awake grid is lightly damaged (see DOOR_RESTORE_MAX_DAMAGE). */
export function isRestorableDoor(state: OperableState): boolean {
  if (state.kind !== 'door-hinged' && state.kind !== 'door-operation') return false
  if (state.open) return false
  const target = useDestruction.getState().targets.get(state.nodeId)
  if (!target || target.dormant) return false
  const grid = target.grid
  if (!grid || !(grid.count > 0)) return false
  return grid.count - grid.aliveCount <= grid.count * DOOR_RESTORE_MAX_DAMAGE
}

/** The voxelize stand-down predicate for aim/fallback/toggle: destruction
 * owns the node — EXCEPT a lightly-shot closed door, which E can restore. */
function standsDown(state: OperableState): boolean {
  return isVoxelized(state.nodeId) && !isRestorableDoor(state)
}

function easeOutCubic(k: number): number {
  const inv = 1 - k
  return 1 - inv * inv * inv
}

/** Thin-axis padding (m) on the passage prism: door boxes are ~0.12 m deep
 * while overlapping-window sills/rails overhang a few cm past the wall face
 * and the capsule brushes them capsule-radius early — a bit over
 * PLAYER_CAPSULE.radius keeps every crossing bar relieved for the whole
 * pass without widening the OPENING axis (jamb walls must keep pushing). */
const PASSAGE_SLACK = 0.35

/**
 * The doorway prism of a passable operable: union of its colliders' world
 * boxes at MOUNT pose (the frame's location — the swung leaf never widens
 * it) with the thin horizontal axis (the wall-thickness direction) padded
 * by PASSAGE_SLACK each way. No floor exclusion needed: collision.ts only
 * relieves NON-GROUND contacts inside the prism, so floors and thresholds
 * keep carrying the capsule. Exported for tests.
 */
export function buildPassageBox(colliders: readonly ColliderEntry[]): Box3 | null {
  const box = new Box3()
  for (const collider of colliders) box.union(collider.worldBox)
  if (box.isEmpty()) return null
  if (box.max.x - box.min.x <= box.max.z - box.min.z) {
    box.min.x -= PASSAGE_SLACK
    box.max.x += PASSAGE_SLACK
  } else {
    box.min.z -= PASSAGE_SLACK
    box.max.z += PASSAGE_SLACK
  }
  return box
}

/** Drop a STALE dormant prebuild (grid baked at another pose) — see the
 * header block. Awake targets are destruction's; never touched. */
function dropStalePrebuild(nodeId: string): void {
  const target = useDestruction.getState().targets.get(nodeId)
  if (target?.dormant) dropTarget(nodeId)
}

/** Re-snapshot the state's collider transforms from the LIVE meshes — the
 * swing moved them (hinged: the whole root; operation doors/windows: named
 * child parts). inverse + worldBox track the leaf so hitscan (shooting.ts)
 * and the aim pick meet the door where it actually stands. */
function refreshColliderTransforms(state: OperableState): void {
  state.root.updateWorldMatrix(false, true)
  for (const collider of state.colliders) {
    collider.inverse.copy(collider.mesh.matrixWorld).invert()
    if (!collider.mesh.geometry.boundingBox) collider.mesh.geometry.computeBoundingBox()
    collider.worldBox.copy(collider.mesh.geometry.boundingBox!).applyMatrix4(collider.mesh.matrixWorld)
  }
}

/** Open (or open-at-start) collider posture: pass-through for movement,
 * live for bullets, passage prism active. */
function setOpenColliders(state: OperableState): void {
  for (const collider of state.colliders) {
    collider.disabled = true
    collider.ballistic = true
  }
  state.ballistic = true
  if (state.passage) registerPassage(state.passage)
}

/** Voxelize stand-down for the ballistic lane: destruction hid the host
 * meshes and owns the node's collision — the ghost leaf must stop
 * answering rays. `disabled` stays (destruction set it too); the passage
 * prism stays active while the doorway stands open (foreign crossers keep
 * their relief; the door can never close again). */
function clearBallistic(state: OperableState): void {
  state.ballistic = false
  for (const collider of state.colliders) collider.ballistic = false
}

function clamp01(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/** Pose `state`'s moving parts at state.value with its kind's animator. */
function applyPose(state: OperableState): void {
  if (state.kind === 'door-hinged') {
    const rig = state.hinged
    if (!rig) return
    const angle = rig.sign * OPEN_ANGLE * state.value
    tmpQuat.setFromAxisAngle(UP, angle)
    state.root.quaternion.multiplyQuaternions(rig.quaternion0, tmpQuat)
    tmpVec.copy(rig.arm0).applyQuaternion(tmpQuat)
    state.root.position.copy(rig.hingeLocal).add(tmpVec)
    return
  }
  if (!state.node) return
  if (state.kind === 'door-operation') {
    hostPose.poseDoorMovingParts?.(state.node, state.root, state.value)
  } else if (state.kind === 'window') {
    hostPose.poseWindowMovingParts?.(state.node, state.root, state.value)
  } else {
    poseCabinetParts(state.root, state.value)
  }
}

/** Re-pose a named-parts operable to `value` outside any live state (the
 * unmount path — states may already be gone). */
function applyNamedPose(
  kind: OperableKind,
  node: Record<string, unknown>,
  root: Object3D,
  value: number,
): void {
  if (kind === 'door-operation') hostPose.poseDoorMovingParts?.(node, root, value)
  else if (kind === 'window') hostPose.poseWindowMovingParts?.(node, root, value)
  else if (kind === 'cabinet') poseCabinetParts(root, value)
}

/** Toggle open/close: retarget the animation and handle colliders + sfx. */
export function toggleOperable(state: OperableState): void {
  // Voxelized node: destruction owns it — no pose over a carved grid. The
  // one exception is the sealed-door handback (see DOOR_RESTORE_MAX_DAMAGE):
  // a lightly-shot CLOSED door re-takes its host leaf first, then swings.
  if (isVoxelized(state.nodeId)) {
    if (!isRestorableDoor(state) || !restoreOperableTarget(state.nodeId)) return
  }
  state.open = !state.open
  // Paint decals are world-space splats baked at the host's clip-time pose
  // (doors/windows are PAINTABLE): the swinging leaf would leave them
  // floating in the opening, so a toggle frees them (cheap map miss for
  // the unpainted 99%).
  releaseNodeDecals(state.nodeId)
  state.from = state.value
  state.to = state.open ? 1 : 0
  state.animT = 0
  if (state.open) {
    if (state.kind === 'door-hinged' && state.hinged) {
      // Swing away from whichever side the player stands on (original frame:
      // positive local angle carries the +X panel toward -Z).
      tmpVec.copy(playerRig.position).applyMatrix4(state.hinged.inverse0)
      state.hinged.sign = tmpVec.z >= 0 ? 1 : -1
    }
    if (state.passable) setOpenColliders(state)
  }
  // The pose is about to change — a dormant prebuild baked at the old pose
  // would wake wrong (see the header block).
  dropStalePrebuild(state.nodeId)
  sfx.doorCreak()
}

/** Advance every running animation by dt; settles poses and re-latches
 * colliders on close. Exported for tests (the frame loop calls it). */
export function advanceOperables(states: Iterable<OperableState>, dt: number): void {
  for (const state of states) {
    if (state.animT >= state.duration) continue
    state.animT += dt
    const k = Math.min(1, state.animT / state.duration)
    state.value = state.from + (state.to - state.from) * easeOutCubic(k)
    applyPose(state)
    // Colliders ride the swing: bullets/aim must meet the leaf mid-arc too.
    refreshColliderTransforms(state)
    if (state.animT >= state.duration) {
      state.value = state.to
      applyPose(state)
      refreshColliderTransforms(state)
      if (!state.open && state.passable && !isVoxelized(state.nodeId)) {
        // Fully shut: solid again, latch catches; the passage prism and the
        // ballistic exception retire with the re-latch.
        for (const collider of state.colliders) {
          collider.disabled = false
          collider.ballistic = false
        }
        state.ballistic = false
        if (state.passage) unregisterPassage(state.passage)
        sfx.doorLatch()
      }
      // A prevoxelize rebuild that landed MID-SWING baked a mid-arc pose —
      // drop it so the next build/hit uses the settled one.
      dropStalePrebuild(state.nodeId)
    }
  }
}

// ---------------------------------------------------------------------------
// State building + mount/unmount (exported for headless tests)
// ---------------------------------------------------------------------------

function collidersOf(
  world: GameWorld,
  colliderIndices: readonly number[],
): { colliders: ColliderEntry[]; center: Vector3 } | null {
  const colliders: ColliderEntry[] = []
  const worldBounds = new Box3()
  for (const index of colliderIndices) {
    const collider = world.colliders[index]
    if (!collider) continue
    colliders.push(collider)
    worldBounds.union(collider.worldBox)
  }
  if (colliders.length === 0 || worldBounds.isEmpty()) return null
  return { colliders, center: worldBounds.getCenter(new Vector3()) }
}

function buildHingedRig(root: Object3D, colliders: ColliderEntry[]): HingedRig {
  // Local bounds of the door meshes in the root's frame — the hinge is the
  // vertical edge on the local -X side, centered across the thin axis.
  const inverse0 = new Matrix4().copy(root.matrixWorld).invert()
  const localBounds = new Box3()
  for (const collider of colliders) {
    if (!collider.mesh.geometry.boundingBox) collider.mesh.geometry.computeBoundingBox()
    tmpMat.multiplyMatrices(inverse0, collider.mesh.matrixWorld)
    tmpBox.copy(collider.mesh.geometry.boundingBox!).applyMatrix4(tmpMat)
    localBounds.union(tmpBox)
  }
  const hingeWorld = new Vector3(
    localBounds.min.x,
    localBounds.min.y,
    (localBounds.min.z + localBounds.max.z) / 2,
  ).applyMatrix4(root.matrixWorld)
  // Pose math runs in parent-local space (root.position lives there).
  const hingeLocal = root.parent ? root.parent.worldToLocal(hingeWorld.clone()) : hingeWorld.clone()
  const position0 = root.position.clone()
  const quaternion0 = root.quaternion.clone()
  return {
    position0,
    quaternion0,
    inverse0,
    hingeLocal,
    arm0: position0.clone().sub(hingeLocal),
    sign: 1,
  }
}

function buildState(
  world: GameWorld,
  entry: DoorEntry | OperableEntry,
  nodeType: string,
): OperableState | null {
  const node = (entry.node ?? null) as Record<string, unknown> | null
  const kind = classifyOperable(nodeType, node)
  if (!kind) return null
  const picked = collidersOf(world, entry.colliderIndices)
  if (!picked) return null

  const hinged = kind === 'door-hinged' ? buildHingedRig(entry.root, picked.colliders) : null
  // Named-pose kinds start at the node's live operationState (the scene is
  // already posed there); hinged doors start at their as-built pose (0).
  const restoreValue =
    kind === 'door-hinged'
      ? 0
      : kind === 'door-operation'
        ? clampDoorOperationState(node?.operationState as number | undefined)
        : clamp01(node?.operationState)
  const passable = opensPassable(kind, node)
  const open = kind !== 'door-hinged' && restoreValue > 0.5
  const state: OperableState = {
    kind,
    nodeId: entry.nodeId,
    root: entry.root,
    node,
    colliders: picked.colliders,
    center: picked.center,
    passable,
    passage: passable ? buildPassageBox(picked.colliders) : null,
    ballistic: false,
    value: kind === 'door-hinged' ? 0 : restoreValue,
    open,
    from: 0,
    to: 0,
    animT: DURATIONS[kind],
    duration: DURATIONS[kind],
    restoreValue,
    hinged,
  }
  // A node that starts open is already non-solid to walk through — its
  // collider snapshot has the leaf posed aside anyway (and still shootable,
  // exactly like a door opened mid-session).
  if (open && passable) setOpenColliders(state)
  return state
}

/**
 * Snapshot every operable in `world` into live states + restore ledgers.
 * The component's mount effect calls this; tests call it directly.
 */
export function mountInteract(world: GameWorld): Map<string, OperableState> {
  const states = new Map<string, OperableState>()
  for (const entry of world.doors) {
    const state = buildState(world, entry, 'door')
    if (!state) continue
    states.set(entry.nodeId, state)
    if (state.kind === 'door-hinged' && state.hinged) {
      rootPoseLedger.set(entry.nodeId, {
        root: entry.root,
        position0: state.hinged.position0,
        quaternion0: state.hinged.quaternion0,
      })
    } else if (state.node) {
      namedPoseLedger.set(entry.nodeId, {
        kind: state.kind,
        root: entry.root,
        node: state.node,
        restoreValue: state.restoreValue,
      })
    }
  }
  for (const entry of world.operables ?? []) {
    const state = buildState(world, entry, entry.kind)
    if (!state || !state.node) continue
    states.set(entry.nodeId, state)
    namedPoseLedger.set(entry.nodeId, {
      kind: state.kind,
      root: entry.root,
      node: state.node,
      restoreValue: state.restoreValue,
    })
  }
  activeStates = states
  return states
}

/**
 * THE invariant: put every host node back exactly the way the editor had it —
 * hinged roots to their ledgered pose, named-part kinds re-posed to their
 * original operationState — and make every collider solid again.
 */
export function unmountInteract(states: Map<string, OperableState>): void {
  for (const { root, position0, quaternion0 } of rootPoseLedger.values()) {
    root.position.copy(position0)
    root.quaternion.copy(quaternion0)
    root.updateWorldMatrix(false, true)
  }
  rootPoseLedger.clear()
  for (const { kind, root, node, restoreValue } of namedPoseLedger.values()) {
    applyNamedPose(kind, node, root, restoreValue)
  }
  namedPoseLedger.clear()
  for (const state of states.values()) {
    for (const collider of state.colliders) {
      collider.disabled = false
      collider.ballistic = false
    }
    state.ballistic = false
    if (state.passage) unregisterPassage(state.passage)
  }
  if (activeStates === states) activeStates = null
}

// ---------------------------------------------------------------------------
// Aim pick
// ---------------------------------------------------------------------------

/**
 * The operable under the crosshair: cast origin→direction against every
 * state's collider BVHs — in their LIVE frames: the swing refreshes each
 * collider's inverse/worldBox (refreshColliderTransforms), so an open door
 * answers at its actual swung pose, exactly where the bullet lane tests it.
 * Closing through the empty doorway still works via the point-blank door
 * fallback below. Nearest hit within maxDist wins. Disabled colliders
 * still answer here: disabled means "not solid", not "not interactive".
 * Voxelized nodes never answer. Pure — exported for tests.
 */
export function pickAimedOperable(
  states: Iterable<OperableState>,
  origin: Vector3,
  direction: Vector3,
  maxDist = AIM_RANGE,
): OperableState | null {
  _aimRay.origin.copy(origin)
  _aimRay.direction.copy(direction)
  let best: OperableState | null = null
  let bestDist = maxDist
  for (const state of states) {
    if (standsDown(state)) continue
    for (const collider of state.colliders) {
      _inverse.copy(collider.inverse)
      _localRay.origin.copy(_aimRay.origin).applyMatrix4(_inverse)
      _localRay.direction.copy(_aimRay.direction).transformDirection(_inverse)
      const hit = collider.bvh.raycastFirst(_localRay, 2)
      if (!hit) continue
      const distance = hit.point.applyMatrix4(collider.mesh.matrixWorld).distanceTo(origin)
      if (distance < bestDist) {
        bestDist = distance
        best = state
      }
    }
  }
  return best
}

/** Point-blank fallback: the nearest DOOR within range of the player —
 * shoulders-against-the-leaf territory where the crosshair may look past
 * the jamb. Windows/cabinets stay aim-only (you don't lean on a cabinet
 * expecting it to open). Pure — exported for tests. */
export function nearestDoorFallback(
  states: Iterable<OperableState>,
  position: Vector3,
  range = DOOR_FALLBACK_RANGE,
): OperableState | null {
  let best: OperableState | null = null
  let bestSq = range * range
  for (const state of states) {
    if (state.kind !== 'door-hinged' && state.kind !== 'door-operation') continue
    if (standsDown(state)) continue
    const dSq = state.center.distanceToSquared(position)
    if (dSq < bestSq) {
      bestSq = dSq
      best = state
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const _aimDir = new Vector3()

export function Interact({ world }: { world: GameWorld }) {
  const statesRef = useRef<Map<string, OperableState> | null>(null)
  const tablesRef = useRef<Array<{ position: Vector3; weapon: 'rifle' | 'minigun' | 'builder' }>>([])
  const lastPrompt = useRef<string | null>(null)

  useEffect(() => {
    const states = mountInteract(world)
    statesRef.current = states
    // The depot's pickup stations own E while the player is gearing up in
    // front of them (the tables' contract, carried to the container — the
    // double-fire bug: E both grabbed gear AND toggled a door behind the
    // wall). The armory grants the full loadout in one press, so gating on
    // 'rifle' covers it; the breaker has no door anywhere near its end wall.
    tablesRef.current = [
      // The build bench is decoration now (builder+paint are the spawn
      // loadout) — only the armory still owns E on its disc.
      { position: armoryStationPosition(world), weapon: 'rifle' },
    ]
    return () => {
      unmountInteract(states)
      statesRef.current = null
      lastPrompt.current = null
    }
  }, [world])

  // Priority -1: R3F runs subscribers in ascending priority order, so this
  // executes before every default-0 callback — critically the viewmodel,
  // whose consumeActions() drains the one-shot input queue we take 'KeyE'
  // from (negative priorities keep auto-render; only >0 goes manual).
  useFrame((_, rawDt) => {
    const session = getSession()
    const states = statesRef.current
    if (!session || !states) return
    const dt = Math.min(rawDt, 1 / 30)

    advanceOperables(states.values(), dt)

    // Ballistic stand-down: a node that voxelized while open (bullets broke
    // the leaf) hands its rays to the grid — the hidden host leaf must stop
    // answering (see clearBallistic). One boolean per settled state.
    for (const state of states.values()) {
      if (state.ballistic && isVoxelized(state.nodeId)) clearBallistic(state)
    }

    // What is the crosshair on? (yaw/pitch → forward, YXZ like the camera.)
    const cp = Math.cos(playerRig.pitch)
    _aimDir.set(
      -Math.sin(playerRig.yaw) * cp,
      Math.sin(playerRig.pitch),
      -Math.cos(playerRig.yaw) * cp,
    )
    let target = pickAimedOperable(states.values(), playerRig.position, _aimDir)
    if (!target) target = nearestDoorFallback(states.values(), playerRig.position)

    // The gun tables own the prompt + E while the player is gearing up there.
    const owned = useBoots.getState().owned
    for (const table of tablesRef.current) {
      if (owned.includes(table.weapon)) continue
      const d = Math.hypot(
        playerRig.position.x - table.position.x,
        playerRig.position.z - table.position.z,
      )
      if (d < TABLE_RANGE) {
        target = null
        break
      }
    }

    const prompt = target
      ? `E — ${target.open ? 'Close' : 'Open'} ${operableNoun(target.kind)}`
      : null
    if (prompt !== lastPrompt.current) {
      lastPrompt.current = prompt
      // hud.prompt(null, 'doors') clears text + fades while we own the line;
      // we run at priority -1, so a same-frame guntable show lands after us.
      session.hud.prompt(prompt, 'doors')
    }

    // E — take the one-shot 'KeyE' action from the input queue so a tap
    // whose keydown+keyup both land inside one frame still registers
    // (per-frame keys sampling misses it). This callback runs at priority
    // -1, before the viewmodel's consumeActions() drain; we strip only our
    // KeyE entries, in place, and only while an operable has the press. The
    // gun tables keep their priority: while either is busy `target` is null,
    // the queue is left alone, and they read the keys set — never the queue.
    if (target) {
      const actions = session.input.state.actions
      let tapped = false
      let write = 0
      for (let read = 0; read < actions.length; read++) {
        const action = actions[read]!
        if (action === 'KeyE') {
          tapped = true
        } else {
          if (write !== read) actions[write] = action
          write++
        }
      }
      if (tapped) {
        actions.length = write
        toggleOperable(target)
      }
    }
  }, -1)

  return null
}

/** Is `root` — or any ancestor — hidden? destruction's hideHostNode flips the
 * host leaf invisible when a voxel target takes the node over, so a census
 * reading hostHidden with a live grid means the GRID owns this doorway. */
function rootHidden(root: Object3D): boolean {
  let node: Object3D | null = root
  while (node) {
    if (!node.visible) return true
    node = node.parent
  }
  return false
}

const boxData = (box: Box3) => ({
  min: [+box.min.x.toFixed(3), +box.min.y.toFixed(3), +box.min.z.toFixed(3)] as [
    number,
    number,
    number,
  ],
  max: [+box.max.x.toFixed(3), +box.max.y.toFixed(3), +box.max.z.toFixed(3)] as [
    number,
    number,
    number,
  ],
})

/** Manager wiring for __boots: inspect/flip operables headlessly. */
export const interactDebug = {
  list: (): Array<{ nodeId: string; kind: OperableKind; open: boolean }> =>
    activeStates
      ? Array.from(activeStates.values(), (state) => ({
          nodeId: state.nodeId,
          kind: state.kind,
          open: state.open,
        }))
      : [],
  toggle: (nodeId: string): void => {
    const state = activeStates?.get(nodeId)
    // toggleOperable self-guards the voxelized case (including the sealed-
    // door handback), so bots fumbling a lightly-shot door open it too.
    if (state) toggleOperable(state)
  },
  /** Every live passage prism as plain data (what collision.ts is relieving). */
  passages: () => passageBoxes(),
  /** Would the VOXEL lane relieve a cell centered here for a capsule whose feet
   * are at `feetY`? (collision.ts::passageRelievesCell — the exact predicate
   * collideVoxelTargets consults.) Lets QA prove, cell by cell, that the
   * blockers standing in an open doorway are the ones being dropped. */
  relievesCell: (x: number, y: number, z: number, feetY: number): boolean =>
    passageRelievesCell(x, y, z, feetY),
  /** Did the VOXEL lane actually ask this module for relief, and was it
   * granted? Distinguishes "relief said no" from "relief was never consulted". */
  reliefStats: () => passageReliefStats(),
  resetReliefStats: (): void => resetPassageReliefStats(),
  /**
   * Alive voxel cells standing inside a WORLD-space AABB, grouped by the node
   * that owns them — the numeric answer to "why do I see blocks in this open
   * doorway, and what is stopping me walking in". Grid centers are world-space
   * (collideVoxelTargets compares them straight against the capsule), so no
   * basis work is needed here. Read-only over destruction's store.
   */
  occupancy: (
    min: [number, number, number],
    max: [number, number, number],
  ): Array<{
    nodeId: string
    kind: string
    dormant: boolean
    cells: number
    cell: number
    /** AABB of the MATCHED cell centers — proves whether they stand on the
     * walk line or only rim the jamb reveal. */
    box: { min: [number, number, number]; max: [number, number, number] }
  }> => {
    const out: Array<{
      nodeId: string
      kind: string
      dormant: boolean
      cells: number
      cell: number
      box: { min: [number, number, number]; max: [number, number, number] }
    }> = []
    for (const target of useDestruction.getState().targets.values()) {
      const grid = target.grid
      if (!grid) continue
      let cells = 0
      const lo: [number, number, number] = [Infinity, Infinity, Infinity]
      const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
      for (let i = 0; i < grid.alive.length; i++) {
        if (!grid.alive[i]) continue
        const x = grid.centers[i * 3]!
        const y = grid.centers[i * 3 + 1]!
        const z = grid.centers[i * 3 + 2]!
        if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) {
          continue
        }
        cells++
        if (x < lo[0]) lo[0] = x
        if (y < lo[1]) lo[1] = y
        if (z < lo[2]) lo[2] = z
        if (x > hi[0]) hi[0] = x
        if (y > hi[1]) hi[1] = y
        if (z > hi[2]) hi[2] = z
      }
      if (cells > 0) {
        out.push({
          nodeId: target.nodeId,
          kind: String(target.kind),
          dormant: target.dormant === true,
          cells,
          cell: grid.cell,
          box: { min: lo, max: hi },
        })
      }
    }
    return out
  },
  /**
   * THE EVIDENCE DUMP for "the door is open but I can't walk in / I see
   * voxels in the opening". Per operable: the pose, the collider posture,
   * the doorway prism AND whether collision.ts actually holds it, whether
   * the host leaf is hidden, and the voxel target that may be standing in
   * the doorway instead. Plain data — never live refs.
   */
  census: () =>
    activeStates
      ? Array.from(activeStates.values(), (state) => {
          const target = useDestruction.getState().targets.get(state.nodeId)
          const group = new Box3()
          for (const collider of state.colliders) group.union(collider.worldBox)
          return {
            nodeId: state.nodeId,
            kind: state.kind,
            open: state.open,
            value: +state.value.toFixed(4),
            passable: state.passable,
            settled: state.animT >= state.duration,
            ballistic: state.ballistic,
            hostHidden: rootHidden(state.root),
            /** Collider group AABB in the LIVE pose — follows the swing. */
            liveBox: group.isEmpty() ? null : boxData(group),
            /** Mount-pose doorway prism (the promise of passage). */
            passage: state.passage ? boxData(state.passage) : null,
            passageRegistered: state.passage ? isPassageRegistered(state.passage) : false,
            colliders: state.colliders.map((collider) => ({
              disabled: collider.disabled === true,
              ballistic: collider.ballistic === true,
              walkOnly: collider.walkOnly === true,
            })),
            /** The voxel replica, if destruction has one for this node. */
            target: target
              ? {
                  dormant: target.dormant === true,
                  walkOnly: target.walkOnly === true,
                  aliveCount: target.grid.aliveCount,
                  totalCount: target.grid.alive.length,
                }
              : null,
          }
        })
      : [],
}
