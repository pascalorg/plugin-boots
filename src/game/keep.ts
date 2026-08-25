import { type AnyNode, type AnyNodeId, nodeRegistry, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import { CELLS, PIECE_DIMS, planWallMask, trimmedWallSpan, type WallPocket } from './builder'

/**
 * The bridge back to the editor: after a session, Keep converts the pieces
 * you built in-game into REAL scene nodes through the host's own registry
 * (defaults + schema parse), so they're normal, undoable, editable nodes.
 *
 * ── MASK → NODE MAPPING (walls) ────────────────────────────────────────────
 * A wall's 9-bit cell mask (bit = col + row·3, row 0 = bottom, col 0 at the
 * wall's START end) decides what Keep builds:
 *   511 (intact)            → plain wall node, full 3 m span.
 *   end column(s) fully dead → SHORTER wall: the span is trimmed by
 *                              (dead columns × 1 m cell width) per end.
 *   center cell (bit 4) dead,
 *   ring alive               → wall + a WINDOW node pocketed at the center
 *                              (cell-sized, parented to the wall).
 *   bottom-center (bit 1) dead
 *   [optionally bit 4 too],
 *   rest alive               → wall + a DOOR node at the center (registry
 *                              default height, cell width).
 *   anything else            → best-effort trimmed wall, and the piece also
 *                              counts as skipped (the pocket detail was
 *                              approximated away).
 *   all dead                 → skipped.
 * Pocket child nodes are attempt-and-catch: if the host schema wants more
 * than defaults + width/height/position, the failure counts as skipped and
 * the plain wall stays.
 * The pure planning math (planWallMask, trimmedWallSpan) lives in
 * builder.tsx so headless tests can import it without this module's
 * viewer dependency; it is re-exported here for keep-side callers.
 *
 * ROOFS: a game roof piece (3 m plank rising WALL_H over a 3 m run) maps
 * best-effort onto a 'roof-segment' node — shed type, 3 × 3 footprint,
 * pitch atan(WALL_H/3) in degrees, no walls below, rotated to the piece
 * yaw. The mask is ignored for roofs (partial roofs keep the full quad);
 * fully-dead roofs are skipped, schema failures fall back to skipped so
 * they stay game-only. FLOORS still have no 1:1 node — always skipped.
 *
 * Discard forgets everything.
 */

export type KeepResult = {
  kept: number
  skipped: number
  /** Pocket/extra nodes actually created (not counted in `kept`). */
  windows: number
  doors: number
  roofs: number
}

export { planWallMask, trimmedWallSpan } from './builder'
export type { WallMaskPlan, WallPocket } from './builder'

type RegistryDef = {
  defaults?: () => Record<string, unknown>
  schema?: { parse: (value: unknown) => unknown }
}

/** Pocket a window/door child into a freshly-kept wall. Attempt-and-catch:
 * host schemas can demand more than we know — a throw means "skipped".
 * Wall-local frame: origin at the wall START, X along the wall, so the
 * center pocket sits at half the (untrimmed) 3 m span; position[1] is the
 * child's center height (the host renders child boxes centered). */
function createPocketNode(pocket: WallPocket, wallId: string): boolean {
  const def = nodeRegistry.get(pocket) as RegistryDef | undefined
  if (!def?.schema) return false
  const cellW = PIECE_DIMS.wall[0] / CELLS
  const cellH = PIECE_DIMS.wall[1] / CELLS
  const defaults = def.defaults?.() ?? {}
  const doorHeight =
    typeof (defaults as { height?: unknown }).height === 'number'
      ? ((defaults as { height: number }).height as number)
      : 2
  const centerY = pocket === 'window' ? PIECE_DIMS.wall[1] / 2 : doorHeight / 2
  try {
    const node = def.schema.parse({
      ...defaults,
      object: 'node',
      parentId: wallId,
      visible: true,
      metadata: {},
      wallId,
      position: [PIECE_DIMS.wall[0] / 2, centerY, 0],
      width: cellW,
      ...(pocket === 'window' ? { height: cellH } : {}),
    })
    useScene.getState().createNode(node as AnyNode, wallId as AnyNodeId)
    return true
  } catch {
    return false
  }
}

/** Best-effort roof piece → shed 'roof-segment' node. */
function createRoofNode(piece: PlacedPiece, levelId: string): boolean {
  const def = nodeRegistry.get('roof-segment') as RegistryDef | undefined
  if (!def?.schema) return false
  const run = PIECE_DIMS.wall[0] // roofs rise WALL_H over a 3 m plan run
  const pitchDeg = (Math.atan2(PIECE_DIMS.wall[1], run) * 180) / Math.PI
  try {
    const segment = def.schema.parse({
      ...(def.defaults?.() ?? {}),
      object: 'node',
      parentId: levelId,
      visible: true,
      metadata: {},
      position: [piece.position[0], piece.position[1], piece.position[2]],
      rotation: piece.yaw,
      roofType: 'shed',
      width: run,
      depth: run,
      wallHeight: 0,
      overhang: 0,
      pitch: pitchDeg,
    })
    useScene.getState().createNode(segment as AnyNode, levelId as AnyNodeId)
    return true
  } catch {
    return false
  }
}

export function keepPlaced(): KeepResult {
  const placed = useBoots.getState().placed
  const def = nodeRegistry.get('wall') as RegistryDef | undefined
  const levelId = useViewer.getState().selection.levelId
  const result: KeepResult = { kept: 0, skipped: 0, windows: 0, doors: 0, roofs: 0 }
  if (!def?.schema || !levelId) {
    useBoots.getState().resolvePlaced()
    return { ...result, skipped: placed.length }
  }
  for (const piece of placed) {
    if (piece.piece === 'roof') {
      if ((piece.mask & FULL_MASK) !== 0 && createRoofNode(piece, levelId)) {
        result.kept++
        result.roofs++
      } else {
        result.skipped++
      }
      continue
    }
    if (piece.piece !== 'wall') {
      result.skipped++
      continue
    }
    const plan = planWallMask(piece.mask)
    if (plan.kind === 'skip') {
      result.skipped++
      continue
    }
    const span = trimmedWallSpan(piece.position, piece.yaw, plan.trimStartCols, plan.trimEndCols)
    try {
      const wall = def.schema.parse({
        ...(def.defaults?.() ?? {}),
        object: 'node',
        parentId: levelId,
        visible: true,
        metadata: {},
        start: span.start,
        end: span.end,
        height: PIECE_DIMS.wall[1],
        thickness: PIECE_DIMS.wall[2],
      })
      useScene.getState().createNode(wall as AnyNode, levelId as AnyNodeId)
      result.kept++
      if (!plan.exact) result.skipped++ // interior detail approximated away
      if (plan.pocket !== 'none') {
        const wallId = (wall as { id?: unknown }).id
        const created = typeof wallId === 'string' && createPocketNode(plan.pocket, wallId)
        if (created) {
          if (plan.pocket === 'window') result.windows++
          else result.doors++
        } else {
          result.skipped++ // the pocket needs more schema than we can guess
        }
      }
    } catch {
      result.skipped++
    }
  }
  useBoots.getState().resolvePlaced()
  return result
}

export function discardPlaced(): void {
  useBoots.getState().resolvePlaced()
}
