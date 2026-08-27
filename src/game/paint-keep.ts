import { type AnyNode, type AnyNodeId, useScene } from '@pascal-app/core'
import { create } from 'zustand'
import { useDestruction } from './destruction'
import { getPaintedByNode, PAINT_PALETTE } from './paint'

/**
 * Save-the-paint — the sprayer's half of the persistence contract
 * (docs/SESSION-CHANGES.md, same shape as save-demolition.ts). During play
 * coats live only in paint.tsx's splat ledger; on exit each painted scene
 * node is captured here with its DOMINANT color so the panel can offer,
 * next to Keep: "also repaint what you sprayed". The patch lands as ONE
 * undoable batch (legacy `material` inline, plus re-pointed slot refs for
 * slot-modelled walls) — and only ever from the explicit button.
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

/** Freshly minted scene-material datablock (the host's `SceneMaterial`
 * shape — `materials` predates the plugin's core typings baseline). */
export type MintedCoat = {
  id: string
  name: string
  material: { preset: 'custom'; properties: { color: string } }
}

/** Wall slot ids the save must re-point: the host renders `node.slots[side]`
 * FIRST (a MaterialRef there beats the legacy inline `material`), so a
 * slot-modelled wall — editor-painted or legacy→slots migrated — would save
 * "repainted N" with NO visible change if only the legacy field moved. */
const PAINTED_SLOT_SIDES = ['interior', 'exterior'] as const

const MAT_ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `mat_<16 lowercase alphanumerics>` — the host's scene-material id shape
 * (`generateSceneMaterialId` isn't exported by the plugin's core baseline). */
export function mintSceneMaterialId(): string {
  let suffix = ''
  for (let i = 0; i < 16; i++) {
    suffix += MAT_ID_ALPHABET[Math.floor(Math.random() * MAT_ID_ALPHABET.length)]
  }
  return `mat_${suffix}`
}

/** The node fields the patch planner reads. */
type PaintableNode = {
  material?: { properties?: Record<string, unknown> }
  slots?: Record<string, string>
}

/**
 * Pure patch planning — exported for tests. Every painted node gets the
 * legacy inline patch (existing fields — texture, roughness… — preserved,
 * only the color moves, preset flips to 'custom' so hosts don't re-derive
 * it); nodes that ALSO carry slot refs on interior/exterior get those refs
 * re-pointed at a minted scene material, ONE datablock per distinct coat
 * across the batch (the host migration's dedupe). Missing nodes (deleted
 * before the click — save-demolition runs first) are skipped.
 */
export function buildPaintPatches(
  nodes: Readonly<Record<string, unknown>>,
  painted: readonly PaintedNode[],
  mintId: () => string = mintSceneMaterialId,
): { updates: { id: string; data: Record<string, unknown> }[]; minted: MintedCoat[] } {
  const updates: { id: string; data: Record<string, unknown> }[] = []
  const mintedByColor = new Map<string, MintedCoat>()
  for (const { nodeId, color, colorName } of painted) {
    const node = nodes[nodeId] as PaintableNode | undefined
    if (!node) continue
    const material = {
      ...node.material,
      preset: 'custom',
      properties: { ...node.material?.properties, color },
    }
    const data: Record<string, unknown> = { material }
    const sides = PAINTED_SLOT_SIDES.filter((side) => node.slots?.[side] !== undefined)
    if (sides.length > 0) {
      let coat = mintedByColor.get(color)
      if (!coat) {
        coat = { id: mintId(), name: colorName, material: { preset: 'custom', properties: { color } } }
        mintedByColor.set(color, coat)
      }
      const slots = { ...node.slots }
      for (const side of sides) slots[side] = `scene:${coat.id}`
      data.slots = slots
    }
    updates.push({ id: nodeId, data })
  }
  return { updates, minted: [...mintedByColor.values()] }
}

/** The store view the minting write touches — `materials` is newer than the
 * plugin's core typings baseline, so the write goes through this shape. */
type SceneWriteView = {
  readOnly?: boolean
  nodes: Record<string, Record<string, unknown>>
  materials?: Record<string, MintedCoat>
}

/**
 * The explicit save: patch every captured node's coat in ONE undo step.
 * Legacy-only batches keep the proven `updateNodes` path; batches that mint
 * scene materials (slot-modelled walls) land materials + node patches in a
 * single store set instead — zundo records one history entry, so one undo
 * removes the refs AND their now-orphaned materials together (the host's
 * slot-paint commit pattern). Returns the number of nodes patched.
 */
export function applyPaint(): number {
  const painted = usePaintKeep.getState().painted
  if (painted.length === 0) return 0
  const { updates, minted } = buildPaintPatches(useScene.getState().nodes, painted)
  if (minted.length === 0) {
    if (updates.length > 0) {
      useScene.getState().updateNodes(updates as { id: AnyNodeId; data: Partial<AnyNode> }[])
    }
  } else {
    const store = useScene as unknown as {
      setState: (updater: (s: SceneWriteView) => Partial<SceneWriteView> | SceneWriteView) => void
    }
    store.setState((s) => {
      if (s.readOnly) return s
      const nodes = { ...s.nodes }
      for (const { id, data } of updates) {
        const current = nodes[id]
        if (!current) continue
        nodes[id] = { ...current, ...data }
      }
      const materials = { ...s.materials }
      for (const coat of minted) materials[coat.id] = coat
      return { nodes, materials }
    })
    for (const { id } of updates) useScene.getState().markDirty(id as AnyNodeId)
  }
  usePaintKeep.getState().clear()
  return updates.length
}

export function discardPaint(): void {
  usePaintKeep.getState().clear()
}
