import { type AnyNode, type AnyNodeId, nodeRegistry, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { FULL_MASK, type PlacedPiece, useBoots } from '../store'
import {
  CELLS,
  isForeignPlacedPiece,
  PIECE_DIMS,
  planWallMask,
  releaseSharedPlacedPieces,
  trimmedWallSpan,
  WALL_H,
  type WallPocket,
} from './builder'
import { classifyRoofShape, type RoofCorners } from './roof-corners'
import { collectStackedLevels, type StackedLevel } from './world'

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
 * STAIRS (the walkable 3 m plank rising WALL_H over a 3 m run — the piece
 * the pre-split code called 'roof') map best-effort onto a 'roof-segment'
 * node — shed type, 3 × 3 footprint, pitch atan(WALL_H/3) in degrees, no
 * walls below, rotated to the piece yaw, parented to the per-save 'roof'
 * container (see createRoofParentNode). The mask is ignored for stairs
 * (partial stairs keep the full quad); fully-dead stairs are skipped,
 * schema failures fall back to skipped so they stay game-only.
 *
 * ROOFS (the 2×2 corner-height patch) map by shape — see createRoofNode:
 * flat → 'slab' terrace, slope → the exact shed above, corner/valley/
 * saddle → the closest single-plane shed, counted as approximated.
 *
 * HOST DEFAULTS ARE UNTRUSTED (p5r1 QA gate g): registry `defaults()` is
 * host code and CAN throw — the live editor's roof-segment definition
 * builds its defaults by schema-parsing a stub id 'roof-segment_default',
 * which fails core's `rseg_…` template-literal id check, so defaults()
 * throws on EVERY call and 8/8 placed roofs silently skipped. Every
 * creator therefore reads defaults through safeDefaults(): a throwing
 * defaults() degrades to `{}` and the zod schema's own field defaults
 * (including the generated id) carry the parse instead. A broken host
 * defaults() may weaken an attempt — it must never decide it.
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
 * ── ADAPTIVE STOREYS ───────────────────────────────────────────────────────
 * Every piece carries its storey span (PlacedPiece.height; legacy 2.8) and
 * the kept nodes conform: wall height = span·rows/3, shed pitch =
 * atan2(span, 3), flat-cap terrace at base + span, window pockets center on
 * span/2 with span/3-tall cells.
 * LEVEL PARENTING: a piece whose base elevation sits ON a level's stacked
 * base (grid ladder rung = level base by construction) parents to THAT
 * level — the pre-ladder code always used the viewer's selected level, so a
 * storey-1 wall kept from the ground-floor selection rendered at ground
 * elevation (wall nodes carry no Y of their own — the latent bug the
 * storey-coupling investigation flagged). Y-carrying nodes (slab elevation,
 * roof-segment position) are written LEVEL-LOCAL against the parent's
 * stacked base. Terrain and extended-sky storeys match no level and fall
 * back to the selection level, exactly the old behavior.
 *
 * Discard forgets everything.
 */

export type KeepResult = {
  kept: number
  skipped: number
  /** Pocket/extra nodes actually created (not counted in `kept`). */
  windows: number
  doors: number
  /** Stairs AND roof pieces kept as roof-segment/slab nodes (each also
   * counts in `kept`) — the R-slot family shares one counter. */
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

/** Host `defaults()` guarded against throws (see HOST DEFAULTS ARE
 * UNTRUSTED above) — the schema's field defaults fill whatever a broken
 * host defaults() failed to provide. */
function safeDefaults(def: RegistryDef): Record<string, unknown> {
  try {
    return def.defaults?.() ?? {}
  } catch {
    return {}
  }
}

/** Pocket a window/door child into a freshly-kept wall. Attempt-and-catch:
 * host schemas can demand more than we know — a throw means "skipped".
 * Wall-local frame: origin at the wall START, X along the wall, so the
 * pocket at column c sits at (c + 0.5) cell widths along the (untrimmed)
 * 3 m span; position[1] is the child's center height (the host renders
 * child boxes centered). `span` is the wall's storey span — windows center
 * on it and size to its cells. */
function createPocketNode(
  pocket: WallPocket,
  wallId: string,
  pocketCol: number,
  span: number,
): boolean {
  const def = nodeRegistry.get(pocket) as RegistryDef | undefined
  if (!def?.schema) return false
  const cellW = PIECE_DIMS.wall[0] / CELLS
  const cellH = span / CELLS
  const defaults = safeDefaults(def)
  const doorHeight =
    typeof (defaults as { height?: unknown }).height === 'number'
      ? ((defaults as { height: number }).height as number)
      : 2
  const centerY = pocket === 'window' ? span / 2 : doorHeight / 2
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

/** Best-effort R-slot piece → node(s). Stairs (and legacy corner-less
 * planks) map to a shed 'roof-segment' exactly as before; roof corner
 * patterns widen the family (pyramid grammar):
 *   flat (0 or 4 high corners) → a 'slab' node at eave/ridge elevation
 *                                (a roof terrace) — exact.
 *   slope (2 adjacent high)    → shed rotated so it ascends toward the
 *                                high edge (piece yaw + quarter·90°) — exact.
 *   corner / valley / saddle   → shed along the canonical quarter, the
 *                                closest single-plane read of the shape —
 *                                kept, but counted as approximated
 *                                (`exact: false`), same convention as
 *                                non-exact wall masks. */
function createRoofNode(
  piece: PlacedPiece,
  levelId: string,
  baseY: number,
  span: number,
  shedParent: (levelId: string) => string,
): { ok: boolean; exact: boolean } {
  const corners = piece.corners as RoofCorners | undefined
  if (corners) {
    const shape = classifyRoofShape(corners)
    if (shape.kind === 'flat') {
      const elevation = baseY + (shape.high ? span : 0)
      return { ok: createSlabNode(piece, levelId, elevation), exact: true }
    }
    const quarter = shape.kind === 'saddle' ? 0 : shape.quarter
    const ok = createShedNode(
      piece,
      shedParent(levelId),
      baseY,
      span,
      piece.yaw + (quarter * Math.PI) / 2,
    )
    return { ok, exact: shape.kind === 'slope' }
  }
  return { ok: createShedNode(piece, shedParent(levelId), baseY, span, piece.yaw), exact: true }
}

/** The host's roof system only BUILDS geometry for 'roof-segment' children
 * of a 'roof' node (viewer roof-system merges shells per roof parent —
 * segments parented straight to the level stay empty zero-size
 * placeholders; the corner-roof QA round proved saved sheds were
 * invisible). Keep therefore mints ONE 'roof' container under the level
 * per save and parents every shed segment to it. A missing/throwing
 * 'roof' registry kind degrades to the old level parenting — worst case
 * is the previous (invisible) behavior, never a lost save. */
function createRoofParentNode(levelId: string): string | null {
  const def = nodeRegistry.get('roof') as RegistryDef | undefined
  if (!def?.schema) return null
  try {
    const roof = def.schema.parse({
      ...safeDefaults(def),
      object: 'node',
      parentId: levelId,
      visible: true,
      metadata: {},
    })
    useScene.getState().createNode(roof as AnyNode, levelId as AnyNodeId)
    const id = (roof as { id?: unknown }).id
    return typeof id === 'string' ? id : null
  } catch {
    return null
  }
}

/** The classic shed 'roof-segment' attempt: a 3 m plan run rising the
 * piece's own storey span (`span`; legacy WALL_H). `baseY` is the node's
 * PARENT-LOCAL base elevation. */
function createShedNode(
  piece: PlacedPiece,
  parentId: string,
  baseY: number,
  span: number,
  rotation: number,
): boolean {
  const def = nodeRegistry.get('roof-segment') as RegistryDef | undefined
  if (!def?.schema) return false
  const run = PIECE_DIMS.wall[0] // roofs rise one storey span over a 3 m plan run
  const pitchDeg = (Math.atan2(span, run) * 180) / Math.PI
  try {
    const segment = def.schema.parse({
      ...safeDefaults(def),
      object: 'node',
      parentId,
      visible: true,
      metadata: {},
      position: [piece.position[0], baseY, piece.position[2]],
      rotation,
      roofType: 'shed',
      width: run,
      depth: run,
      wallHeight: 0,
      overhang: 0,
      pitch: pitchDeg,
    })
    useScene.getState().createNode(segment as AnyNode, parentId as AnyNodeId)
    return true
  } catch {
    return false
  }
}

/** Best-effort floor piece → explicit-polygon 'slab' node. The polygon is
 * the piece's square footprint in world XZ (slab polygons are [x, z]
 * pairs, same plane convention as wall start/end), rotated by the piece
 * yaw about its center — a no-op for the square v2 slots (yaw snaps to
 * 90°) but correct for any legacy pose. `elevation` is PARENT-LEVEL-LOCAL.
 * Missing kind / schema throw → false, and the caller counts the piece as
 * skipped. */
function createSlabNode(piece: PlacedPiece, levelId: string, elevation: number): boolean {
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
      ...safeDefaults(def),
      object: 'node',
      parentId: levelId,
      visible: true,
      metadata: {},
      polygon: [corner(-hx, -hz), corner(hx, -hz), corner(hx, hz), corner(-hx, hz)],
      holes: [],
      elevation,
      autoFromWalls: false,
    })
    useScene.getState().createNode(slab as AnyNode, levelId as AnyNodeId)
    return true
  } catch {
    return false
  }
}

