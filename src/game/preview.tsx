'use client'

import { sceneRegistry, useScene } from '@pascal-app/core'
import { useEffect, useMemo, useRef } from 'react'
import {
  Group,
  type Material,
  type Mesh,
  MeshStandardMaterial,
  type Object3D,
} from 'three'
import { type PlacedPiece, useBoots } from '../store'
import { geometryForMask, isForeignPlacedPiece, piecePose, WALL_H } from './builder'
import {
  ApertureStandIn,
  isForeignItemPlacement,
  mountItemVisual,
  type PlacedAperture,
  type PlacedItem,
  useItems,
  type WallFrame,
  wallPlacementFrame,
} from './item-place'
import { type PaintedNode, usePaintKeep } from './paint-keep'
import { cornerRoofGeometry } from './roof-corners'
import { type DestroyedNode, useDemolition } from './save-demolition'
import { collectMeshes, collectSolidRoots, type WallNodeLike } from './world'

/**
 * PENDING-CHANGES PREVIEW — the editor shows what Save would write, while
 * the decision is still open.
 *
 * Owner report: pressing Esc drops you back into the editor with the
 * Save/Discard choice still on the rail, but the viewport looks exactly as
 * if you had already discarded — the ramps you placed, the paint you laid
 * down, the walls you levelled are all invisible. You are asked to choose
 * without being shown either option. This module renders the pending side
 * of that choice.
 *
 * ── WHAT IT IS NOT ────────────────────────────────────────────────────────
 *  - NOT the game, kept alive read-only. ActiveGame drags in the world
 *    snapshot, prevoxelization, the player (which seizes the editor camera),
 *    enemies, colliders and the frame booster. This is a purpose-built tree:
 *    meshes, one imperative item mount, and a restore ledger. No useFrame,
 *    no camera, no colliders, no input.
 *  - NOT a new phase. `phase === 'editor' && pendingDecision` already means
 *    exactly "the Boots menu is showing the Save/Discard choice"; BootsPhase
 *    stays two values.
 *  - NOT a per-item toggle. Granularity is VIEW-ONLY (owner call): Save and
 *    Discard remain global, this only makes the pending state legible.
 *
 * ── THE NON-DESTRUCTIVE INVARIANT ─────────────────────────────────────────
 * The plugin's promise is that nothing but the Save button writes the scene
 * store. This module makes ZERO scene writes: its only `useScene` contact is
 * reading `.nodes` for a host wall's start/end (to pose a pending door). The
 * two lanes that must touch host objects at all — paint and demolition — go
 * through the RESTORE LEDGER below (the session.ts hideForGame pattern):
 * record the prior value, mutate the three.js object, restore
 * unconditionally on teardown. Nothing about the document changes, so
 * Discard really does leave the building exactly as it was.
 *
 * ── WHAT EACH LANE SHOWS ──────────────────────────────────────────────────
 * Per lane the preview shows WHAT SAVE WILL DO, not what the game looked
 * like — that is both cheaper and the honest thing to show for a Keep /
 * Discard decision:
 *  1. pieces   real geometry per `useBoots.placed`, from the same
 *              geometryForMask / cornerRoofGeometry / piecePose seams the
 *              in-game mesh uses, wearing the PENDING tint.
 *  2. items    the catalog asset itself (mountItemVisual), and the framed
 *              stand-in for a pending door/window on a host wall.
 *  3. paint    a material-colour override on the painted node's meshes.
 *              Save recolours the node to its ONE dominant coat, so the flat
 *              tint IS the truthful preview — the splatter art is game-only
 *              and reproducing it here would over-promise.
 *  4. levelled `visible = false` on the node root. Save's real effect is
 *              `deleteNodes` (descendant cascade), so hiding the subtree is
 *              faithful. RUBBLE IS NOT RECONSTRUCTIBLE — every voxel grid is
 *              destroyed at exit and only `{ nodeId, kind }` survives — so
 *              the preview does not attempt it.
 *
 * Only THIS player's work previews: in a shared world the stores also hold
 * what other people built, and Save writes only ours (keep.ts / item-keep.ts
 * filter identically), so previewing the whole list would promise to keep
 * walls that are not ours.
 *
 * WebGPU-safe, edit-overlay.tsx style: plain geometry, singleton materials,
 * no shaders, zero per-frame work.
 *
 * ── API (pure / imperative exports for tests) ─────────────────────────────
 *   shouldPreview(phase, pendingDecision, lanes)   the mount condition.
 *   applyNodePreview(destroyed, painted)           → PreviewLedger
 *   restoreNodePreview(ledger)                     idempotent round-trip.
 *   PENDING_TINT                                   the pieces' material.
 * ──────────────────────────────────────────────────────────────────────────
 */

