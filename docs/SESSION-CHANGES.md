# Session changes — the persistence contract

The single promise players must be able to trust: **playing Boots can never
cost you your building.** Five minutes of demolition derby leaves the saved
scene byte-for-byte what it was.

## How the guarantee works (shipped)

1. **The game never writes the scene store during play.** Destruction is
   visual: host meshes hide through the session restore ledger, voxel
   replicas take over, and Esc restores everything. Verified by every QA
   round ("editor pristine, originals intact") and audited: the ONLY
   `createNode` calls in the plugin live in `keep.ts`.
2. The host autosaves its draft **from the live store** — so because the
   store never changes mid-session, autosave can only ever capture the
   untouched building, even if it fires mid-firefight.
3. **Save/Discard is the one bridge**, and it only exists back in the editor,
   as an explicit decision in the sidebar: Save converts the session's work
   into real nodes in one batch (normal, undoable editor nodes); Discard
   forgets everything. The panel says it in plain words: *"Nothing was saved
   while you played… Discard leaves your building exactly as it was."*
4. **Scene-write sentinel** (session.ts): a store subscription armed for the
   whole session that screams `INVARIANT VIOLATION` in the console if any
   code path ever writes the scene during play. A canary — CI/QA watch for
   it; it never auto-fixes.

## The four lanes

Save and Discard act on exactly four lanes, and every one of them is the
player's own work only (a shared world's foreign rows are filtered out at the
source, so a stranger's wall is never yours to keep or to throw away):

| Lane | Store | Save does |
| --- | --- | --- |
| Built | `useBoots.placed` | creates wall / roof-segment / slab nodes |
| Leveled | `useDemolition.destroyed` | deletes those nodes (`deleteNodes`) |
| Painted | `usePaintKeep.painted` | recolors nodes to their dominant coat |
| Placed | `useItems.items` | creates furniture, doors and windows |

Partially damaged nodes are NOT persisted — a half-carved wall has no faithful
node representation, so it stays intact in the editor and the panel says so.
The splatter art itself stays in the game too; Save only carries the dominant
colour onto the real node.

## The offer is a STATE, not a moment (shipped)

The decision UI used to hang off a `pendingDecision` flag set when you pressed
Esc and cleared when you jumped back in. That made the offer a *moment*:
reload the editor and a fort you had never decided about was simply gone from
the sidebar.

The gate is now **`phase === 'editor'` and a non-empty lane** — offered for as
long as that is true, in the sidebar and in the viewport preview alike. What
the flag actually protected is still protected: during play the phase is
`'game'`, so no Save click can reach the scene store.

## The pending window survives a reload (shipped)

Owner call: *"save the state of builds/textures and destruction even when
people are back in the editor (and offer to reset/discard anytime in
sidebar)."*

All four lanes are mirrored into `localStorage` (`pending-store.ts` for the
format, `pending-lanes.ts` for the store side), so closing the tab and coming
back tomorrow still shows the same list with the same two buttons.

- **One key per project** (`boots.pending.1.<scope>`), scoped from the route
  (`/editor/`, `/play/`, `/scene/`) or the collab bus project id. With no
  scope there is NO persistence and no shared fallback key: losing a pending
  window is recoverable, mixing two buildings is not.
- **Foreign rows are filtered at capture time**, not at restore. A stranger's
  wall would otherwise come back tomorrow indistinguishable from ours —
  foreignness is a runtime, per-page-load fact.
- **Restore refuses to fight a live session**: not during play, not over an
  already non-empty lane, and never twice for the same scope.
- Ids are **re-minted** by the hydrator through the real `addPlaced` /
  `addItem` / `addAperture` counters, and restored local pieces are
  republished to peers.
- Save and Discard both **forget the stored window** as their last step,
  outside the undo batch — a Save that left it behind would offer the same
  decision again, on top of the nodes it just wrote.
- Caps are explicit (bytes, rows per lane, number of scopes) and pruning is
  reported, never silent.
