'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import { Box3, Matrix4, type Object3D, Quaternion, Vector3 } from 'three'
import { useBoots } from '../store'
import { sfx } from './audio'
import { useDestruction } from './destruction'
import { tablePosition } from './guntable'
import { playerRig } from './player'
import { getSession } from './session'
import type { ColliderEntry, DoorEntry, GameWorld } from './world'

/**
 * Interactive doors: walk up, press E, the panel swings ~100° on its hinge
 * (the -X vertical edge of its local bounds) with a short ease-out. The
 * swing mutates only the HOST root's position/quaternion — originals live
 * in a module restore ledger that unmount unwinds, so exit leaves the
 * editor exactly as it was. While open or mid-swing the door's colliders
 * are disabled (players and bullets pass through the opening).
 */

const INTERACT_RANGE = 2.2
const TABLE_RANGE = 2.4
const OPEN_ANGLE = (100 * Math.PI) / 180
const SWING_SECONDS = 0.28

type DoorState = {
  entry: DoorEntry
  colliders: ColliderEntry[]
  /** World-space bounds center at snapshot time — proximity anchor. */
  center: Vector3
  /** Original parent-local pose (also mirrored in the restore ledger). */
  position0: Vector3
  quaternion0: Quaternion
  /** Inverse of the original matrixWorld — for player-side swing choice. */
  inverse0: Matrix4
  /** Hinge pivot in parent-local space + the original pivot→position arm. */
  hingeLocal: Vector3
  arm0: Vector3
  open: boolean
  angle: number
  fromAngle: number
  toAngle: number
  /** Seconds into the current swing; >= SWING_SECONDS means settled. */
  animT: number
}

/** nodeId → original pose of the HOST door root. Unmount restores ALL. */
const restoreLedger = new Map<string, { root: Object3D; position0: Vector3; quaternion0: Quaternion }>()

/** The mounted component's doors — doorsDebug reaches them through here. */
let activeDoors: Map<string, DoorState> | null = null

const UP = new Vector3(0, 1, 0)
const tmpVec = new Vector3()
const tmpQuat = new Quaternion()
const tmpMat = new Matrix4()
const tmpBox = new Box3()

/** Once gunfire voxelizes a door, destruction owns its colliders and its
 * mesh is hidden — the door system must stand down (no prompt, no swing,
 * and NEVER re-enable colliders over the carved voxel grid). */
function isVoxelized(nodeId: string): boolean {
  return useDestruction.getState().targets.has(nodeId)
}

function easeOutCubic(k: number): number {
  const inv = 1 - k
  return 1 - inv * inv * inv
}

function applyDoorPose(door: DoorState): void {
  const root = door.entry.root
  tmpQuat.setFromAxisAngle(UP, door.angle)
  root.quaternion.multiplyQuaternions(door.quaternion0, tmpQuat)
  tmpVec.copy(door.arm0).applyQuaternion(tmpQuat)
  root.position.copy(door.hingeLocal).add(tmpVec)
}

function toggleDoor(door: DoorState): void {
  door.open = !door.open
  door.fromAngle = door.angle
  door.animT = 0
  if (door.open) {
    // Swing away from whichever side the player stands on (original frame:
    // positive local angle carries the +X panel toward -Z).
    tmpVec.copy(playerRig.position).applyMatrix4(door.inverse0)
    const sign = tmpVec.z >= 0 ? 1 : -1
    door.toAngle = sign * OPEN_ANGLE
    for (const collider of door.colliders) collider.disabled = true
    sfx.doorCreak()
  } else {
    door.toAngle = 0
    sfx.doorCreak()
  }
}

function buildDoorState(entry: DoorEntry, world: GameWorld): DoorState | null {
  const root = entry.root
  const colliders: ColliderEntry[] = []
  const worldBounds = new Box3()
  for (const index of entry.colliderIndices) {
    const collider = world.colliders[index]
    if (!collider) continue
    colliders.push(collider)
    worldBounds.union(collider.worldBox)
  }
  if (colliders.length === 0 || worldBounds.isEmpty()) return null

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
    entry,
    colliders,
    center: worldBounds.getCenter(new Vector3()),
    position0,
    quaternion0,
    inverse0,
    hingeLocal,
    arm0: position0.clone().sub(hingeLocal),
    open: false,
    angle: 0,
    fromAngle: 0,
    toAngle: 0,
    animT: SWING_SECONDS,
  }
}

