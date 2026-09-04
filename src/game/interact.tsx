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
import {
  dropTarget,
  resyncPosedTarget,
  restoreOperableTarget,
  useDestruction,
} from './destruction'
import { ARMORY_STATION_LOCAL, armoryStationPosition, liveDepotLocalToWorld } from './guntable'
import { takeAction } from './input'
import { releaseNodeDecals } from './paint'
import { playerRig } from './player'
import { hordeAuthorityId } from './horde-sync'
import {
  localSessionId,
  type NetMessage,
  onFrame,
  onStateRequest,
  onStateSnapshot,
  publishFrame,
  registerFrameKind,
  requestState,
  sendStateSnapshot,
} from './net'
import { getSession } from './session'
import { replicaDrawAudit } from './voxel-walls'
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
 * - GAME-BUILT doors/windows (the builder's wall pockets — fittings.tsx):
 *   registered at runtime through registerGameOperable instead of collected
 *   from the scene. No host node, so they are plain hinged leaves; a window
 *   sash swings the same way and only its prompt noun differs.
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
/** Vertical slack on the point-blank fallback (m): how far the player's EYE
 * may sit outside the leaf's own vertical extent and still count as standing
 * at that door. The fallback used to measure a 3-D distance to the leaf's
 * CENTRE, which quietly made it height-dependent — the eye rides 1.58 m up
 * while a doorway the player BUILT on a 2.5 m storey is only 1.67 m tall, so
 * its centre sits ~0.7 m BELOW the eye and half the 1.2 m budget went
 * straight UP: E stopped answering at arm's length in front of an open
 * doorway (owner QA 2026-09-01), and host doors lost the last 20 cm of their
 * range for the same reason. "Shoulders against the leaf" is a HORIZONTAL
 * notion; this band is only here to keep the door one storey up — or one
 * storey down — from answering. */
export const DOOR_FALLBACK_RISE = 0.6
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
  /** `arm0` in the LEAF's own frame. The swing is a rotation about the leaf's
   * local vertical (that is the edge buildHingedRig picked, and the side the
   * player is on is judged in the same frame — see toggleOperable), so the arm
   * has to cross into that frame before being swung and back out after. For a
   * yaw-only rest pose it equals `arm0` turned by −yaw; for a tilted one it is
   * the only version that keeps the pivot still. */
  armBody: Vector3
  /** Swing direction chosen when the door opens (±1). */
  sign: number
}

export type OperableState = {
  kind: OperableKind
  nodeId: string
  root: Object3D
  node: Record<string, unknown> | null
  /** Prompt noun override — a GAME-BUILT casement sash swings exactly like a
   * door leaf (kind 'door-hinged'), but the player must read "window". Absent
   * on host nodes, where the kind already carries the noun. */
  noun?: 'door' | 'window'
  colliders: ColliderEntry[]
  /** World-space collider bounds at snapshot time — THE DOORWAY, which stays
   * where the frame is however far the leaf has swung out of it. The
   * point-blank fallback stands the player against this. */
  mountBox: Box3
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

// ── Shared operable state ---------------------------------------------------

export const OPERABLE_KIND = 'boots/operable' as const
export const OPERABLE_COMMAND_KIND = 'boots/operable-command' as const
const OPERABLE_SYNC_CAP = 128

type OperableWire = [nodeId: string, open: 0 | 1, hingeSign: -1 | 1]
type OperableFrame = { v: 1; s: OperableWire[] }
type OperableCommandFrame = { v: 1; c: Array<[string, number, 0 | 1, -1 | 1]> }

let operableSyncActive = false
let operableRevision = 0
let operablePublishClock = 0
let operableHandoffAccepted = false
const operableCommands = new Map<string, [number, 0 | 1, -1 | 1]>()
const pendingOperables = new Map<string, { open: boolean; sign: -1 | 1 }>()
const seenOperableRevision = new Map<string, number>()
let offOperableState: (() => void) | null = null
let offOperableCommand: (() => void) | null = null
let offOperableRequest: (() => void) | null = null
let offOperableSnapshot: (() => void) | null = null

export function readOperableFrame(data: unknown): OperableFrame | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (raw.v !== 1 || !Array.isArray(raw.s) || raw.s.length > OPERABLE_SYNC_CAP) return null
  const states: OperableWire[] = []
  for (const entry of raw.s) {
    if (!Array.isArray(entry) || entry.length !== 3) return null
    const [id, open, sign] = entry
    if (typeof id !== 'string' || id.length === 0 || id.length > 160) return null
    if ((open !== 0 && open !== 1) || (sign !== -1 && sign !== 1)) return null
    states.push([id, open, sign])
  }
  return { v: 1, s: states }
}

