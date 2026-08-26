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
3. **Keep/Discard is the one bridge**, and it only exists AFTER Esc, as an
   explicit decision in the sidebar: Keep converts the session's built
   pieces into real nodes in one batch (normal, undoable editor nodes);
   Discard forgets everything. The panel says it in plain words: *"Nothing
   was saved while you played… Discard leaves your building exactly as it
   was."*
4. **Scene-write sentinel** (session.ts): a store subscription armed for the
   whole session that screams `INVARIANT VIOLATION` in the console if any
   code path ever writes the scene during play. A canary — CI/QA watch for
   it; it never auto-fixes.

## Not yet shipped (phase 7 candidate): saving DESTRUCTION

Today only *builds* can be kept; demolition always evaporates on Esc. The
optional next step, same explicit-decision shape:

- After Esc, the panel reports both sides: "You built 4 pieces · you fully
  destroyed 2 walls, 1 door."
- **Save changes** = one undoable batch: kept builds (as today) + fully
  destroyed nodes are DELETED via the host's `deleteNodes` (host undo can
  bring them back). Partially damaged nodes are NOT persisted in v1 — a
  half-carved wall has no faithful node representation; it stays intact in
  the editor and the panel says so.
- **Discard all** = today's behavior, untouched.
- Guardrails: the batch runs only from the explicit button; the sentinel
  stays armed until the session's pendingDecision resolves; the panel shows
  the exact node count that would be deleted before the click.