// --- The mount condition ----------------------------------------------------

/** Non-empty lane counts, in the order the panel lists them. */
export type PreviewLanes = {
  pieces: number
  items: number
  destroyed: number
  painted: number
}

/**
 * Show the pending preview? Pure — this IS the mount condition, and it is
 * deliberately the same gate the panel's decision UI uses (panel.tsx),
 * plus `phase === 'editor'`:
 *
 *  - `phase !== 'editor'` — during play the game renders the real thing;
 *    a preview on top would be a second, stale copy of every piece.
 *  - `!pendingDecision` — the choice is not open (never played, or Save /
 *    Discard already resolved it, both of which clear the flag through
 *    `resolvePlaced`), so there is nothing pending to show.
 *  - every lane empty — nothing was changed; render no objects at all.
 */
export function shouldPreview(
  phase: string,
  pendingDecision: boolean,
  lanes: PreviewLanes,
): boolean {
  if (phase !== 'editor' || !pendingDecision) return false
  return lanes.pieces > 0 || lanes.items > 0 || lanes.destroyed > 0 || lanes.painted > 0
}

// --- The restore ledger (paint + demolition) --------------------------------

/** One recorded `visible` flip on a host object. */
type VisibleFlip = { object: Object3D; visible: boolean }

/** One recorded material swap: the mesh keeps the ORIGINAL instance in the
 * ledger and wears throwaway clones, so the host's own material datablock is
 * never mutated — restoring is a reference assignment, not an un-edit. */
type MaterialSwap = { mesh: Mesh; original: Material | Material[]; preview: Material[] }

export type PreviewLedger = { hidden: VisibleFlip[]; tinted: MaterialSwap[] }

/** A throwaway copy of `material` carrying the coat colour. Clones share
 * their maps by reference and `Material.dispose()` never disposes textures,
 * so the copy is free to make and safe to drop. */
function tintedClone(material: Material, color: string): Material {
  const clone = material.clone()
  const tint = (clone as MeshStandardMaterial).color
  if (tint) tint.set(color)
  return clone
}

/**
 * Apply the two host-touching lanes and hand back the ledger that undoes
 * them. Nothing here is idempotent-by-flag: each call records its own prior
 * values, so React's develop-mode double effect (mount → cleanup → mount)
 * and a genuine re-entry both round-trip.
 *
 * Demolition runs FIRST and paint skips whatever it hid — mirroring the Save
 * button, where `deleteDestroyed()` runs before `applyPaint()` precisely so
 * a node deleted above is not patched below.
 */