export function readOperableCommand(data: unknown): OperableCommandFrame | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (raw.v !== 1 || !Array.isArray(raw.c) || raw.c.length > OPERABLE_SYNC_CAP) return null
  const commands: OperableCommandFrame['c'] = []
  for (const entry of raw.c) {
    if (!Array.isArray(entry) || entry.length !== 4) return null
    const [id, revision, open, sign] = entry
    if (
      typeof id !== 'string' || id.length === 0 || id.length > 160 ||
      !Number.isInteger(revision) || revision < 0 || revision > 1_000_000_000 ||
      (open !== 0 && open !== 1) || (sign !== -1 && sign !== 1)
    ) return null
    commands.push([id, revision, open, sign])
  }
  return { v: 1, c: commands }
}

function operableSnapshot(): OperableFrame {
  const states: OperableWire[] = []
  if (activeStates) {
    for (const state of activeStates.values()) {
      if (states.length >= OPERABLE_SYNC_CAP) break
      const sign = state.hinged?.sign === -1 ? -1 : 1
      states.push([state.nodeId, state.open ? 1 : 0, sign])
    }
  }
  return { v: 1, s: states }
}

function applyOperableState(nodeId: string, open: boolean, sign: -1 | 1): void {
  pendingOperables.set(nodeId, { open, sign })
  const state = activeStates?.get(nodeId)
  if (!state) return
  if (state.open === open) {
    if (open && state.hinged && state.hinged.sign !== sign) {
      state.hinged.sign = sign
      applyPose(state)
      refreshColliderTransforms(state)
    }
    return
  }
  toggleOperable(state, { sign, broadcast: false })
}

function applyOperableFrame(frame: OperableFrame, sender: string | null): void {
  const authority = hordeAuthorityId()
  if (sender && authority && sender !== authority) {
    // A lower-id late joiner becomes authority before its request reaches the
    // incumbent. Adopt one incumbent snapshot, then reject every non-authority
    // state thereafter. This preserves already-open doors through handoff.
    if (authority !== localSessionId() || operableHandoffAccepted || pendingOperables.size > 0) return
    operableHandoffAccepted = true
  }
  if (sender && sender === localSessionId()) return
  for (const [nodeId, open, sign] of frame.s) applyOperableState(nodeId, open === 1, sign)
}

function publishOperableSnapshot(): void {
  if (operableSyncActive) publishFrame(OPERABLE_KIND, operableSnapshot())
}

function publishOperableCommands(): void {
  const c: OperableCommandFrame['c'] = []
  for (const [nodeId, [revision, open, sign]] of operableCommands) {
    c.push([nodeId, revision, open, sign])
  }
  publishFrame(OPERABLE_COMMAND_KIND, { v: 1, c } satisfies OperableCommandFrame)
}

function publishLocalOperableChange(state: OperableState): void {
  if (!operableSyncActive) return
  const mine = localSessionId()
  if (!mine || hordeAuthorityId() === mine) {
    publishOperableSnapshot()
    return
  }
  const sign = state.hinged?.sign === -1 ? -1 : 1
  operableCommands.set(state.nodeId, [++operableRevision, state.open ? 1 : 0, sign])
  publishOperableCommands()
}

