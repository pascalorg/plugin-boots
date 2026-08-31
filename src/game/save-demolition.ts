import { type AnyNodeId, useScene } from '@pascal-app/core'
import { create } from 'zustand'
import { localDemolitionWork, useDestruction, type VoxelTarget } from './destruction'
import { type LocalWork } from './shared-world'

/**
 * Save-the-demolition — the other half of the persistence contract
 * (docs/SESSION-CHANGES.md). During play nothing persists; on exit the
 * session's FULLY destroyed scene nodes are captured here so the panel can
 * offer, next to Keep: "also delete what you leveled". Deletion runs
 * through the host's user-intent `deleteNodes` (descendant cascade, ONE
 * undo step) and only ever from the explicit button.
 *
 * "Fully destroyed" is strict: every voxel dead AND every framing segment
 * snapped. A wall with one stud standing is NOT persisted — partial damage
 * has no faithful node representation, so it stays intact in the editor
 * (the panel copy says so).
 */

export type DestroyedNode = { nodeId: string; kind: 'wall' | 'volume' }

/**
 * THE OWNERSHIP GATE.
 *
 * In a shared session other players' damage lands in this client's runtime
 * destruction state — that is the whole point of the shared world. But this
 * bridge writes the OWNER'S REAL BUILDING: `deleteDestroyed()` deletes scene
 * nodes for good. A stranger levelling someone's garage must never be able to
 * ride that into the owner's document.
 *
 * So the bridge asks one question, of the destruction runtime it already
 * depends on: `localDemolitionWork()` — the shared model's record of what THIS
 * peer destroyed, projected, and nothing else. No SharedWorld handle ever
 * reaches this file, so there is no peers' work here to leak even by accident.
 *
 * In single player the answer is null, and everything below takes the identical
 * code path it always took: no gate, no allocation, everything is mine because
 * nobody else is here.
 */

type DemolitionState = {
  /** What Save will delete: leveled scene nodes this peer finished off alone. */
  destroyed: DestroyedNode[]
  /**
   * The enforced allow-list, by node id. `destroyed` is already filtered to
   * it; keeping it separately means `deleteDestroyed()` can re-check at click
   * time, long after the destruction runtime has been torn down and the
   * evidence is gone.
   */
  mine: string[]
  /**
   * Leveled nodes withheld because another player had a hand in them. Not an
   * error — it is the gate working. Surfaced for QA (`__boots`) so a
   * suspiciously large number is visible rather than silent.
   */
  foreign: number
  setDestroyed: (destroyed: DestroyedNode[], mine: string[], foreign: number) => void
  clear: () => void
}

export const useDemolition = create<DemolitionState>((set) => ({
  destroyed: [],
  mine: [],
  foreign: 0,
  setDestroyed: (destroyed, mine, foreign) => set({ destroyed, mine, foreign }),
  clear: () => set({ destroyed: [], mine: [], foreign: 0 }),
}))

/** Strict classifier — exported for tests. */
export function isFullyDestroyed(target: {
  grid: { aliveCount: number }
  segments: ReadonlyArray<{ broken: boolean }>
}): boolean {
  if (target.grid.aliveCount > 0) return false
  for (const segment of target.segments) {
    if (!segment.broken) return false
  }
  return true
}

/**
 * Did THIS peer kill every last cell and snap every last stick of `target`?
 *
 * Not "did I land the finishing blow", and deliberately not the shared model's
 * `killedByMe` flag: a collapse cascade is DERIVED locally, so a wall can fall
 * on this client because of a stranger's shot two rooms away and still be
 * recorded here as a local collapse. The only claim strong enough to justify
 * deleting a node from someone's saved building is that every single piece of
 * the damage is attributable to this peer — a count match against the grid,
 * which is exact because the publish sites report cells only on a genuine
 * alive→dead transition, and a cell a stranger already killed is not alive.
 *
 * A grid too large to address on the wire (over 1024 cells on an axis) has no
 * ownership record at all and so is never offered for deletion. That is the
 * safe direction: the node simply stays in the editor.
 */
function fullyMine(work: LocalWork, target: VoxelTarget): boolean {
  if ((work.cells.get(target.nodeId)?.length ?? 0) !== target.grid.count) return false
  if ((work.segments.get(target.nodeId)?.length ?? 0) !== target.segments.length) return false
  return true
}