export function Doors({ world }: { world: GameWorld }) {
  const doorsRef = useRef<Map<string, DoorState> | null>(null)
  const tableRef = useRef<Vector3 | null>(null)
  const lastPrompt = useRef<string | null>(null)

  useEffect(() => {
    const doors = new Map<string, DoorState>()
    for (const entry of world.doors) {
      const state = buildDoorState(entry, world)
      if (!state) continue
      doors.set(entry.nodeId, state)
      restoreLedger.set(entry.nodeId, {
        root: entry.root,
        position0: state.position0,
        quaternion0: state.quaternion0,
      })
    }
    doorsRef.current = doors
    tableRef.current = tablePosition(world)
    activeDoors = doors
    return () => {
      // THE invariant: put every host door back exactly where the editor had it.
      for (const { root, position0, quaternion0 } of restoreLedger.values()) {
        root.position.copy(position0)
        root.quaternion.copy(quaternion0)
        root.updateWorldMatrix(false, true)
      }
      restoreLedger.clear()
      for (const door of doors.values()) {
        for (const collider of door.colliders) collider.disabled = false
      }
      if (activeDoors === doors) activeDoors = null
      doorsRef.current = null
      lastPrompt.current = null
    }
  }, [world])

  // Priority -1: R3F runs subscribers in ascending priority order, so this
  // executes before every default-0 callback — critically the viewmodel,
  // whose consumeActions() drains the one-shot input queue we take 'KeyE'
  // from (negative priorities keep auto-render; only >0 goes manual).
  // Reading playerRig here is one callback earlier than before — at most a
  // frame of proximity staleness, irrelevant at INTERACT_RANGE.
  useFrame((_, rawDt) => {
    const session = getSession()
    const doors = doorsRef.current
    if (!session || !doors) return
    const dt = Math.min(rawDt, 1 / 30)

    // Advance swings.
    for (const door of doors.values()) {
      if (door.animT >= SWING_SECONDS) continue
      door.animT += dt
      const k = Math.min(1, door.animT / SWING_SECONDS)
      door.angle = door.fromAngle + (door.toAngle - door.fromAngle) * easeOutCubic(k)
      applyDoorPose(door)
      if (door.animT >= SWING_SECONDS) {
        door.angle = door.toAngle
        applyDoorPose(door)
        if (!door.open && !isVoxelized(door.entry.nodeId)) {
          // Fully shut: solid again, latch catches.
          for (const collider of door.colliders) collider.disabled = false
          sfx.doorLatch()
        }
      }
    }

    // Nearest door in reach.
    let nearest: DoorState | null = null
    let bestSq = INTERACT_RANGE * INTERACT_RANGE
    for (const door of doors.values()) {
      if (isVoxelized(door.entry.nodeId)) continue // shot to bits — no longer a door
      const dSq = door.center.distanceToSquared(playerRig.position)
      if (dSq < bestSq) {
        bestSq = dSq
        nearest = door
      }
    }

    // The gun table owns the prompt + E while the player is gearing up there.
    const table = tableRef.current
    const tableBusy =
      table !== null &&
      !useBoots.getState().owned.includes('rifle') &&
      Math.hypot(playerRig.position.x - table.x, playerRig.position.z - table.z) < TABLE_RANGE
    if (tableBusy) nearest = null

    const prompt = nearest ? (nearest.open ? 'E — Close door' : 'E — Open door') : null
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
    // KeyE entries, in place, and only while a door has the press. The gun
    // table keeps its priority: while it is busy `nearest` is null, the
    // queue is left alone, and it reads the keys set — never the queue.
    if (nearest) {
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
        toggleDoor(nearest)
      }
    }
  }, -1)

  return null
}

/** Manager wiring for __boots: inspect/flip doors headlessly. */
export const doorsDebug = {
  list: (): Array<{ nodeId: string; open: boolean }> =>
    activeDoors
      ? Array.from(activeDoors.values(), (door) => ({ nodeId: door.entry.nodeId, open: door.open }))
      : [],
  toggle: (nodeId: string): void => {
    const door = activeDoors?.get(nodeId)
    if (door && !isVoxelized(nodeId)) toggleDoor(door)
  },
}