/** A piece base within this of a level's stacked base parents to that level
 * — pieces sit EXACTLY on ladder rungs (which ARE the level bases), so the
 * tolerance only absorbs matrixWorld float folding across two snap reads. */
const LEVEL_MATCH_EPS = 0.05

/** The level whose stacked base the piece's base elevation sits on, or
 * null for terrain / extended-sky / legacy-uniform storeys (the caller
 * falls back to the selection level). Levels are meters apart, so the
 * first match is the match. */
function levelForBaseY(levels: readonly StackedLevel[], baseY: number): StackedLevel | null {
  for (const level of levels) {
    if (Math.abs(level.y - baseY) <= LEVEL_MATCH_EPS) return level
  }
  return null
}

export function keepPlaced(): KeepResult {
  // ONLY WHAT THIS PLAYER BUILT. In a shared world the store interleaves
  // everyone's pieces, and a Save writes the document on behalf of the person
  // who pressed the button — a stranger's wall is theirs to keep on their own
  // screen, not ours to commit here. Filtering at the top also keeps the tally
  // honest: every count below, including the give-up path's `skipped`, is a
  // count of work that was actually considered for writing. In single-player
  // nothing is foreign and this is the store's own list.
  const placed = useBoots.getState().placed.filter((piece) => !isForeignPlacedPiece(piece.id))
  const def = nodeRegistry.get('wall') as RegistryDef | undefined
  const selectionLevelId = useViewer.getState().selection.levelId
  const result: KeepResult = { kept: 0, skipped: 0, windows: 0, doors: 0, roofs: 0, floors: 0 }
  if (!def?.schema || !selectionLevelId) {
    releaseSharedPlacedPieces()
    useBoots.getState().resolvePlaced()
    return { ...result, skipped: placed.length }
  }
  // Stacked level bases for the storey → level mapping. Read through the
  // host's snap util (the editor may sit exploded/solo again by Keep time —
  // piece positions are STACKED world coordinates from the session).
  const levels = collectStackedLevels()
  const selectionBase = levels.find((level) => level.id === selectionLevelId)?.y ?? 0
  // One 'roof' container per PARENT LEVEL per save, minted lazily on the
  // first shed attempt (see createRoofParentNode) — flat caps and roofless
  // saves never mint one.
  const roofParents = new Map<string, string | null>()
  const shedParent = (parentLevelId: string): string => {
    let minted = roofParents.get(parentLevelId)
    if (minted === undefined) {
      minted = createRoofParentNode(parentLevelId)
      roofParents.set(parentLevelId, minted)
    }
    return minted ?? parentLevelId
  }
  for (const piece of placed) {
    // ADAPTIVE STOREYS: the piece's own span, and the level its storey maps
    // to (base elevation = ladder rung = level base). Y-carrying payloads
    // are written LEVEL-LOCAL against the parent's stacked base.
    const pieceSpan = piece.height ?? WALL_H
    const level = levelForBaseY(levels, piece.position[1])
    const parentLevelId = level?.id ?? selectionLevelId
    const parentBase = level?.y ?? selectionBase
    const localBaseY = piece.position[1] - parentBase
    if (piece.piece === 'stairs' || piece.piece === 'roof') {
      const made =
        (piece.mask & FULL_MASK) !== 0
          ? createRoofNode(piece, parentLevelId, localBaseY, pieceSpan, shedParent)
          : null
      if (made?.ok) {
        result.kept++
        result.roofs++
        if (!made.exact) result.skipped++ // shape approximated to one plane
      } else {
        result.skipped++
      }
      continue
    }
    if (piece.piece === 'floor') {
      if ((piece.mask & FULL_MASK) !== 0 && createSlabNode(piece, parentLevelId, localBaseY)) {
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
        ...safeDefaults(def),
        object: 'node',
        parentId: parentLevelId,
        visible: true,
        metadata: {},
        start: span.start,
        end: span.end,
        // Dead TOP rows trim the kept height — of the piece's OWN storey
        // span: mask 7 keeps span/3, 63 keeps 2·span/3.
        height: pieceSpan * ((CELLS - plan.trimTopRows) / CELLS),
        thickness: PIECE_DIMS.wall[2],
      })
      useScene.getState().createNode(wall as AnyNode, parentLevelId as AnyNodeId)
      result.kept++
      if (!plan.exact) result.skipped++ // interior detail approximated away
      if (plan.pocket !== 'none') {
        const wallId = (wall as { id?: unknown }).id
        const created =
          typeof wallId === 'string' &&
          createPocketNode(plan.pocket, wallId, plan.pocketCol, pieceSpan)
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
  // Unbind our records WITHOUT tombstoning them: the pieces just became real
  // scene walls here, and on every other screen they are still the walls they
  // always were. Killing the records would delete a peer's view of a building
  // that exists.
  releaseSharedPlacedPieces()
  useBoots.getState().resolvePlaced()
  return result
}

export function discardPlaced(): void {
  releaseSharedPlacedPieces()
  useBoots.getState().resolvePlaced()
}