/**
 * Snapshot the session's leveled nodes. Called from exitGame BEFORE the
 * destruction state resets with the game tree. Game-only targets (tables,
 * builder pieces — '__boots' ids) never qualify: they are not scene nodes.
 *
 * In a shared session every candidate must also pass `fullyMine`. In single
 * player the projection is null and the loop is byte-for-byte the one that
 * shipped.
 *
 * ACCUMULATES ACROSS SESSIONS. The pending decision spans every session since
 * the last Save/Discard — Jump in, level a wall, Esc, Jump in again, Esc — so
 * this capture folds into what is already pending instead of replacing it. It
 * used to replace, and the destruction runtime is rebuilt from the restored
 * scene on every entry, so the second exit reported zero and the first
 * session's demolition vanished: not just from the panel, but from Save, which
 * would then have written nothing for it. `placed` has always behaved this way
 * (only `resolvePlaced` clears it), and the two clear paths here are the same
 * explicit decision: `deleteDestroyed` (Save) and `discardDemolition`.
 *
 * Returns the TOTAL pending count, not this session's, because the panel's
 * offer is "in the editor with a non-empty lane" — this lane, all of it.
 */
export function captureDemolition(): number {
  const work = localDemolitionWork()
  const destroyed: DestroyedNode[] = []
  let foreign = 0
  // Roof shells enroll per PLANE under `<nodeId>#p<n>` member ids plus one
  // `#residual` (destruction.ts roofGroups) — member ids exist in no scene
  // store, so deleteNodes on them silently no-ops. Fold members back onto
  // their GROUP node: it qualifies only when EVERY member is leveled.
  const roofLeveled = new Map<string, boolean>()
  // Ownership folds the same way: one member finished off by a stranger
  // disqualifies the whole roof, because deleting the group node would take
  // that member's real geometry with it.
  const roofMine = new Map<string, boolean>()
  for (const target of useDestruction.getState().targets.values() as Iterable<VoxelTarget>) {
    if (target.nodeId.startsWith('__boots')) continue
    const hash = target.nodeId.indexOf('#')
    if (hash !== -1) {
      const groupId = target.nodeId.slice(0, hash)
      roofLeveled.set(groupId, (roofLeveled.get(groupId) ?? true) && isFullyDestroyed(target))
      if (work !== null) {
        roofMine.set(groupId, (roofMine.get(groupId) ?? true) && fullyMine(work, target))
      }
      continue
    }
    if (!isFullyDestroyed(target)) continue
    if (work !== null && !fullyMine(work, target)) {
      foreign++
      continue
    }
    destroyed.push({ nodeId: target.nodeId, kind: target.kind === 'wall' ? 'wall' : 'volume' })
  }
  for (const [groupId, leveled] of roofLeveled) {
    if (!leveled) continue
    if (roofMine.get(groupId) === false) {
      foreign++
      continue
    }
    destroyed.push({ nodeId: groupId, kind: 'volume' })
  }
  return mergePendingDemolition(destroyed, foreign)
}

/**
 * Fold a session's capture into what is already pending, keyed by node id.
 * Prior entries keep their position (the panel's row order stays stable across
 * a re-entry) and a node levelled twice is listed once. Exported for tests.
 */
export function mergePendingDemolition(
  destroyed: readonly DestroyedNode[],
  foreign: number,
): number {
  const prior = useDemolition.getState()
  const byNode = new Map<string, DestroyedNode>()
  for (const node of prior.destroyed) byNode.set(node.nodeId, node)
  for (const node of destroyed) byNode.set(node.nodeId, node)
  const merged = [...byNode.values()]
  // `mine` is the allow-list `deleteDestroyed` re-checks at click time, long
  // after this session's evidence is gone — so it has to carry every session's
  // grant, not just the last one.
  const mine = [...new Set([...prior.mine, ...destroyed.map((d) => d.nodeId)])]
  // `foreign` does NOT accumulate, and that is deliberate: it is a bare count,
  // not a keyed set, and the shared model re-projects the same stranger's rubble
  // into the rebuilt runtime on every entry — so one withheld wall would read 1,
  // then 2, then 3 across re-entries of the same pending window. Per-capture it
  // answers the question it exists to answer: at THIS exit, how many leveled
  // nodes did the gate withhold.
  useDemolition.getState().setDestroyed(merged, mine, foreign)
  return merged.length
}

/**
 * The explicit save: delete every captured node in ONE undoable batch.
 *
 * The allow-list is re-applied here rather than trusted from capture time.
 * This is the last gate before an irreversible write to another person's
 * building, it costs one Set, and it holds even if something else in the app
 * ever puts a node into `destroyed` behind capture's back.
 */
export function deleteDestroyed(): number {
  const state = useDemolition.getState()
  if (state.destroyed.length === 0) return 0
  const allowed = new Set(state.mine)
  const ids = state.destroyed
    .filter((d) => allowed.has(d.nodeId))
    .map((d) => d.nodeId as AnyNodeId)
  if (ids.length === 0) {
    state.clear()
    return 0
  }
  useScene.getState().deleteNodes(ids)
  useDemolition.getState().clear()
  return ids.length
}

export function discardDemolition(): void {
  useDemolition.getState().clear()
}
