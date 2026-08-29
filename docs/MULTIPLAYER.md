# Boots co-presence (v1)

Other builders working in the same project appear INSIDE your game session
as live avatars. That is the whole feature: presence, not shared combat.
Each client's game stays exactly what solo is — plus ghosts.

## The one-paragraph model

The host editor ships a collaboration bus (`globalThis.__pascalCollabBus`).
While a Boots session runs, the plugin publishes a tiny pose frame ~12
times a second and subscribes to everyone else's. Remote poses are rendered
150 ms in the past through a snapshot-interpolation ring, as primitive
avatar rigs with the peer's held-weapon silhouette and a name tag. No world
state crosses the wire — no destruction, no builds, no bots, no scene
writes. Every function is feature-detected: with no bus (solo app, older
hosts, `:3002`), co-presence is a total no-op.

## Layering

| Module | Role |
| --- | --- |
| `src/game/presence-interp.ts` | PURE math: snapshot ring (cap 24), sampleAt (lerp / extrapolate ≤200 ms then freeze / >3 m teleport snap), staleness predicate, wire-frame validation. |
| `src/game/presence.ts` | Bus adapter: feature detection, publish policy, remote registry, join/leave events, QA counters. The only module that touches the bus. |
| `src/game/remote-players.tsx` | R3F rendering: `<RemotePlayers/>` → `<RemoteAvatar>` rigs, articulation, weapon silhouettes, name-tag billboards, HUD chip drive. |
| `src/game/game-root.tsx` | Lifecycle wiring (start/stop keyed on the session serial), local pose sampler, `__boots.presence()` QA handle, toast wiring. |
| `src/game/session.ts` | `exitGame` goodbye frame; scene-write sentinel with the remote-op discriminator. |
| `src/game/hud.ts` | "N builders here" chip + muted join/leave toasts. |

## Wire protocol v1 (~150 B/frame)

Published as plugin event `('pascal:boots', 'player')`:

```jsonc
{
  "v": 1,             // protocol version — anything else is rejected
  "ph": "game",       // 'game' | 'editor' ('editor' = explicit leave)
  "p": [x, y, z],     // EYE position, 2 decimals (renderer plants feet)
  "yaw": 1.571,       // radians, wrapped, 3 decimals
  "pitch": -0.25,     // radians, 3 decimals
  "w": "rifle",       // held weapon id (unknown ids render bare hands)
  "s": 0.62,          // horizontal speed normalized 0..1 (gait cadence)
  "g": true,          // grounded (false = airborne tuck pose)
  "st": false         // staggered (true = slump pose)
}
```

Validation (`validateFrame`) is the trust boundary: wrong version, unknown
phase, NaN/oversize positions or angles, non-boolean flags and oversize
weapon ids are dropped silently; `s` is clamped instead of dropped.

## Publish policy (pinned by tests)