/** Bind after presence has opened the shared transport. */
export function startOperableSync(): void {
  if (operableSyncActive) return
  operableSyncActive = true
  registerFrameKind(OPERABLE_KIND, readOperableFrame)
  registerFrameKind(OPERABLE_COMMAND_KIND, readOperableCommand, { ordered: false })
  offOperableState = onFrame<OperableFrame>(OPERABLE_KIND, (msg) => {
    applyOperableFrame(msg.data, msg.sessionId)
  })
  offOperableCommand = onFrame<OperableCommandFrame>(OPERABLE_COMMAND_KIND, (msg) => {
    if (hordeAuthorityId() !== localSessionId()) return
    let changed = false
    for (const [nodeId, revision, open, sign] of msg.data.c) {
      const key = `${msg.sessionId}:${nodeId}`
      if (revision <= (seenOperableRevision.get(key) ?? -1)) continue
      seenOperableRevision.set(key, revision)
      applyOperableState(nodeId, open === 1, sign)
      changed = true
    }
    if (changed) publishOperableSnapshot()
  })
  offOperableSnapshot = onStateSnapshot(OPERABLE_KIND, ({ state, msg }) => {
    const frame = readOperableFrame(state)
    if (frame) applyOperableFrame(frame, msg.sessionId)
  })
  offOperableRequest = onStateRequest(({ of, from }) => {
    // Any existing peer can supply the handoff snapshot. applyOperableFrame
    // still admits only the elected authority (or one pristine handoff).
    if (of === OPERABLE_KIND) {
      sendStateSnapshot(OPERABLE_KIND, from, operableSnapshot())
    }
  })
  requestState(OPERABLE_KIND)
}

export function stopOperableSync(): void {
  if (!operableSyncActive) return
  operableSyncActive = false
  offOperableState?.()
  offOperableCommand?.()
  offOperableRequest?.()
  offOperableSnapshot?.()
  offOperableState = offOperableCommand = offOperableRequest = offOperableSnapshot = null
  operableCommands.clear()
  pendingOperables.clear()
  seenOperableRevision.clear()
  operableRevision = 0
  operablePublishClock = 0
  operableHandoffAccepted = false
}

/** Low-rate retained heartbeat: heals a coalesced command/state without
 * turning an animated door into a high-frequency network stream. */
export function stepOperableSync(dt: number): void {
  if (!operableSyncActive) return
  operablePublishClock += Math.max(0, dt)
  if (operablePublishClock < 0.5) return
  operablePublishClock = 0
  if (hordeAuthorityId() === localSessionId()) publishOperableSnapshot()
  else if (operableCommands.size > 0) publishOperableCommands()
}

const UP = new Vector3(0, 1, 0)
const tmpVec = new Vector3()
const tmpQuat = new Quaternion()
const tmpMat = new Matrix4()
const tmpBox = new Box3()
const _aimRay = new Ray()
const _localRay = new Ray()
const _inverse = new Matrix4()
const _boxHit = new Vector3()

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

/**
 * Retire a bake that no longer describes the pose. Two cases:
 *
 *  - a DORMANT prebuild on a node we are ABOUT to pose: it was baked at the
 *    pose we are leaving, so it would wake wrong (see the header block).
 *  - an AWAKE grid that was baked MID-SWING and now stands where the leaf
 *    isn't: destruction.resyncPosedTarget compares the leaf's live world
 *    matrices against the ones the grid was baked from. It prefers to RE-POSE
 *    the grid onto the leaf, so the player's holes travel with the swing; it
 *    hands the node back only where a rigid re-pose isn't sound, healing the
 *    holes — which still beats a solid voxel ghost hanging in the doorway,
 *    blocking shots in mid-air, for the rest of the session.
 *
 * Returns whether destruction gave the node BACK — so FALSE for a re-pose,
 * where destruction keeps it, as well as for a dormant prebuild (which never
 * owned it) and for a grid that never went stale. Only a handback latches the
 * node solid, so only a handback needs the caller to re-assert posture.
 */
