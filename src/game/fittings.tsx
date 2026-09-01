'use client'

import { useLayoutEffect, useMemo, useRef } from 'react'
import { Matrix4, type Group, type Mesh } from 'three'
import { type PlacedPiece, useBoots } from '../store'
import { CELLS, maskBit, PIECE_DIMS, planWallMask, WALL_H } from './builder'
import { registerGameOperable, unregisterGameOperable } from './interact'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE DOOR AND THE WINDOW THE PLAYER BUILT.
 *
 * A built aperture is a WALL with its middle column pocketed — see THE WALL
 * FAMILY in builder.tsx. That mask already carves the hole out of the mesh,
 * the collider and the voxel replica, and it already replicates to every peer
 * and maps to a real host node on Keep. What it does NOT carry is the moving
 * part: the leaf you swing with E. This module derives it.
 *
 * DERIVED, NEVER STORED. planFitting reads the piece's own mask and returns
 * the leaf's frame; nothing here is persisted, replicated or saved. So:
 *   - a peer's door arrives as a piece record and grows the same leaf on
 *     every client — the shared world stays a lattice of pieces;
 *   - an F-edit that re-masks the wall swaps the piece object, the effect
 *     re-runs, and the leaf follows (or disappears, if the pocket is gone);
 *   - undo / collapse / Keep unmount it with the piece.
 *
 * THE HINGE. The rendered group sits AT the hinge — the pocket's local −X
 * jamb, at the sill — yawed with the wall, with the leaf reaching local +X.
 * That is exactly the frame interact.buildHingedRig expects, so the swing is
 * the host doors' swing: ±100° about the leaf's own vertical, away from
 * whichever side the player stands on.
 *
 * INDESTRUCTIBLE, mechanically (the depot's 'fixture' lane): the leaf blocks
 * movement and bullets while shut, sparks when hit, and never voxelizes — its
 * nodeId is '__boots'-prefixed, which destruction's prevoxelize guard skips,
 * and 'fixture' sits outside every DESTRUCTIBLE/EXPLODABLE set. A door that
 * could be shredded off its hinges would leave the E prompt hanging on a
 * leaf that no longer exists; shoot the WALL instead, that is the game.
 */

/** Gap (m) left between the leaf and the pocket it hangs in, so a swing never
 * grazes the jamb and the shut leaf reads as a leaf, not as filled wall. */
const REVEAL = 0.02

/** Leaf thickness (m) — inside the 0.12 m wall, centered in it. */
const LEAF_THICKNESS = 0.07

/** The plan for one built aperture's moving part, in WORLD space. Pure data —
 * planFitting is the whole contract and the unit-tested part. */
export type FittingPlan = {
  kind: 'door' | 'window'
  /** Hinge frame origin: the pocket's local −X jamb at the leaf's BOTTOM. */
  hinge: [number, number, number]
  /** Frame yaw — the wall's own. */
  yaw: number
  /** Leaf size: `width` reaches local +X from the hinge, `height` up. */
  width: number
  height: number
  thickness: number
  /** World Y of the wall's top — the passage prism's ceiling (see
   * GameOperableSpec.passageTop: the lintel over a short doorway). */
  wallTopY: number
}

/**
 * The moving part a placed piece needs, or null for the (overwhelming)
 * majority that need none: anything but a wall, and any wall whose mask
 * planWallMask does not read as a window/door pocket.
 *
 * The pocket's dead cells decide the aperture: its lowest dead row is the
 * sill and its highest is the head, so a door (rows 0–1 dead) hangs
 * 2·span/3 tall off the wall base and a window (row 1) is a span/3 opening at
 * chest height. Deriving it from the ROWS rather than from the preset means a
 * hand-carved pocket — an F-edit that happens to land on the pattern — grows
 * a working door too.
 */
export function planFitting(
  piece: Pick<PlacedPiece, 'piece' | 'position' | 'yaw' | 'mask' | 'height'>,
): FittingPlan | null {
  if (piece.piece !== 'wall') return null
  const plan = planWallMask(piece.mask)
  if (plan.kind !== 'wall' || plan.pocket === 'none') return null
  const span = piece.height ?? WALL_H
  const cellW = PIECE_DIMS.wall[0] / CELLS
  const cellH = span / CELLS
  const col = plan.pocketCol
  let low = -1
  let high = -1
  for (let row = 0; row < CELLS; row++) {
    if (piece.mask & (1 << maskBit(col, row))) continue
    if (low < 0) low = row
    high = row
  }
  if (low < 0) return null // a pocket with no dead cell cannot happen — be safe
  const sillY = piece.position[1] + low * cellH
  const apertureH = (high - low + 1) * cellH
  // Hinge x in the wall's local frame: the pocket's −X jamb, plus the reveal.
  const localX = -PIECE_DIMS.wall[0] / 2 + col * cellW + REVEAL
  // Local +X maps to (cos yaw, −sin yaw) on XZ — the trimmedWallSpan
  // convention, i.e. a three.js Y rotation.
  const dx = Math.cos(piece.yaw)
  const dz = -Math.sin(piece.yaw)
  // A door stands ON its sill (a threshold gap would be a trip hazard the
  // capsule can't see); a sash floats inside its opening, reveal all round.
  const bottomInset = plan.pocket === 'door' ? 0 : REVEAL
  return {
    kind: plan.pocket === 'door' ? 'door' : 'window',
    hinge: [
      piece.position[0] + dx * localX,
      sillY + bottomInset,
      piece.position[2] + dz * localX,
    ],
    yaw: piece.yaw,
    width: cellW - REVEAL * 2,
    height: apertureH - bottomInset - REVEAL,
    thickness: LEAF_THICKNESS,
    wallTopY: piece.position[1] + span,
  }
}

/** Collider/operable nodeId for a piece's fitting. '__boots'-prefixed so
 * destruction's prevoxelize guard skips it (see the header). */
export function fittingNodeId(pieceId: number): string {
  return `__boots-fitting-${pieceId}`
}

/** One built door/window: the leaf mesh, its collider, and its E registration.
 * Keyed on the piece OBJECT upstream, so a mask edit remounts it. */
function Fitting({
  piece,
  plan,
  world,
}: {
  piece: PlacedPiece
  plan: FittingPlan
  world: GameWorld
}) {
  const rootRef = useRef<Group>(null)
  const leafRef = useRef<Mesh>(null)

  useLayoutEffect(() => {
    const root = rootRef.current
    const leaf = leafRef.current
    if (!root || !leaf) return
    root.updateWorldMatrix(true, true)
    if (!leaf.geometry.boundingBox) leaf.geometry.computeBoundingBox()
    const nodeId = fittingNodeId(piece.id)
    const entry: ColliderEntry = {
      mesh: leaf,
      // Lazy like every other plugin collider: most leaves never take a ray.
      get bvh() {
        return bvhFor(this.mesh)
      },
      inverse: new Matrix4().copy(leaf.matrixWorld).invert(),
      worldBox: leaf.geometry.boundingBox!.clone().applyMatrix4(leaf.matrixWorld),
      root: leaf,
      nodeId,
      nodeType: 'fixture',
    }
    world.colliders.push(entry)
    registerGameOperable({
      nodeId,
      root,
      colliders: [entry],
      noun: plan.kind,
      // Only a doorway is crossed — and its LINTEL has to stop pinching the
      // head while it stands open (see GameOperableSpec.passageTop).
      passage: plan.kind === 'door',
      passageTop: plan.wallTopY,
    })
    return () => {
      unregisterGameOperable(nodeId)
      entry.disabled = true
      const index = world.colliders.indexOf(entry)
      if (index !== -1) world.colliders.splice(index, 1)
    }
  }, [world, piece.id, plan])

  const door = plan.kind === 'door'
  return (
    <group
      position={plan.hinge}
      ref={rootRef}
      rotation={[0, plan.yaw, 0]}
      userData={{ __boots: true }}
    >
      <mesh
        castShadow
        position={[plan.width / 2, plan.height / 2, 0]}
        ref={leafRef}
      >
        <boxGeometry args={[plan.width, plan.height, plan.thickness]} />
        {door ? (
          <meshStandardMaterial color="#7c5a3c" metalness={0.05} roughness={0.75} />
        ) : (
          <meshStandardMaterial
            color="#9fd8e8"
            metalness={0.1}
            opacity={0.42}
            roughness={0.1}
            transparent
          />
        )}
      </mesh>
      {/* The furniture that makes it read at a glance: a door gets its handle
       * on the swinging (+X) side, a sash gets its frame. Decoration only —
       * neither collides (the leaf box above is the whole collider). */}
      {door ? (
        <mesh position={[plan.width - 0.1, plan.height * 0.45, plan.thickness]}>
          <boxGeometry args={[0.12, 0.04, 0.06]} />
          <meshStandardMaterial color="#d8c07a" metalness={0.7} roughness={0.3} />
        </mesh>
      ) : (
        <WindowSashFrame height={plan.height} thickness={plan.thickness} width={plan.width} />
      )}
    </group>
  )
}

/** Four thin bars around a sash pane — the glass alone reads as nothing. */
function WindowSashFrame({
  height,
  thickness,
  width,
}: {
  height: number
  thickness: number
  width: number
}) {
  const bar = 0.05
  const d = thickness * 1.05
  return (
    <group position={[width / 2, height / 2, 0]}>
      <mesh position={[0, height / 2 - bar / 2, 0]}>
        <boxGeometry args={[width, bar, d]} />
        <meshStandardMaterial color="#e6e9ec" roughness={0.6} />
      </mesh>
      <mesh position={[0, -height / 2 + bar / 2, 0]}>
        <boxGeometry args={[width, bar, d]} />
        <meshStandardMaterial color="#e6e9ec" roughness={0.6} />
      </mesh>
      <mesh position={[-width / 2 + bar / 2, 0, 0]}>
        <boxGeometry args={[bar, height - bar * 2, d]} />
        <meshStandardMaterial color="#e6e9ec" roughness={0.6} />
      </mesh>
      <mesh position={[width / 2 - bar / 2, 0, 0]}>
        <boxGeometry args={[bar, height - bar * 2, d]} />
        <meshStandardMaterial color="#e6e9ec" roughness={0.6} />
      </mesh>
    </group>
  )
}

/**
 * Plans by piece OBJECT. The store swaps a piece's object on every change
 * (placement, mask edit, exit transform) and keeps it otherwise, so this
 * hands out a STABLE plan identity per unchanged piece — which is what keeps
 * Fitting's effect from re-registering (and slamming shut) every open door on
 * the map each time anybody places a wall somewhere else.
 */
const planCache = new WeakMap<object, FittingPlan | null>()
function cachedPlan(piece: PlacedPiece): FittingPlan | null {
  let plan = planCache.get(piece)
  if (plan === undefined) {
    plan = planFitting(piece)
    planCache.set(piece, plan)
  }
  return plan
}

/**
 * Every built aperture's moving part, for EVERY player's pieces (a peer's door
 * is a piece record like any other, so it grows its leaf here too and anyone
 * can open it). Mounted next to PlacedPieces in game-root.
 */
export function PlacedFittings({ world }: { world: GameWorld }) {
  const placed = useBoots((s) => s.placed)
  const fittings = useMemo(() => {
    const out: Array<{ piece: PlacedPiece; plan: FittingPlan }> = []
    for (const piece of placed) {
      const plan = cachedPlan(piece)
      if (plan) out.push({ piece, plan })
    }
    return out
  }, [placed])
  return (
    <group userData={{ __boots: true }}>
      {fittings.map(({ piece, plan }) => (
        <Fitting key={piece.id} piece={piece} plan={plan} world={world} />
      ))}
    </group>
  )
}