export function applyNodePreview(
  destroyed: readonly DestroyedNode[],
  painted: readonly PaintedNode[],
): PreviewLedger {
  const ledger: PreviewLedger = { hidden: [], tinted: [] }
  const levelled = new Set<string>()
  for (const { nodeId } of destroyed) {
    levelled.add(nodeId)
    const root = sceneRegistry.nodes.get(nodeId as never)
    // Already invisible (a level toggled off, say): nothing to flip, and
    // recording it would be a restore that changes nothing.
    if (!root || !root.visible) continue
    ledger.hidden.push({ object: root, visible: root.visible })
    root.visible = false
  }
  // Fence the mesh sweep at every registered solid root, so tinting a wall
  // does not repaint the door hosted inside it — those are their own nodes
  // and Save patches them separately (or not at all).
  const fence = painted.length > 0 ? collectSolidRoots() : null
  for (const { nodeId, color } of painted) {
    if (levelled.has(nodeId)) continue
    const root = sceneRegistry.nodes.get(nodeId as never)
    if (!root) continue
    let meshes = collectMeshes(root, fence ?? undefined)
    // A CONTAINER node (a roof whose planes are registered segment children)
    // owns no mesh of its own — the fence stopped at every one of them. Save
    // patches the container and the host propagates the coat down, so the
    // honest preview is the unfenced sweep. Leaf nodes never reach this.
    if (meshes.length === 0) meshes = collectMeshes(root)
    for (const mesh of meshes) {
      const original = mesh.material
      const list = Array.isArray(original) ? original : [original]
      const preview = list.map((entry) => tintedClone(entry, color))
      ledger.tinted.push({ mesh, original, preview })
      mesh.material = Array.isArray(original) ? preview : preview[0]!
    }
  }
  return ledger
}

/**
 * Undo every flip, unconditionally, and drop the clones. Draining the arrays
 * makes a second call a no-op — a teardown that races a re-entry can only
 * restore once, and it can never restore a value the ledger no longer owns.
 */
export function restoreNodePreview(ledger: PreviewLedger): void {
  for (const { mesh, original, preview } of ledger.tinted.splice(0)) {
    mesh.material = original
    for (const clone of preview) clone.dispose()
  }
  for (const { object, visible } of ledger.hidden.splice(0)) {
    object.visible = visible
  }
}

/** The ledger lane, as a component: applied on mount, restored on unmount
 * and on any change of the captured lists. */
function NodeLedger({
  destroyed,
  painted,
}: {
  destroyed: readonly DestroyedNode[]
  painted: readonly PaintedNode[]
}) {
  useEffect(() => {
    const ledger = applyNodePreview(destroyed, painted)
    return () => restoreNodePreview(ledger)
  }, [destroyed, painted])
  return null
}

// --- Pending pieces ---------------------------------------------------------

/**
 * The PENDING tint — the pieces are real geometry in the real pose, but they
 * are not real nodes yet, and the viewport has to say so. Cool blue with a
 * faint self-lit cast: the same "editable / not committed" language as the
 * F-edit lattice (edit-overlay.tsx), and unmistakable next to the game's own
 * placed-piece grey. One module singleton, never mutated.
 */
export const PENDING_TINT = new MeshStandardMaterial({
  color: '#8fb6d6',
  emissive: '#16324a',
  emissiveIntensity: 0.55,
  metalness: 0.05,
  roughness: 0.6,
})

/**
 * One pending piece. Geometry, pose and the corner-roof special case come
 * from builder.tsx's own seams, so a piece previews byte-identically to the
 * mesh the game drew — but with none of PlacedPieceMesh's world wiring
 * (collider push, voxel cladding), which a preview has no use for and no
 * GameWorld to reach.
 */
function PreviewPiece({ piece }: { piece: PlacedPiece }) {
  const span = piece.height ?? WALL_H
  const cornered = piece.piece === 'roof' && piece.corners !== undefined
  const geometry = cornered
    ? cornerRoofGeometry(piece.corners!, span)
    : geometryForMask(piece.piece, piece.mask, span)
  if (!geometry) return null // every cell edited out — nothing to show
  const pose = piecePose(piece.piece, piece.position[1], span)
  return (
    <mesh
      castShadow
      geometry={geometry}
      material={PENDING_TINT}
      position={[piece.position[0], cornered ? piece.position[1] : pose.y, piece.position[2]]}
      rotation={[cornered ? 0 : pose.tilt, piece.yaw, 0, 'YXZ']}
      userData={{ __boots: true }}
    />
  )
}

// --- Pending items ----------------------------------------------------------

/**
 * One pending catalog item: the asset's own visual, mounted imperatively
 * into a plain holder. `mountItemVisual` takes no GameWorld and returns a
 * disposer, so it is exactly the seam a preview wants — proxy first, GLB
 * when the cached load lands, everything disposed on unmount.
 *
 * `ghost: false` on purpose: Save adds this piece of furniture for real, so
 * the truthful preview is the furniture. It is new geometry standing where
 * there was none — that alone reads as pending.
 */
