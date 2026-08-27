import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { create } from 'zustand'
import { useDestruction } from './destruction'
import { getPaintedByNode, PAINT_PALETTE } from './paint'

/**
 * Save-the-paint — the sprayer's half of the persistence contract
 * (docs/SESSION-CHANGES.md, same shape as save-demolition.ts). During play
 * coats live only in paint.tsx's splat ledger; on exit each painted scene
 * node is captured here with its DOMINANT color so the panel can offer,
 * next to Keep: "also repaint what you sprayed". The patch runs through
 * the host's `updateNodes` — every node's material color in ONE undoable
 * batch — and only ever from the explicit button.
 *
 * Dominance is per-cell majority: the palette color covering the most of
 * a node's still-alive painted cells wins (a wall 70% sage / 30% navy
 * saves sage — a node has ONE material color, so the splatter art itself
 * stays game-only). Cells shot out after painting don't vote; if every
 * painted cell died the full ledger votes instead — the player's explicit
 * act still counts even if the surface later took fire.
 */

export type PaintedNode = {
  nodeId: string
  /** Dominant palette hex, ready for the material patch. */
  color: string
  colorName: string
  /** Cells the session coated on this node (panel copy). */
  cells: number
}

type PaintKeepState = {
  painted: PaintedNode[]
  setPainted: (painted: PaintedNode[]) => void
  clear: () => void
}

export const usePaintKeep = create<PaintKeepState>((set) => ({
  painted: [],
  setPainted: (painted) => set({ painted }),
  clear: () => set({ painted: [] }),
}))

/**
 * Pure dominant-color aggregation — exported for tests. Cells failing
 * `isAlive` don't vote; the most-voted palette index wins and ties break
 * to the LOWER index (stable across map iteration order). Null when
 * nothing voted.
 */
export function dominantPaint(
  cells: ReadonlyMap<number, number>,
  isAlive: (cell: number) => boolean = () => true,
): number | null {
  const votes = new Map<number, number>()
  for (const [cell, color] of cells) {
    if (!isAlive(cell)) continue
    votes.set(color, (votes.get(color) ?? 0) + 1)
  }
  let best: number | null = null
  let bestVotes = 0
  for (const [color, count] of votes) {
    if (count > bestVotes || (count === bestVotes && best !== null && color < best)) {
      best = color
      bestVotes = count
    }
  }
  return best
}

/**
 * Snapshot the session's painted nodes. Called from exitGame BEFORE the
 * destruction state resets with the game tree (the alive filter needs the
 * live grids). Game-only targets (tables, builder pieces — '__boots' ids)
 * never qualify: they are not scene nodes. Returns the captured count for
 * the pendingDecision gate.
 */
export function capturePaint(): number {
  const painted: PaintedNode[] = []
  const targets = useDestruction.getState().targets
  for (const [nodeId, cells] of getPaintedByNode()) {
    if (nodeId.startsWith('__boots')) continue
    if (cells.size === 0) continue
    const target = targets.get(nodeId)
    const alive = target ? (cell: number) => target.grid.alive[cell] === 1 : undefined
    const index = (alive ? dominantPaint(cells, alive) : null) ?? dominantPaint(cells)
    if (index === null) continue
    const swatch = PAINT_PALETTE[index]!
    painted.push({ nodeId, color: swatch.hex, colorName: swatch.name, cells: cells.size })
  }
  usePaintKeep.getState().setPainted(painted)
  return painted.length
}

/**
 * The explicit save: patch every captured node's material color in ONE
 * `updateNodes` batch (a single undo step). Existing material fields
 * (texture, roughness…) are preserved — only the color moves, and the
 * preset flips to 'custom' so hosts don't re-derive it. Nodes deleted
 * before the click (save-demolition runs first) are skipped. Returns the
 * number of nodes patched.
 */
export function applyPaint(): number {
  const painted = usePaintKeep.getState().painted
  if (painted.length === 0) return 0
  const nodes = useScene.getState().nodes
  const updates: { id: AnyNodeId; data: Partial<AnyNode> }[] = []
  for (const { nodeId, color } of painted) {
    const node = nodes[nodeId as AnyNodeId] as
      | { material?: { properties?: Record<string, unknown> } }
      | undefined
    if (!node) continue
    const material = {
      ...node.material,
      preset: 'custom',
      properties: { ...node.material?.properties, color },
    }
    updates.push({ id: nodeId as AnyNodeId, data: { material } as Partial<AnyNode> })
  }
  if (updates.length > 0) useScene.getState().updateNodes(updates)
  usePaintKeep.getState().clear()
  return updates.length
}

export function discardPaint(): void {
  usePaintKeep.getState().clear()
}
