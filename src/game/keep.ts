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
 *   middle-row cell dead at ANY column, ring alive
 *                            → wall + a WINDOW node pocketed at that column
 *                              (cell-sized, parented to the wall).
 *   bottom cell dead at ANY column [optionally the cell above too],
 *   rest alive               → wall + a DOOR node at that column (registry
 *                              default height, cell width).
 *   top row(s) fully dead,
 *   lower rows fully alive   → SHORTER wall by HEIGHT: mask 7 keeps a
 *                              0.93 m half wall, mask 63 a 1.87 m wall.
 *   end column(s) fully dead → SHORTER wall by SPAN: trimmed by
 *                              (dead columns × 1 m cell width) per end.
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
 * they stay game-only.
 *
 * FLOORS (build grammar v2): a game floor piece ATTEMPTS a 'slab' registry
 * node — defaults + schema parse, explicit polygon = the piece's 3 × 3
 * footprint corners (world XZ, yaw-rotated about the piece center) at the
 * slot pose, elevation = the piece's base y, autoFromWalls false so the
 * host never re-derives the outline. Exactly like roofs: the 3×3 mask is
 * ignored while it has any live cell (FULL_MASK grammar is deferred with
 * the 2×2 masks), fully-dead floors are skipped, and a missing 'slab'
 * registry kind or a schema-parse failure counts the piece as skipped so
 * it stays game-only — the attempt never throws past keepPlaced.
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
  /** Floor pieces kept as real 'slab' nodes (each also counts in `kept`). */
  floors: number
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
 * pocket at column c sits at (c + 0.5) cell widths along the (untrimmed)
 * 3 m span; position[1] is the child's center height (the host renders
 * child boxes centered). */
function createPocketNode(pocket: WallPocket, wallId: string, pocketCol: number): boolean {
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
      position: [(pocketCol + 0.5) * cellW, centerY, 0],
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

/** Best-effort floor piece → explicit-polygon 'slab' node. The polygon is
 * the piece's square footprint in world XZ (slab polygons are [x, z]
 * pairs, same plane convention as wall start/end), rotated by the piece
 * yaw about its center — a no-op for the square v2 slots (yaw snaps to
 * 90°) but correct for any legacy pose. Missing kind / schema throw →
 * false, and the caller counts the piece as skipped. */
function createSlabNode(piece: PlacedPiece, levelId: string): boolean {
  const def = nodeRegistry.get('slab') as RegistryDef | undefined
  if (!def?.schema) return false
  const hx = PIECE_DIMS.floor[0] / 2
  const hz = PIECE_DIMS.floor[2] / 2
  // Yaw about +Y maps local (x, z) → world (x·cos + z·sin, −x·sin + z·cos)
  // — the same frame trimmedWallSpan uses for wall endpoints.
  const cos = Math.cos(piece.yaw)
  const sin = Math.sin(piece.yaw)
  const corner = (lx: number, lz: number): [number, number] => [
    piece.position[0] + lx * cos + lz * sin,
    piece.position[2] - lx * sin + lz * cos,
  ]
  try {
    const slab = def.schema.parse({
      ...(def.defaults?.() ?? {}),
      object: 'node',
      parentId: levelId,
      visible: true,
      metadata: {},
      polygon: [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)],
      holes: [],
      elevation: piece.position[1],
      autoFromWalls: false,
    })
    useScene.getState().createNode(slab as AnyNode, levelId as AnyNodeId)
    return true
  } catch {
    return false
  }
}

export function keepPlaced(): KeepResult {
  const placed = useBoots.getState().placed
  const def = nodeRegistry.get('wall') as RegistryDef | undefined
  const levelId = useViewer.getState().selection.levelId
  const result: KeepResult = { kept: 0, skipped: 0, windows: 0, doors: 0, roofs: 0, floors: 0 }
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
    if (piece.piece === 'floor') {
      if ((piece.mask & FULL_MASK) !== 0 && createSlabNode(piece, levelId)) {
        result.kept++
        result.floors++
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
        // Dead TOP rows trim the kept height: mask 7 → 0.93 m, 63 → 1.87 m.
        height: PIECE_DIMS.wall[1] * ((CELLS - plan.trimTopRows) / CELLS),
        thickness: PIECE_DIMS.wall[2],
      })
      useScene.getState().createNode(wall as AnyNode, levelId as AnyNodeId)
      result.kept++
      if (!plan.exact) result.skipped++ // interior detail approximated away
      if (plan.pocket !== 'none') {
        const wallId = (wall as { id?: unknown }).id
        const created =
          typeof wallId === 'string' && createPocketNode(plan.pocket, wallId, plan.pocketCol)
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