function PreviewItem({ item }: { item: PlacedItem }) {
  const holderRef = useRef<Group>(null)
  useEffect(() => {
    const holder = holderRef.current
    if (!holder) return
    return mountItemVisual(holder, item.asset, false)
  }, [item])
  return (
    <group position={item.position} rotation={[0, item.yaw, 0]} userData={{ __boots: true }}>
      <group ref={holderRef} />
    </group>
  )
}

/**
 * A host wall's placement frame read straight from the scene — the editor
 * has no world snapshot, so the frame comes from the wall's registered root
 * (which IS the wall-local frame) plus the node's plan length. READ ONLY:
 * this is the module's single point of contact with the scene store.
 */
function wallFrameFromScene(wallId: string): WallFrame | null {
  const root = sceneRegistry.nodes.get(wallId as never)
  if (!root) return null
  const nodes = useScene.getState().nodes as unknown as Record<
    string,
    Partial<WallNodeLike> | undefined
  >
  const node = nodes[wallId]
  if (!node?.start || !node.end) return null
  root.updateWorldMatrix(true, false)
  return wallPlacementFrame({ node: node as WallNodeLike, root })
}

/**
 * One pending door/window, posed on its host wall — the same framed
 * stand-in the game drew, in the same wall-local place Save will host the
 * real node. The wall is NOT cut: the hole only exists after Save, so the
 * mock sits on the wall exactly as it did in-game.
 */
function PreviewAperture({ placed }: { placed: PlacedAperture }) {
  const frame = useMemo(() => wallFrameFromScene(placed.wallId), [placed.wallId])
  if (!frame) return null // wall deleted or not rendered — nothing to pose against
  const bottom = placed.v - placed.height / 2
  return (
    <group
      position={[
        frame.originX + frame.ux * placed.u,
        frame.originY + bottom,
        frame.originZ + frame.uz * placed.u,
      ]}
      rotation={[0, frame.yaw, 0]}
      userData={{ __boots: true }}
    >
      <ApertureStandIn def={placed.def} depth={frame.thickness + 0.04} />
    </group>
  )
}

// --- The mount --------------------------------------------------------------

/**
 * The preview root, mounted in the plugin's system slot next to GameRoot
 * (system.tsx) — inside the editor's own R3F canvas, which is also the
 * game's canvas, so there is no second scene and no compositing to do.
 *
 * Renders null unless `shouldPreview`; every lane renders nothing when its
 * list is empty, so a paint-only session costs four meshes' worth of tint
 * and not one preview object.
 */
export function PendingPreview() {
  const phase = useBoots((s) => s.phase)
  const pendingDecision = useBoots((s) => s.pendingDecision)
  const allPlaced = useBoots((s) => s.placed)
  const allItems = useItems((s) => s.items)
  const destroyed = useDemolition((s) => s.destroyed)
  const painted = usePaintKeep((s) => s.painted)

  // Ours only — the same filter Save applies (see the header note).
  const placed = useMemo(
    () => allPlaced.filter((piece) => !isForeignPlacedPiece(piece.id)),
    [allPlaced],
  )
  const items = useMemo(
    () => allItems.filter((placement) => !isForeignItemPlacement(placement.id)),
    [allItems],
  )

  if (
    !shouldPreview(phase, pendingDecision, {
      pieces: placed.length,
      items: items.length,
      destroyed: destroyed.length,
      painted: painted.length,
    })
  ) {
    return null
  }

  return (
    <group userData={{ __boots: true }}>
      <NodeLedger destroyed={destroyed} painted={painted} />
      {placed.map((piece) => (
        <PreviewPiece key={piece.id} piece={piece} />
      ))}
      {items.map((placement) =>
        placement.kind === 'item' ? (
          <PreviewItem item={placement} key={placement.id} />
        ) : (
          <PreviewAperture key={placement.id} placed={placement} />
        ),
      )}
    </group>
  )
}
