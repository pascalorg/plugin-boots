import { type AnyNode, type AnyNodeId, nodeRegistry, useScene } from '@pascal-app/core'
import { useViewer } from '@pascal-app/viewer'
import { useBoots } from '../store'
import { PIECE_DIMS } from './builder'

/**
 * The bridge back to the editor: after a session, Keep converts the pieces
 * you built in-game into REAL scene nodes through the host's own registry
 * (wall defaults + schema), so they're normal, undoable, editable walls.
 * Floors/ramps have no 1:1 node yet — counted as skipped. Discard forgets.
 */

export type KeepResult = { kept: number; skipped: number }

export function keepPlaced(): KeepResult {
  const placed = useBoots.getState().placed
  const def = nodeRegistry.get('wall') as
    | {
        defaults?: () => Record<string, unknown>
        schema?: { parse: (value: unknown) => unknown }
      }
    | undefined
  const levelId = useViewer.getState().selection.levelId
  let kept = 0
  let skipped = 0
  if (!def?.schema || !levelId) {
    return { kept: 0, skipped: placed.length }
  }
  for (const piece of placed) {
    if (piece.piece !== 'wall') {
      skipped++
      continue
    }
    const half = PIECE_DIMS.wall[0] / 2
    // Y-rotation of +yaw maps local +X to (cos yaw, -sin yaw) on the XZ plane.
    const dx = Math.cos(piece.yaw) * half
    const dz = -Math.sin(piece.yaw) * half
    try {
      const wall = def.schema.parse({
        ...(def.defaults?.() ?? {}),
        object: 'node',
        parentId: levelId,
        visible: true,
        metadata: {},
        start: [piece.position[0] - dx, piece.position[2] - dz],
        end: [piece.position[0] + dx, piece.position[2] + dz],
        height: PIECE_DIMS.wall[1],
        thickness: PIECE_DIMS.wall[2],
      })
      useScene.getState().createNode(wall as AnyNode, levelId as AnyNodeId)
      kept++
    } catch {
      skipped++
    }
  }
  useBoots.getState().resolvePlaced()
  return { kept, skipped }
}

export function discardPlaced(): void {
  useBoots.getState().resolvePlaced()
}