- 12 Hz base; 10 Hz once MORE than 4 remotes are live (crowd back-off).
- Idle skip: a pose unchanged beyond epsilons (1.5 cm / ~0.09° / discrete
  fields exact) is not re-sent — but never stay silent longer than 500 ms
  (the keep-alive that feeds peers' staleness clocks).
- `publish()` returning `'deferred'` is a SKIP, not a queue: the frame is
  dropped and the next attempt builds a fresh one.
- `stopPresence()` publishes one final explicit `ph:'editor'` frame so
  peers despawn our avatar instantly.

## Remote lifecycle

- **Join**: first `'game'`-phase frame from an unseen sessionId → registry
  entry, roster bump, join toast, avatar scales in over 200 ms.
- **Leave** (all three remove the entry instantly):
  1. explicit `ph:'editor'` frame (peer pressed Esc / exited),
  2. staleness — silent > 3 s (crash, tab close, network drop),
  3. roster drop via `onParticipants` (peer left the project session).
- Same user in two windows = two sessions = two avatars. Correct: both
  cursors exist in the editor too.
- Self-echo (our own sessionId) is ignored at ingest.

## Rendering

Remotes are sampled at `now − clockOffset − 150 ms` (clockOffset = per-peer
EMA of local-vs-sentAt skew), lerped between bracketing snapshots with
shortest-arc yaw/pitch; past the newest snapshot they extrapolate along the
last velocity for ≤ 200 ms, then freeze. Consecutive snapshots > 3 m apart
snap (spawn/teleport, never a cross-map glide).

Avatars are ~10 primitives over 5 cached geometries, tinted per player from
an 8-color palette keyed by a userId hash (materials cached per slot, so a
crowd shares programs). Articulation is pure (`articulate`): gait-sine legs
driven by `s`, counter-swinging free arm, weapon arm following `pitch`,
airborne tuck when `!g`, slump when `st`. The held weapon reuses the
viewmodel's weapon-model components, swapped on `w`. The name tag is a
CanvasTexture billboard (guntable TableSign idiom — disposed on despawn)
hidden past 40 m. WebGPU-safe throughout: primitives + standard materials +
CanvasTexture only; zero per-frame allocations (module temps, ring slots
reused).

## Invariants (standing rules applied to multiplayer)

- **Non-destructive, per client**: the game still NEVER writes the scene
  store. Presence adds no write path — pose frames only.
- **Avatars are non-solid and non-shootable** (deliberate anti-goal, do not
  "fix"): they never join `world.colliders` and are never registered with
  any raycast registry (shooting raycasts its own registries, not the scene
  graph). Peers cannot block doorways, eat bullets, or brace a build.
- **Frozen world snapshot**: a peer's collaboration edit CAN land in our
  scene store mid-session — the host applies remote ops under its remote-op
  lease (`useScene.getState().readOnly === true`). The scene-write sentinel
  discriminates: lease writes log a calm
  `[boots] remote collaboration op during play (world snapshot stays frozen)`
  console.info; any non-lease write during play is still the INVARIANT
  VIOLATION error. The session keeps playing against its entry snapshot;
  the peer's change appears after Esc like every host-side restore.
- **No world-state sync in v1**: your holes, debris, bots, placed pieces
  and paint are yours alone. Two players see each other move through
  *their own* copies of the world. Shared destruction/combat is a future
  phase with its own design (authority, reconciliation) — do not bolt it
  onto presence frames.

## HUD

- Chip (top-left, muted): "N builders here" while remotes > 0.
- Toasts (under the chip, muted, queued): "Alice joined" / "Alice left".

## QA surface

- `__boots.presence()` → `{ remotes: [{sessionId, name, p, w, ageMs}],
  published, received }` (plain copies).
- Counters: `published` = frames the bus accepted (`'sent'` only),
  `received` = valid non-self frames ingested.
- Console: zero sentinel ERRORs is still the hard gate; the lease info line
  is expected noise when a peer edits mid-session.
- Two-browser script skeleton: `docs/qa/qa-boots-presence.mjs` (community
  app on `:3001` only — the solo app has no bus, presence no-ops there).

## Two-browser e2e checklist (post-merge, against :3001)

1. Both clients in the same project, both Jump in: each sees one avatar,
   chip reads "1 builder here", `presence().remotes.length === 1`,
   `published`/`received` both climbing.
2. A walks/runs/jumps: B sees smooth motion (no rubber-banding at 12 Hz),
   gait cadence tracks speed, airborne pose on jumps.
3. A swaps weapons: B sees the silhouette change; A staggers: B sees slump.
4. A presses Esc: avatar despawns on B INSTANTLY (goodbye frame), leave
   toast fires, chip clears. Re-entry re-joins with the 200 ms scale-in.
5. Kill A's tab instead: B despawns it within ~3 s (staleness).
6. A edits the scene from the editor while B plays: B's console shows the
   calm lease info line, ZERO invariant errors, and B's world stays frozen
   until Esc.
7. Solo regression: on `:3002` (no bus) everything above is absent and
   `presence()` reads empty/zero — the game is untouched.
