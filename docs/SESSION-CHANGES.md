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

## One project at a time (shipped 2026-09-02)

Owner P0: *"i placed items and walls in a project. then changed project went
to boots. and even though i just started on this one I see 'save changes'
'discard all' and many items and walls and roofs that i placed IN THE
DIFFERENT PROJECT."*

Every Boots store is a module singleton, and the editor switches projects
with a client-side navigation that never reloads the page — so project B
inherited A's four lanes: offered in the sidebar, drawn by the preview, and
one Save away from being written into the wrong document. The fix
(`project-scope.ts`, mounted by `system.tsx`):

- **The lanes know whose fort they hold.** `pending-lanes.ts` keeps a *lane
  scope*, adopted on first use and changed only by the guard. Every write goes
  under the lane scope, never under the URL of the moment.
- **The identity is the route, then the bus.** `/editor/<id>`, `/play/<id>`,
  `/scene/<id>` change on the first frame of a navigation; the collab bus is a
  page global installed later and may still name the project you left. A page
  with neither has a null scope: no key, no persistence, no shared default.
- **On a change** a live session is ended (its Esc-time write lands under the
  OLD scope), the old window is written down one last time, **every store that
  outlives a session is hard-reset** (the four lanes, the catalog ghost, the
  loadout, the shared lane's attribution, the slot registry, the drop one-shot),
  the lanes adopt the new scope and the restore latch is cleared — so the new
  project's own window comes back, and so does the old project's when you
  return to it.
- **The restore waits for the document**: right after a switch the scene store
  may still hold the old document, and pruning the new window against it would
  drop every leveled and painted row as "gone". The guard holds the restore
  until the host replaces the nodes map (capped at 5 s).
- Checked on mount, on every scene / viewer store change, on `popstate`, and at
  1 Hz as the untrusted-host backstop; the steady-state check allocates nothing.

`project-scope.test.ts` pins all three promises: A's window is invisible under
B (memory and storage), the reset covers every store and A restores again on
return, and a missing id never maps to a shared key.

**Where the id comes from.** The prod editor lives at `/editor/<projectId>`
(`apps/community/app/editor/[projectId]/page.tsx`) and every project switch in
the app menu, the hub and the sidebar is a `router.push('/editor/<id>')`; the
local dev host is `/scene/<id>`, the lobby `/play/<id>`. `pending-store.ts`
reads that path segment FIRST and falls back to `__pascalCollabBus.projectId`
only on a page with no project route. The bus is a page global installed after
realtime auth (the current host checkout does not install it at all), so a
bus-first identity names the project you just LEFT for as long as the old bus
lingers — or forever, if the new one never comes. The viewer store's
`projectId` is a change SIGNAL only, never a key: it reads `'default'` on hosts
without projects, which is exactly the shared fallback this rule forbids.

**Proof.** `scripts/qa/project-leak.mjs` (`TAG=after node
scripts/qa/project-leak.mjs` against :3002) builds two walls in A, Esc's,
client-side navigates to a copy B (`window.next.router.push`, the prod switch)
and asserts: no Save/Discard offer in B, zero preview meshes, no
`boots.pending.1.<B>` key even after a Jump in + Esc there, A's offer back on
return, B still clean after a full reload. In prod: open project A, Jump in,
build, Esc (Save/Discard appears) → open another project from the app menu →
the Boots panel must show no offer and the viewport no ghost pieces → back to
A → the offer is back.

## A read-only document is refused, never reported as saved (shipped 2026-08-31)

Every bridge writes through host node actions that **no-op on `readOnly`** and
then clears its own captures, so a Save on a read-only scene used to print a
full receipt — *"Kept 4 walls · repainted 7"* — for a document that changed in
no way, and the session's work went out with the captures. The worse half is the
loss, not the wrong number.

`saveSessionChanges` now asks `writable()` first and runs **no bridge at all**,
returning *"Nothing saved — this project is read-only right now. Your changes
are still pending."* `persist` is skipped with the rest, so the stored window
survives and the same button works once the lease is released. `applyPaint`
carries the same refusal on its own, because it is the one bridge that writes
through a raw `setState` and so cannot inherit the host's guard.

Unreachable in the product today — the panel only renders for the owner, and
`/play` registers no panel — which is exactly why it was worth closing before a
retry path or a shared-editor session makes it reachable.