function retireStaleBake(nodeId: string): boolean {
  const target = useDestruction.getState().targets.get(nodeId)
  if (target?.dormant) {
    dropTarget(nodeId)
    return false
  }
  return resyncPosedTarget(nodeId)
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
    // Orientation and position have to be swung in the SAME frame or the
    // pivot walks. The line above turns the leaf about its own vertical
    // (quaternion0 · swing); the arm therefore has to be swung there too and
    // brought back to parent space, which is what armBody + quaternion0 do.
    // Rotating the parent-space arm by the body-space swing directly is only
    // right when the two commute — i.e. when the rest pose is yaw-only, which
    // hid this for as long as every door hung in an upright wall.
    tmpVec.copy(rig.armBody).applyQuaternion(tmpQuat).applyQuaternion(rig.quaternion0)
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
export function toggleOperable(
  state: OperableState,
  sync?: { sign?: -1 | 1; broadcast?: boolean },
): void {
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
      if (sync?.sign !== undefined) state.hinged.sign = sync.sign
      else {
        tmpVec.copy(playerRig.position).applyMatrix4(state.hinged.inverse0)
        state.hinged.sign = tmpVec.z >= 0 ? 1 : -1
      }
    }
    if (state.passable) setOpenColliders(state)
  }
  // The pose is about to change — a dormant prebuild baked at the old pose
  // would wake wrong (see the header block).
  retireStaleBake(state.nodeId)
  sfx.doorCreak()
  if (sync?.broadcast !== false) publishLocalOperableChange(state)
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
      // A bake that landed MID-SWING froze the grid at a pose the leaf has
      // now left. Retire it HERE, before the re-latch below reads isVoxelized,
      // so a leaf that ends shut really does latch solid and retire its prism
      // instead of staying walk-through behind a ghost grid.
      if (retireStaleBake(state.nodeId) && state.open && state.passable) {
        // The handback latches the node solid; an OPEN doorway has to go back
        // to pass-through-for-feet, live-for-bullets. The prism stayed
        // registered through the handback, so only the flags need re-asserting
        // (setOpenColliders would register it a second time).
        for (const collider of state.colliders) {
          collider.disabled = true
          collider.ballistic = true
        }
        state.ballistic = true
      }
      if (!state.open && state.passable) {
        // FULLY SHUT. The passage prism is the aperture's relief in every lane
        // (feet, bullets, drawn cubes, framing sticks), so it retires with the
        // leaf REGARDLESS of who owns the node — a shut door standing behind a
        // live prism is a hole in the wall that nothing can see: walk-through,
        // undrawable, and still stopping bullets on the cells the prism misses.
        //
        // Whether the HOST collides again is a different question, and the
        // answer is no while destruction holds the node: a re-posed voxel leaf
        // (destruction.ts reposePosedTarget) settles here still voxelized, with
        // the host hidden and its colliders disabled, and its grid — which now
        // stands on the leaf and carries the player's damage — does the
        // colliding. Re-enabling the host underneath it would collide the same
        // door twice, once through geometry with no holes in it. The ballistic
        // exception is likewise the grid's to answer, and the stand-down pass
        // in the frame loop clears it (clearBallistic).
        if (!isVoxelized(state.nodeId)) {
          for (const collider of state.colliders) {
            collider.disabled = false
            collider.ballistic = false
          }
          state.ballistic = false
        }
        if (state.passage) unregisterPassage(state.passage)
        sfx.doorLatch()
      }
    }
  }
}

// ---------------------------------------------------------------------------
// State building + mount/unmount (exported for headless tests)
// ---------------------------------------------------------------------------

