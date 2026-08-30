# Boots multiplayer

Other builders in the same project appear INSIDE your game session and — as
the shared-world work lands — break and build the same fort you do. The
destination is a synchronous lobby. Avatars are simply the first kind of
frame that works.

Two layers, and the split matters:

- **`net.ts` — the transport.** Generic, kind-agnostic, the only module that
  touches the host bus. It moves bounded, validated, ordered frames of any
  registered `kind` and owns the late-join handshake.
- **kind owners.** `presence.ts` owns `'pose'` (this document's second half).
  `shared-world.ts` owns `'boots/world'` and `'boots/world-snap'` (Part 3).
  Neither knows anything about the other.

Every function in both layers is feature-detected: with no bus (solo app,
older hosts, `:3002`, or the host's `NEXT_PUBLIC_PLUGIN_COLLAB` off),
multiplayer is a total no-op — nothing scheduled, nothing sampled, not one
byte on the wire.

## Layering

| Module | Role |
| --- | --- |
| `src/game/net.ts` | THE TRANSPORT. Host-bus feature detection, the frame envelope, per-kind sequence numbers + loss reporting, the payload cap, kind registration/routing, roster pass-through, late-join request/snapshot. Knows nothing about poses or destruction. |
| `src/game/presence-interp.ts` | PURE pose math: snapshot ring (cap 24), sampleAt (lerp / extrapolate ≤200 ms then freeze / >3 m teleport snap), staleness predicate, pose-frame validation. |
| `src/game/presence.ts` | The AVATAR layer — one kind (`'pose'`) on the transport: publish policy, remote registry, crowd ceiling, join/leave events, QA counters. |
| `src/game/remote-players.tsx` | R3F rendering: `<RemotePlayers/>` → `<RemoteAvatar>` rigs, articulation, weapon silhouettes, distance-faded name tags, HUD chip drive. |
| `src/game/game-root.tsx` | Lifecycle wiring (start/stop keyed on the session serial), local pose sampler, `__boots.presence()` QA handle, toast wiring. |
| `src/game/session.ts` | `exitGame` goodbye frame; scene-write sentinel with the remote-op discriminator. |
| `src/game/hud.ts` | "N builders here" chip + muted join/leave toasts. |

# Part 1 — the frame bus (`net.ts`)

## The envelope

Every Boots frame on the wire is the same shape, whatever it carries:

```jsonc
{
  "v": 1,            // envelope protocol — anything else is dropped
  "kind": "pose",    // 'pose' | 'boots/world' | 'boots/world-snap'
                     //   | 'state-request' | 'state-snapshot'
  "seq": 41,         // per (sender, kind), monotonic, starts at 1
  "part": 1,         // OPTIONAL chunk markers; absent = a whole frame
  "parts": 1,
  "data": { }        // the kind owner's payload
}
```

The host adds `sessionId` / `clientId` / `userId` / `sentAt` around it, from
the connection. **Those four are the only trustworthy identity on an inbound
frame**; a payload field claiming authorship is attacker-controlled.

Adding a kind is additive and safe — older clients drop unknown kinds at
`readEnvelope`, so a peer on last week's pin ignores what it cannot
understand. **Renaming** a kind is breaking, and a test pins the list.

## One host event per kind (do not "simplify" this)

Frames publish as `(pluginId: 'pascal:boots', event: <kind>)`. The host
coalesces to the **latest value per `(pluginId, event)` every 66 ms**. If
every kind shared one event, a 12 Hz pose stream would silently swallow world
frames. Per-kind events mean each stream only ever coalesces against itself.

The same rule is why deltas and snapshots of the *same* state get **two**
kinds. On one event, a 6 kB snapshot would coalesce away the shot that landed
20 ms later, and a lattice only heals that on the next snapshot. Two events,
two independent 66 ms slots.

## Sequence semantics

- **Outbound**: one counter per kind, starting at 1. It advances on every
  publish **attempt**, including attempts the host defers or suppresses — so
  a receiver's gap count reflects real loss instead of reading as contiguous.
- **Inbound, ordered kinds (the default)**: the newest accepted `seq` is
  remembered per `(senderSession, kind)`. Anything at or below it is a
  duplicate or a late reorder and is dropped — the stream never rewinds.
  Right for poses, where an old frame is strictly worse than the one you
  already drew.
- **Inbound, convergent kinds** (`registerFrameKind(kind, validate,
  { ordered: false })`): duplicates and reorders are **delivered**. Correct
  when the merge is a lattice join — a duplicate costs one no-op and a
  reordered frame still carries records that ordering would have discarded.
- Delivered messages carry **`skipped`**: how many sequence numbers went
  missing before this frame, measured off the highest `seq` seen (`0` =
  contiguous). Poses ignore it. **A state-carrying kind should treat
  `skipped > 0` as "I lost frames — a snapshot will heal it"**, because a lost
  delta never comes back.
- Inbound trackers are bounded at `SEQ_TRACK_MAX` (256) senders, recycled
  oldest-first, so fabricated session ids cannot grow memory. The trade: a
  long-silent sender may replay one sequence number. `forgetSender()`
  releases a departed peer's tracker explicitly.

## Publish verdicts

`publishFrame` returns the host's verdict verbatim, or a local refusal:

| Result | Meaning |
| --- | --- |
| `'sent'` | On the wire. |
| `'deferred'` / `'suppressed'` | **The frame is gone** (host coalescing / rate limiting). Latest-value-correct kinds (poses, cumulative grow-only sets) just send again next tick. Anything delta-shaped MUST re-send or fall back to a snapshot. |
| `'unavailable'` | No bus — the host flag is off, or the bus is tearing down. |
| `'too-large'` | Refused locally, never truncated (see below). |
| `'unregistered'` | No validator registered for that kind — a wiring bug, surfaced instead of swallowed. |

## Bounds (the trust boundary)

- The host rejects any plugin frame over 8 000 **serialized chars** — not a
  megabyte, and not bytes. The bus is a JSON channel: the host measures
  `JSON.stringify(data).length`. We refuse oversize payloads **before**
  publishing (`MAX_PAYLOAD_SERIALIZED` = 8 000 − 120 envelope reserve;
  `payloadFits()` checks it) rather than letting the host drop them silently.
- **Binary must travel as text.** A `Uint8Array` serializes to
  `{"0":12,"1":250,…}`, roughly 6 chars per byte, so ~1.3 kB of state already
  blows a frame. Base64 costs ×1.333 and is the only viable encoding here.
- Anything bigger must be **chunked** with `{part, parts}`. The transport
  orders chunks and reports loss; **reassembly and merging are the state
  owner's job** — only they know whether their state is an idempotent
  grow-only set or an order-sensitive sequence.
- Inbound, `readEnvelope` validates the envelope (total: a hostile getter
  reads as invalid, never a throw) and the kind's registered validator
  normalizes the payload. **A kind with no validator is undeliverable** —
  subscribing before registering does not open a hole, because an
  unvalidated payload must never exist. A stranger's frame can therefore
  only ever become a value the receiving subsystem asked for.
- Self-echo is dropped. A host `event` that disagrees with the envelope
  `kind` is treated as a spoof and dropped. One subsystem's throwing handler
  never costs another its frames.

## Late join

Poses do not need it — the next tick fixes everything. Accumulated state
does: a visitor walking into a lobby whose walls are already half gone must
be told what happened before they arrived. The handshake:

1. the joiner calls `requestState('boots/world')`;
2. every peer's `onStateRequest` fires, with a **host-stamped** `from`;
3. the answerers reply with `sendStateSnapshot('boots/world', requester,
   state)`, chunking if it exceeds the payload budget;
4. the joiner's `onStateSnapshot('boots/world')` merges. Snapshots are
   **broadcast** (the host bus has no direct addressing), hence the `for`
   field — snapshots addressed to somebody else are ignored for you.

**Who answers** is a deliberate choice, not a detail:

| Strategy | When it is sound |
| --- | --- |
| **Every peer answers with its OWN records** | Whenever the receiver gates records by author. An aggregate snapshot cannot pass a per-frame authorship check, so only the sender's own records would survive anyway. N answers for N peers, bounded by the roster. **This is what `shared-world.ts` uses.** |
| One peer answers for the room (`shouldAnswerStateRequest`, pure — lowest live `sessionId`, requester never answers itself) | Only where the transport **vouches** for the relay. This bus stamps who sent a frame; it does not vouch that a peer faithfully relayed others' records. Never use it for authorship-gated state. |

The two late-join kinds are owned by the **transport**, not by a kind owner,
and are always registered: you ask for state precisely because you have
none, so `requestState` must work before you have subscribed to anything.

# Part 2 — avatar co-presence (`presence.ts`)

While a Boots session runs, the plugin publishes a tiny pose frame ~12 times
a second and subscribes to everyone else's. Remote poses are rendered 150 ms
in the past through a snapshot-interpolation ring, as primitive avatar rigs
with the peer's held-weapon silhouette and a distance-faded name tag.

## Pose payload v1 (~150 B/frame)

Rides the envelope as `kind: 'pose'`:

```jsonc
{
  "v": 1,             // pose protocol version — anything else is rejected
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

`validateFrame` is the pose trust boundary and returns a NORMALIZED copy,
never the sender's object: wrong version, unknown phase, NaN/oversize
positions or angles, non-boolean flags and oversize weapon ids are dropped
silently; `s` is clamped instead of dropped; unknown extra fields are
stripped (forward compatibility, so a newer peer's frame still renders).

## Publish policy (pinned by tests)

- 12 Hz base; 10 Hz once MORE than 4 remotes are live (crowd back-off).
- Idle skip: a pose unchanged beyond epsilons (1.5 cm / ~0.09° / discrete
  fields exact) is not re-sent — but never stay silent longer than 500 ms
  (the keep-alive that feeds peers' staleness clocks).
- `'deferred'` is a SKIP, not a queue: the frame is dropped and the next tick
  builds a fresh one. Stale poses are worse than missing ones.
- `stopPresence()` publishes one final explicit `ph:'editor'` frame so peers
  despawn our avatar instantly.

## Remote lifecycle

- **Join**: first `'game'`-phase frame from an unseen sessionId → registry
  entry, roster bump, join toast, avatar scales in over 200 ms. A late
  joiner sees everyone already there within one publish interval, because
  every peer is publishing continuously.
- **Leave** (all three remove the entry instantly):
  1. explicit `ph:'editor'` frame (peer pressed Esc / exited),
  2. staleness — silent > 3 s (crash, tab close, network drop),
  3. roster drop via `onParticipants` (peer left the project session).
- Same user in two windows = two sessions = two avatars. Correct: both
  cursors exist in the editor too.

## Crowd ceiling

An open lobby has no roster limit of its own, so the plugin brings its own
bound: `MAX_REMOTE_AVATARS` = **12** rendered remotes. Past it the
**farthest** peers lose their slot instead of everyone losing frame rate —
a packed lobby costs what a full one costs.

- The decision (`admitRemote`, pure) happens **before** registry insertion,
  so a refused peer costs one comparison and never bumps the roster (no
  React re-render, no rig mount).
- A newcomer must be `CROWD_SWAP_MARGIN_M` (2 m) closer than the farthest
  rendered peer to take its slot. Without that hysteresis two strangers at
  similar range would trade the last slot every frame.
- Unknown distance ranks as farthest, oldest-heard losing ties; with no
  distances at all the fallback is pure recency, so the cap always holds.
- A culled peer is **not** announced as having left — it is still in the
  project, and the HUD does not lie. `culled` is exposed for QA.

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
viewmodel's weapon-model components, swapped on `w`.

The name tag is a CanvasTexture billboard (guntable TableSign idiom —
disposed on despawn): fully opaque to `TAG_FADE_START` (24 m), then linearly
faded to nothing at `TAG_MAX_DIST` (40 m), where it is also hidden outright.
Opacity is change-gated so a stationary crowd writes no material state.
WebGPU-safe throughout: primitives + standard materials + CanvasTexture
only; zero per-frame allocations (module temps, ring slots reused).

## Invariants (standing rules applied to multiplayer)

- **A remote frame NEVER writes the scene store.** Neither `net.ts` nor
  `presence.ts` imports the scene store or any of the four Save bridges
  (`keep` / `save-demolition` / `paint-keep` / `item-keep`), and
  `presence-hostile.test.ts` pins that structurally as well as at runtime: a
  full hostile battery ingested with the sentinel armed leaves the nodes map
  **object-identical**. Shared destruction changes what crosses the wire; it
  does not change this. It is client-local voxel state, still not a scene
  write.
- **Avatars are non-solid and non-shootable** (deliberate anti-goal, do not
  "fix"): they never join `world.colliders` and are never registered with
  any raycast registry. Peers cannot block doorways, eat bullets, or brace a
  build.
- **Frozen world snapshot**: a peer's collaboration edit CAN land in our
  scene store mid-session — the host applies remote ops under its remote-op
  lease (`useScene.getState().readOnly === true`). The scene-write sentinel
  discriminates: lease writes log a calm
  `[boots] remote collaboration op during play (world snapshot stays frozen)`
  console.info; any non-lease write during play is still the INVARIANT
  VIOLATION error.
- **Hostile by default**: every inbound payload is schema-validated, bounded
  and normalized to a copy. No prototype, getter or extra field of a
  stranger's object survives the boundary.

## Not in the avatar layer

Deliberately out of scope for `presence.ts`, by design rather than by
omission — these belong to the shared-world kinds on the same bus:

- shared damage and health, shared enemy waves, shared pickups;
- shared destruction and placed pieces (`'destruction'` / `'build'`);
- anything authoritative. There is no server: every client is a peer, and
  convergence is the state model's job, not the transport's.

## QA surface

- `__boots.presence()` → `{ remotes: [{sessionId, name, p, w, ageMs}],
  published, received, culled, cap }` (plain copies).
- Counters: `published` = frames the bus accepted (`'sent'` only),
  `received` = valid non-self pose frames ingested, `culled` = valid frames
  refused by the crowd ceiling.
- Console: zero sentinel ERRORs is the hard gate; the lease info line is
  expected noise when a peer edits mid-session.
- Two-browser script skeleton: `docs/qa/qa-boots-presence.mjs` (community
  app on `:3001` only — the solo app has no bus, multiplayer no-ops there).

## Two-browser e2e checklist

1. Both clients in the same project, both Jump in: each sees one avatar,
   chip reads "1 builder here", `presence().remotes.length === 1`,
   `published`/`received` both climbing.
2. A walks/runs/jumps: B sees smooth motion (no rubber-banding at 12 Hz),
   gait cadence tracks speed, airborne pose on jumps.
3. A swaps weapons: B sees the silhouette change; A staggers: B sees slump.
   (Spawn holds the BUILDER — press Digit1 before any firing probe.)
4. Name tag is solid up close, fades out walking away, gone past 40 m.
5. A presses Esc: avatar despawns on B INSTANTLY (goodbye frame), leave
   toast fires, chip clears. Re-entry re-joins with the 200 ms scale-in.
6. Kill A's tab instead: B despawns it within ~3 s (staleness).
7. B reloads mid-session: A is there immediately, exactly once — no ghost of
   B's previous session lingers on A.
8. A edits the scene from the editor while B plays: B's console shows the
   calm lease info line, ZERO invariant errors, world stays frozen until Esc.
9. Solo regression: on `:3002` (no bus) everything above is absent and
   `presence()` reads empty/zero — the game is untouched.

# Part 3 — the shared world on this bus

`shared-world.ts` / `shared-wire.ts` / `shared-derive.ts` are a pure
convergent model with no networking. This is how they meet the transport —
the answers are decisions, not suggestions.

**Kinds.** `'boots/world'` carries `SharedDelta` with `kind: 'delta'`;
`'boots/world-snap'` carries `SharedDelta` with `kind: 'snapshot'`
(`snapshotOf(world)`). `SharedDelta.kind` already distinguishes them, but they
get separate host events anyway, for the coalescing reason above.

**Encoding.** `encodeDeltaText` / `decodeDeltaText` (base64), **not**
`encodeDelta` / `decodeDelta`. The bus is JSON; a `Uint8Array` does not
survive it.

**Ordering.** Both kinds register with `{ ordered: false }`. The merge is a
lattice join, so reorder, duplicate and drop are all safe, and dropping a
reordered frame would throw away records for nothing.

**The sender.** `mergeDelta(world, delta, sender)` must be called with
`sender = msg.sessionId` — the host-stamped envelope field — never
`delta.from`. Host session ids are `isSafePeerId`-shaped in practice (short,
`#`-free); if a host ever hands over one that is not, `mergeDelta` drops the
whole frame, which is the correct failure. `#` is the record-id separator, so
a peer id containing it would be an identity forgery.

**Byte ceiling.** The transport's is **8 000 serialized chars**, ~130× tighter
than `shared-wire`'s own `MAX_FRAME_BYTES` (1 MiB). Measured: a rifle shot's
delta ~100 B binary → ~136 B base64, comfortable; a 28-node / 10.7 k-dead-cell
snapshot 4.7 kB → ~6.2 kB base64, which fits the 7 880-char budget **but only
just**. A bigger lobby must chunk — `{part, parts}` is reserved for exactly
this, one node per chunk being the natural split. `payloadFits()` before
publishing, and `'too-large'` if you skip the check.

**Coalescing is the real hazard, not loss.** The host keeps only the latest
value per event per 66 ms. A burst of deltas inside one window is *lost*, not
queued. So: accumulate locally and flush **one** delta per ~66 ms tick (a
delta is itself a union, so batching is free and exact), and publish a full
snapshot periodically as the healing channel. `publishFrame` returns the host
verdict verbatim — `'deferred'` / `'suppressed'` mean *that frame is gone*.

**Late join.** Every peer answers a `requestState('boots/world')` with its
**own** records (see the table above). Snapshots are therefore ingested with
the real `sender`, never `null`: this bus does not vouch for relays, so a
snapshot aggregating other peers' records would be a forgery vector. `null`
is reserved for replaying our own state locally.

**Roster.** `onParticipants` / `getParticipants` are available if the model
ever wants join/leave edges; the model has no roster of its own, and none is
required.
