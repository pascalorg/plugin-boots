/**
 * Support graph — the pure "no floating pieces" core of build grammar v2
 * (docs/BUILD-GRAMMAR-V2-REVIEW.md, agent 3). Tracks which grid slots hold
 * a piece and answers two questions:
 *
 *   isSupported(slotId)        connected to any grounded slot through
 *                              present slots (multi-source BFS, cached
 *                              behind a dirty flag — repeated queries are
 *                              O(1); any add/remove/invalidate recomputes).
 *   computeCollapse(slotId)    after a piece dies, the disconnected
 *                              component as ORDERED RINGS by BFS distance
 *                              from the removal point — the consumer
 *                              staggers ring collapses ~50 ms apart.
 *
 * The graph is deliberately blind to geometry: adjacency comes from an
 * injected `slotsTouching` (grid.ts owns the slot codec) and scene support
 * (existing walls / terrain) from an injected `probeExternal`, queried
 * live on every recompute so a demolished scene wall drops its dependents.
 * A slot is a ROOT when the caller flagged it grounded at add() time
 * (e.g. the storey-0-on-terrain rule) OR probeExternal says so now.
 *
 * Builder/destruction hooks come later — nothing here touches the store,
 * three.js, or React.
 */

/** Grid slot identifier — grid.ts's slotId codec output. */
export type SlotId = string

/** Geometric adjacency: every slot whose piece would share an edge/vertex
 * with `slotId`'s, present or not (the graph filters by presence). */
export type SlotsTouching = (slotId: SlotId) => readonly SlotId[]

/** Scene-support probe: true while world geometry (terrain, a live scene
 * wall…) still holds this slot up. Queried on every recompute — flip it
 * and call `invalidate()` when the scene changes under the graph. */
export type ProbeExternal = (slotId: SlotId) => boolean

export class SupportGraph {
  private readonly slotsTouching: SlotsTouching
  private readonly probeExternal: ProbeExternal
  /** Slots currently holding a piece. */
  private readonly present = new Set<SlotId>()
  /** Present slots the caller flagged grounded (terrain contact). */
  private readonly grounded = new Set<SlotId>()
  /** Memoized isSupported answer set; null = dirty. */
  private supportedCache: Set<SlotId> | null = null

  constructor(slotsTouching: SlotsTouching, probeExternal: ProbeExternal = () => false) {
    this.slotsTouching = slotsTouching
    this.probeExternal = probeExternal
  }

  /** Register a placed piece. `grounded` marks a terrain root (the caller
   * decides the rule — typically storey 0 resting on the ground). */
  add(slotId: SlotId, opts: { grounded?: boolean } = {}): void {
    this.present.add(slotId)
    if (opts.grounded) this.grounded.add(slotId)
    this.supportedCache = null
  }

  /** Unregister a slot (piece removed, destroyed, or collapsed). */
  remove(slotId: SlotId): void {
    this.present.delete(slotId)
    this.grounded.delete(slotId)
    this.supportedCache = null
  }

  has(slotId: SlotId): boolean {
    return this.present.has(slotId)
  }

  get size(): number {
    return this.present.size
  }

  /** Drop the support cache — call when the WORLD changed under the graph
   * (a scene wall the probe counted on was demolished). Add/remove
   * invalidate on their own. */
  invalidate(): void {
    this.supportedCache = null
  }

  /** True iff the slot holds a piece connected to any grounded slot
   * through present slots. Cached until the graph or world changes. */
  isSupported(slotId: SlotId): boolean {
    if (!this.present.has(slotId)) return false
    return this.supportedSet().has(slotId)
  }

  /**
   * The component orphaned by a removal, as rings ordered by BFS distance
   * from `removedSlotId` (rings[0] collapses first). Handles both death
   * modes:
   * - piece removed: call `remove(removedSlotId)` first, then this;
   * - external support lost: flip the probe, `invalidate()`, then call
   *   this with the slot that lost its footing — if it is now
   *   unsupported it leads ring 0 itself.
   *
   * Every returned slot is EVICTED from the graph (it is doomed — keeping
   * it would corrupt later queries); the consumer only animates the fall.
   * Returns [] when nothing collapses.
   */
  computeCollapse(removedSlotId: SlotId): SlotId[][] {
    const supported = this.supportedSet()
    const doomed = (id: SlotId): boolean => this.present.has(id) && !supported.has(id)

    const rings: SlotId[][] = []
    const visited = new Set<SlotId>([removedSlotId])
    let frontier: SlotId[] = []
    if (doomed(removedSlotId)) {
      frontier = [removedSlotId]
    } else {
      for (const neighbor of this.slotsTouching(removedSlotId)) {
        if (visited.has(neighbor) || !doomed(neighbor)) continue
        visited.add(neighbor)
        frontier.push(neighbor)
      }
    }

    while (frontier.length > 0) {
      rings.push(frontier)
      const next: SlotId[] = []
      for (const id of frontier) {
        for (const neighbor of this.slotsTouching(id)) {
          if (visited.has(neighbor) || !doomed(neighbor)) continue
          visited.add(neighbor)
          next.push(neighbor)
        }
      }
      frontier = next
    }

    // Safety net: an unsupported slot with no doomed path to the removal
    // point (cannot happen when the removal caused the orphaning, but the
    // graph must never leak floaters). Trails as one final ring.
    const stragglers: SlotId[] = []
    for (const id of this.present) {
      if (!supported.has(id) && !visited.has(id)) stragglers.push(id)
    }
    if (stragglers.length > 0) rings.push(stragglers)

    for (const ring of rings) {
      for (const id of ring) {
        this.present.delete(id)
        this.grounded.delete(id)
      }
    }
    if (rings.length > 0) this.supportedCache = null
    return rings
  }

  /** Recompute (or reuse) the set of supported slots: multi-source BFS
   * from every root — caller-grounded or externally propped — through
   * present slots. */
  private supportedSet(): Set<SlotId> {
    if (this.supportedCache) return this.supportedCache

    const supported = new Set<SlotId>()
    let frontier: SlotId[] = []
    for (const id of this.present) {
      if (this.grounded.has(id) || this.probeExternal(id)) {
        supported.add(id)
        frontier.push(id)
      }
    }
    while (frontier.length > 0) {
      const next: SlotId[] = []
      for (const id of frontier) {
        for (const neighbor of this.slotsTouching(id)) {
          if (supported.has(neighbor) || !this.present.has(neighbor)) continue
          supported.add(neighbor)
          next.push(neighbor)
        }
      }
      frontier = next
    }

    this.supportedCache = supported
    return supported
  }
}