function collidersOf(
  world: GameWorld,
  colliderIndices: readonly number[],
): { colliders: ColliderEntry[]; bounds: Box3 } | null {
  const colliders: ColliderEntry[] = []
  const worldBounds = new Box3()
  for (const index of colliderIndices) {
    const collider = world.colliders[index]
    if (!collider) continue
    colliders.push(collider)
    worldBounds.union(collider.worldBox)
  }
  if (colliders.length === 0 || worldBounds.isEmpty()) return null
  return { colliders, bounds: worldBounds }
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
  const arm0 = position0.clone().sub(hingeLocal)
  return {
    position0,
    quaternion0,
    inverse0,
    hingeLocal,
    arm0,
    armBody: arm0.clone().applyQuaternion(quaternion0.clone().invert()),
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
    mountBox: picked.bounds,
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
  // GAME-BUILT doors/windows are a RETAINED FACT, not an event (the
  // publishGridStamp pattern): a piece can be placed — or arrive from a peer —
  // before this component mounts, and it must still answer E. They keep their
  // live state across a remount; no restore ledger, since their meshes are the
  // plugin's own and die with the session.
  for (const [nodeId, state] of gameOperables) states.set(nodeId, state)
  activeStates = states
  for (const [nodeId, pending] of pendingOperables) {
    if (states.has(nodeId)) applyOperableState(nodeId, pending.open, pending.sign)
  }
  return states
}

// ---------------------------------------------------------------------------
// GAME-BUILT operables (the builder's door/window wall pockets)
// ---------------------------------------------------------------------------

/**
 * One door/window the PLAYER built. fittings.tsx owns the leaf mesh and its
 * collider; this lane owns the swing, the prompt and E.
 *
 * There is no host node behind it, which is exactly what `classifyOperable`
 * calls a plain hinged door — and a casement sash swings the same way, so a
 * built window is a hinged operable too, wearing `noun: 'window'` for the
 * prompt. The rig hinges on the root's local −X edge (buildHingedRig), so the
 * caller puts the root AT the hinge with the leaf reaching +X.
 */
export type GameOperableSpec = {
  /** Unique, '__boots'-prefixed (the prevoxelize guard keys off it). */
  nodeId: string
  /** Hinge frame: the leaf's parent group, at the hinge, yawed with the wall. */
  root: Object3D
  /** The leaf's own collider entries (already pushed on world.colliders). */
  colliders: ColliderEntry[]
  noun: 'door' | 'window'
  /** Register a doorway passage prism while open. Doors yes — the player walks
   * through. Windows NO: nothing crosses a chest-high sash, and a prism there
   * would relieve real wall contacts for no gain. */
  passage: boolean
  /** Raise the prism's ceiling to this world Y — the wall's TOP. A built
   * doorway is two cells tall (2·span/3 ≈ 1.87 m on a classic storey, but
   * only 1.67 m on a 2.5 m one) and the capsule is 1.78 m: without this the
   * LINTEL cell above the leaf pinches the head and the player stands in an
   * open doorway unable to cross. The prism only relieves NON-GROUND contacts
   * inside the opening, so this buys the crossing nothing else. */
  passageTop?: number
}

/** Live game-built operables, by nodeId — the retained facts mountInteract
 * drains. Survives an interact remount; each fitting unregisters its own. */
const gameOperables = new Map<string, OperableState>()

/** Hang a built door/window on the E lane. Re-registering the same nodeId
 * replaces it (a mask edit re-mints the leaf). Returns the live state, or null
 * when there is nothing to hang (no colliders / empty bounds). */
export function registerGameOperable(spec: GameOperableSpec): OperableState | null {
  unregisterGameOperable(spec.nodeId)
  if (spec.colliders.length === 0) return null
  const bounds = new Box3()
  for (const collider of spec.colliders) bounds.union(collider.worldBox)
  if (bounds.isEmpty()) return null
  const passage = spec.passage ? buildPassageBox(spec.colliders) : null
  if (passage && spec.passageTop !== undefined && spec.passageTop > passage.max.y) {
    passage.max.y = spec.passageTop
  }
  const state: OperableState = {
    kind: 'door-hinged',
    nodeId: spec.nodeId,
    root: spec.root,
    node: null,
    noun: spec.noun,
    colliders: spec.colliders,
    mountBox: bounds,
    passable: true,
    passage,
    ballistic: false,
    value: 0,
    open: false,
    from: 0,
    to: 0,
    animT: DURATIONS['door-hinged'],
    duration: DURATIONS['door-hinged'],
    restoreValue: 0,
    hinged: buildHingedRig(spec.root, spec.colliders),
  }
  gameOperables.set(spec.nodeId, state)
  activeStates?.set(spec.nodeId, state)
  const pending = pendingOperables.get(spec.nodeId)
  if (pending) applyOperableState(spec.nodeId, pending.open, pending.sign)
  return state
}

/** Drop a built door/window (the piece was undone, collapsed, re-masked, or
 * the session ended). The caller still owns its collider entries. */
export function unregisterGameOperable(nodeId: string): void {
  const state = gameOperables.get(nodeId)
  if (!state) return
  gameOperables.delete(nodeId)
  if (activeStates?.get(nodeId) === state) activeStates.delete(nodeId)
  if (state.passage) unregisterPassage(state.passage)
}

/** Test isolation / hard session reset — every built operable forgotten. */
export function resetGameOperables(): void {
  for (const nodeId of [...gameOperables.keys()]) unregisterGameOperable(nodeId)
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
 * state's collider BVHs — behind a ray-vs-AABB cull, and in their LIVE
 * frames: the swing refreshes each
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
      // Broadphase, the same one the bullet lane has had since the minigun
      // first-fire freeze (shooting.ts fireShot): a ray that never ENTERS the
      // collider's world AABB cannot hit the geometry inside it, and the test
      // costs nanoseconds. Cull on a miss only — a ray whose origin is INSIDE
      // the box gets an exit point back, so the point-blank door still answers.
      //
      // It matters far past the cull: `collider.bvh` is a lazy getter that
      // BUILDS on read, and this probe runs every frame over every operable.
      // Measured 2026-08-31 in the owner's scene: 76 of the 118 main-thread
      // BVH builds in a session came from right here, which is most of what the
      // background worker queue exists to keep OFF the main thread. The queue
      // was not failing — this loop was simply asking first.
      if (_aimRay.intersectBox(collider.worldBox, _boxHit) === null) continue
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

/**
 * Point-blank fallback: the nearest DOOR the player is standing at —
 * shoulders-against-the-leaf territory where the crosshair may look past the
 * jamb, or straight through an open doorway that has nothing left to hit.
 *
 * `position` is the EYE (playerRig.position), so the measurement is
 * HORIZONTAL distance to the doorway's footprint plus a vertical band around
 * its own extent (DOOR_FALLBACK_RISE). Distance to the leaf's centre would be
 * a different range at every door height — see DOOR_FALLBACK_RISE for the
 * doorway that made E stop answering. The footprint is the MOUNT-pose box: the
 * doorway you are standing in, not wherever the leaf swung to.
 *
 * Windows/cabinets stay aim-only (you don't lean on a cabinet expecting it to
 * open). Pure — exported for tests.
 */
export function nearestDoorFallback(
  states: Iterable<OperableState>,
  position: Vector3,
  range = DOOR_FALLBACK_RANGE,
): OperableState | null {
  let best: OperableState | null = null
  let bestSq = range * range
  for (const state of states) {
    if (state.kind !== 'door-hinged' && state.kind !== 'door-operation') continue
    // A built window sash is a hinged operable (see GameOperableSpec) — but it
    // is still a window: aim-only, or standing beside one would steal the
    // point-blank prompt from the door you are actually leaning on.
    if (state.noun === 'window') continue
    if (standsDown(state)) continue
    const box = state.mountBox
    // The band first: it is what separates the door under your hand from the
    // one on the storey above, and it costs two compares.
    if (position.y < box.min.y - DOOR_FALLBACK_RISE) continue
    if (position.y > box.max.y + DOOR_FALLBACK_RISE) continue
    const dx = Math.max(box.min.x - position.x, 0, position.x - box.max.x)
    const dz = Math.max(box.min.z - position.z, 0, position.z - box.max.z)
    const dSq = dx * dx + dz * dz
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
/** interactDebug.aimed()'s own direction — never the frame loop's. */
const _dbgAim = new Vector3()

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
    stepOperableSync(dt)

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
      liveDepotLocalToWorld(
        world,
        ARMORY_STATION_LOCAL[0],
        ARMORY_STATION_LOCAL[1],
        table.position,
      )
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
      ? `E — ${target.open ? 'Close' : 'Open'} ${target.noun ?? operableNoun(target.kind)}`
      : null
    if (prompt !== lastPrompt.current) {
      lastPrompt.current = prompt
      // hud.prompt(null, 'doors') clears text + fades while we own the line;
      // we run at priority -1, so a same-frame guntable show lands after us.
      session.hud.prompt(prompt, 'doors')
    }

    // E — take the one-shot 'KeyE' action from the input queue so a tap whose
    // keydown+keyup both land inside one frame still registers (per-frame keys
    // sampling misses it — see input.takeAction). This callback runs at priority
    // -1, before the viewmodel's consumeActions() drain, and claims the press
    // ONLY while an operable is aimed at. The gun tables keep their priority:
    // while either is busy `target` is null, so the short-circuit leaves the
    // queue untouched, and they read the keys set — never the queue.
    if (target && takeAction(session.input.state.actions, 'KeyE')) {
      toggleOperable(target)
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
  /**
   * What the crosshair is on RIGHT NOW — the frame loop's own two-step, run on
   * demand: pickAimedOperable, then the point-blank door fallback, with `via`
   * saying which answered.
   *
   * The aim lane had no headless reading at all: QA could only infer it from
   * whether pressing E happened to open a door, which also depends on where the
   * teleport landed and whether the walk that followed worked (doorsweep's
   * `openedVia`). That is far too noisy to certify a change to the pick itself —
   * and pickAimedOperable now culls each collider against its world AABB before
   * touching the lazy `bvh` getter, which is exactly the kind of change that
   * needs a direct, quiet measurement on the real scene.
   */
  aimed: (): { nodeId: string; kind: OperableKind; open: boolean; via: 'aim' | 'fallback' } | null => {
    if (!activeStates) return null
    const cp = Math.cos(playerRig.pitch)
    // Its own scratch vector: _aimDir belongs to the frame loop, and a debug
    // call landing between frames must not write to it.
    _dbgAim.set(-Math.sin(playerRig.yaw) * cp, Math.sin(playerRig.pitch), -Math.cos(playerRig.yaw) * cp)
    const aim = pickAimedOperable(activeStates.values(), playerRig.position, _dbgAim)
    const state = aim ?? nearestDoorFallback(activeStates.values(), playerRig.position)
    if (!state) return null
    return { nodeId: state.nodeId, kind: state.kind, open: state.open, via: aim ? 'aim' : 'fallback' }
  },
  /** Every live passage prism as plain data (what collision.ts is relieving). */
  passages: () => passageBoxes(),
  /** RENDER-LANE AGREEMENT: do the drawn cubes stand on the cells the collision
   * and ray lanes are using? (voxel-walls.replicaDrawAudit — the only view into
   * an InstancedMesh from QA, and the number that proves a re-posed door
   * re-primed its matrices instead of drawing at its old pose.) */
  drawAudit: (nodeId?: string) => replicaDrawAudit(nodeId),
  /** Would the VOXEL lane relieve a cell centered here for a capsule whose feet
   * are at `feetY`? (collision.ts::passageRelievesCell — the exact predicate
   * collideVoxelTargets consults.) Lets QA prove, cell by cell, that the
   * blockers standing in an open doorway are the ones being dropped. Pass
   * `cellHalf` (the grid's `cell * 0.55`, as `occupancy` reports it) to ask the
   * question the collision really asks — cube overlap, not centre containment. */
  relievesCell: (x: number, y: number, z: number, feetY: number, cellHalf = 0): boolean =>
    passageRelievesCell(x, y, z, feetY, cellHalf),
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
                  cell: +target.grid.cell.toFixed(4),
                  /** How many times the grid FRAME has been rigidly re-posed
                   * onto the leaf (destruction.ts reposePosedTarget): 0 = it
                   * still stands where it baked, which for a door that has
                   * swung since means the settle handed the node back
                   * instead. */
                  poseRevision: target.poseRevision ?? 0,
                }
              : null,
          }
        })
      : [],
}
