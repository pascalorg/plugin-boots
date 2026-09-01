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
  `voice.ts` owns `'boots/voice'` (Part 5) — and is the one kind whose payload
  is not the thing being replicated: the bus carries the *handshake*, the audio
  goes peer-to-peer. None of the three knows anything about the others.

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
| `src/game/hud.ts` | "N builders here" chip + muted join/leave toasts, voice chip. |
| `src/game/voice-policy.ts` | PURE voice rules: the wire type + its validator, the SDP budget trim, who offers (total order), the round-robin signalling target, the room cap, the proximity curve, the talk gate. No WebRTC, no bus, no DOM. |
| `src/game/voice.ts` | THE CALL — one kind (`'boots/voice'`) for signalling, an `RTCPeerConnection` mesh for audio: peer lifecycle, non-trickle offer/answer with epochs + acks, the microphone, the tick that mixes levels, the give-up list, QA counters. |
| `src/game/voice-controls.tsx` | In-game wiring: takes `KeyM` off the one-shot action queue, drives the HUD's voice chip. |

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
| **Every peer answers with THE WHOLE MAP as it knows it** | Once the receiver splits its gate (see *The relay gate*, Part 4): a snapshot is a different speech act from a delta, so it may carry other authors' records and still be admitted for the *view*. N answers for N peers, bounded by the roster, and each answer is useful to the whole room rather than only to the asker. **This is what `shared-world.ts` uses.** |
| Every peer answers with its OWN records only | Whenever the receiver gates *every* record by author — the shape this file described before 2026-09-01. It is sound, and it is why a fort used to vanish with the peer who built it: the author was each record's only courier. |
| One peer answers for the room (`shouldAnswerStateRequest`, pure — lowest live `sessionId`, requester never answers itself) | Only where the transport **vouches** for the relay, i.e. promises that the answerer relayed others' records faithfully. This bus stamps who *sent* a frame and promises nothing more, so a single answerer is still the wrong shape here — what makes aggregate answers safe below is the receiver's own monotonicity, not trust in the sender. |

The two late-join kinds are owned by the **transport**, not by a kind owner,
and are always registered: you ask for state precisely because you have
none, so `requestState` must work before you have subscribed to anything.

## The installed bus is not forever

`startNet()` caches `globalThis.__pascalCollabBus` once. The host builds one bus
per awareness runtime and that runtime's scope key **includes the session id**,
so anything that re-keys the session uninstalls the old bus and installs a new
object. Holding the old one we are bound to a corpse: nothing inbound arrives,
while `publish` still reaches the wire stamped with the *new* id.

`resyncNet()` closes that. It compares the installed bus against `netBus()` by
**object identity** and rebinds if they differ, carrying `published` / `received`
/ `dropped` across so a swap cannot erase the evidence of itself, and counting
the swap in `netCounters().swaps`. A bus that is simply gone (collab off, editor
teardown) leaves the transport stopped and honest rather than bound to a corpse.

Identity is compared by object and **not** by session id, because the id we can
read is the stale bus's own field: it would answer with the old value forever, so
a check against it could never fire. Any subsystem that keys long-lived state on
`localSessionId()` must call `resyncNet()` before trusting it — `net-world.ts`
does this at the top of every publish tick (Part 4).

Who we *used* to be is remembered in the **model**, not here:
`rekeySharedWorld` files the outgoing name into `world.formerSelves` and
`isOurs(world, id)` answers "did this player make this" across every name. The
transport keeps no second ring on purpose — two memories of one fact can
disagree, and the one the Save projection consumes is the one that has to be
true. So ask `localSessionId()` when the question is about the **wire** (who may
author this frame now) and `isOurs()` when it is about the **player**.

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
snapshot 4.7 kB → 6 220 base64 chars, i.e. **79 % of one frame**; a lot four
times as damaged measures 21 520 chars, which is 4 parts with the largest at
7 860. So chunking is load-bearing at sizes this game actually reaches, not a
safety margin. `wireParts(delta, MAX_TEXT_CHARS)` splits per node / per record
group and stamps `{part, parts}`; each part is a complete, independently
mergeable delta, so there is no transport-level reassembly. `payloadFits()`
before publishing, and `'too-large'` if you skip the check.

The budget itself is fenced in `shared-invariant.test.ts`, which reads `net.ts`
as text: `MAX_FRAME_SERIALIZED` 8 000, envelope reserve 120, so
`MAX_TEXT_CHARS` = 8 000 − 120 − 2 = **7 878**, and `MAX_WIRE_PARTS` 1 024
matching `net.ts`'s `parts > 1024` refusal. `shared-wire.ts` may not import
`net.ts`, so the number is derived twice on purpose; `net-world.test.ts` asserts
its own `MAX_WIRE_TEXT` equals `MAX_TEXT_CHARS` so the two cannot drift apart in
silence.

**Coalescing is the real hazard, not loss.** The host keeps only the latest
value per event per 66 ms. A burst of deltas inside one window is *lost*, not
queued — so nothing publishes per-op. The journal accumulates (as maps and sets,
so a burst collapses instead of accumulating) and one batched delta goes out per
66 ms tick through the outbox, with a full snapshot periodically as the healing
channel. `publishFrame` returns the host verdict verbatim — `'deferred'` /
`'suppressed'` mean *that frame is gone*, so the outbox requeues it rather than
trusting the send.

**Late join.** Every peer answers a `requestState('boots/world')` with its
**own** records (see the table above). Snapshots are therefore ingested with
the real `sender`, never `null`: this bus does not vouch for relays, so a
snapshot aggregating other peers' records would be a forgery vector. `null`
is reserved for replaying our own state locally.

**Roster.** `onParticipants` / `getParticipants` are available if the model
ever wants join/leave edges; the model has no roster of its own, and none is
required.

# Part 4 — the adapter (`net-world.ts`)

Part 3 is the contract; this is the code that honours it. `net-world.ts` is the
ONLY arrow from the transport into the model, and the only module that imports
both sides. The two lane bridges each expose an injection point rather than
reaching for a wire, so this is where they get wired.

| | |
|---|---|
| `startWorldSync()` | Creates the session's `SharedWorld` keyed on `localSessionId()`, attaches both lanes, registers both kinds `{ ordered: false }`, starts the publish tick and the heal timer, and calls `requestState('boots/world')`. Returns **false**, having changed nothing, when there is no bus or when the host's session id is not `isSafePeerId` (a peer that could never author a record must not pretend to be in a session). Idempotent. |
| `stopWorldSync()` | `detachBuildSync()` + `setDamageSync(null)` — which also unwires the Save-side ownership gate — plus every subscription and timer. Restores exact single-player behaviour mid-session. Does **not** stop the transport; the avatar layer may still be on it. |
| `worldSyncWorld()` | The session's world, or null. Read-only: the lanes own every mutation. |
| `pumpWorldSync()` | Run one outbound tick now. QA and tests only; the interval is the normal path. |
| `publishWorldSnapshot()` | Queue a heal broadcast (QA / debug HUD). |
| `worldSyncDebug()` | `sent / deferred / lost / oversize / merged / snapshots / throttled / laneSinkIgnored / rekeys / staleMints / staleReminted / unsafeNames / busLost / applyErrors`, plus `active`, `self`, and the outbox's `depth / overflow / superseded / requeued` and the world's `unsent`. |

**Attach order is load-bearing.** The lanes are attached *before* the
subscriptions exist and before `session` is set, because a frame that arrives
first would be dropped rather than buffered: `receiveBuildDelta` with no world
attached deliberately merges nothing. Nothing in `startWorldSync` awaits, so
today this is belt and braces — the point is that adding an `await` later cannot
quietly open that window.

**Inbound is one merge, then two appliers**:

```ts
const fx = mergeDelta(world, delta, msg.sessionId)  // the authorship gate
applyBuildEffects(fx)
applySharedDamage(fx)
```

Never `receiveBuildDelta` — that entry point merges internally AND applies the
build lane, so pairing it with a second `applyBuildEffects` double-coats remote
paint strokes, and it no-ops entirely when the build lane is detached, which
would silently starve the damage lane. Both appliers are self-gated, so the
merge stays unconditional and the lanes turn on and off independently. Each
applier is wrapped in its own try/catch: this runs inside the host's subscribe
callback, which swallows throws, so an exception would otherwise vanish.

**Outbound is the journal, and NOTHING else.** There are two roads from a local
op to the wire and only one is used:

```ts
attachBuildSync(world)                          // no sink
setDamageSync({ world, publish: countOnly })    // required by the type, ignored

// every PUBLISH_TICK_MS (66 ms):
const out = takePending(world)                  // one batched delta, or null
if (out) queueDelta(outbox, out)
const frame = takeWireFrame(outbox)             // ONE frame per tick
if (frame) {
  const kind = frame.kind === 'snapshot' ? WORLD_SNAP_KIND : WORLD_KIND
  if (publishFrame(kind, frame.text, frame) !== 'sent') requeueWireFrame(outbox, frame)
}
```

Every local op journals itself inside `shared-world` (`addLocal*` / `killRecord`
for build, `noteLocal*` for damage), so the journal already holds both lanes'
records. Passing a sink *as well* would put every piece, item, stroke and cell on
the bus **twice** — idempotent, so correct, but double the bytes on a channel
that grants one frame per 66 ms. The damage lane auto-flushes to its sink after
every op, so `laneSinkIgnored` climbs steadily in normal play; that is not an
error, it is the count of frames the journal saved.

The journal is maps and sets rather than a list of ops, which is why a burst
**collapses**: sixty shots into one wall become one node entry carrying the
union of the cells, one frame. Coalescing therefore stops being a hazard — a
burst inside one window is batched, not lost — and the outbox handles the rest:
one frame per tick, refused frames requeued at the **front** (the oldest state is
what a peer is most likely missing), a snapshot superseding queued increments it
already contains, and a hard cap with counters on everything dropped.

Frames are routed by `delta.kind`, so a snapshot never lands on the delta event.
Oversize is no longer a drop: `wireParts` splits a delta at `MAX_WIRE_TEXT` and
each part is an independently mergeable delta, so nothing reassembles them at the
transport level — that is the lattice paying off. `oversize` now counts only a
delta that could not be split even into `MAX_WIRE_PARTS` parts, which the
periodic snapshot then heals.

**Late join answers on `'boots/world-snap'`, not the addressed channel.** A
peer can only ever answer with its own records, and a snapshot of one peer's own
records is equally useful to every peer, so a broadcast beats a unicast reply
and needs no addressing. The request channel is still used, to turn "you will
learn the world within the next heal period" into "you will learn it in a few
hundred milliseconds". Answers are jittered (`SNAP_JITTER_MS`) so N peers do not
publish inside one 66 ms window, and rate-limited (`SNAP_MIN_GAP_MS`) so a
replayed request cannot make a peer shout — this is a public lobby.

**Operational notes, so a healthy system is not misread as a broken one.** A
66 ms tick against a 66 ms window drifts in and out of phase, so `'deferred'`
and a rising `requeued` are *normal*; the frame goes out on the next tick. A
4-part snapshot takes ~264 ms to drain at one part per tick, during which a
joiner has a correct but incomplete world — that is the design, since each part
merges alone. `SNAP_MIN_GAP_MS` (3 s) is comfortably longer than that drain, so
two snapshots cannot overlap. If parts ever need to leave faster, publish them on
**alternating kinds** rather than shrinking the tick: the window is per
(plugin, event), so a smaller tick buys nothing. The pair worth putting on a HUD
is `unsent` + `overflow` — together they are the whole "are we desynced"
question.

**Where it is wired.** `startWorldSync()` sits beside `startPresence()` in
`game-root.tsx`'s co-presence effect; `stopWorldSync()` runs in `exitGame()`
**before** `stopPresence()`, because that call closes the transport as its last
act. There is no goodbye frame for the world: records are grow-only, so leaving
removes our avatar, not our fort. `__boots.worldSync()` is the QA handle.

**The grid stamp was a DEVELOPMENT-ONLY success, and that is why the pieces lane
died in production.** `startWorldSync()` attaches in `game-root.tsx`'s effect,
while the lot's grid fingerprint is published from `builder.tsx`'s grid effect —
a CHILD, whose effect React runs *before* the parent's. So the publish always
lost the race, and the only thing that ever hid it was StrictMode's
double-invoke, which is a dev build. In production `world.gridStamp` stayed 0 for
the whole session, and since the gate reads
`delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp`, both directions
failed at once: our deltas carried 0 and every peer refused them, and every
inbound stamp mismatched our 0 and we refused theirs. Total, silent, bidirectional
refusal of the pieces lane — walls, floors and slopes invisible to everyone,
while grid-free damage kept landing. That is the owner's "others couldn't see my
constructions / only some destructions", word for word, reached by a second road
(the first is `identityHeld`'s re-key).

The fix is to stop treating the frame as an *event*: it is a **retained fact**
about the running game, held in `shared-build.ts` across attach/detach, and
`attachBuildSync` republishes it. Mount order stops mattering in either
direction, and a session whose transport attaches ten seconds late still speaks
the right grid. Two observables guard it: `gridStampPublishes` (0 means the frame
never landed at all) and `net-world.ts`'s **`blindGrid`** — refusals that
happened while *our own* stamp was still 0, which is this bug's exact signature
and must stay 0 for a whole session. `refusedGrid` is only raised when the frame
actually spelled a slot, so a rifle shot from a peer whose ladder has not
installed yet cannot make the notice accuse anyone of standing on a different
lot. And still: *do not surface a grid-mismatch notice while `world.gridStamp` is
0*, because 0 means unknown, not different.

**Our own name is not a constant, so it is checked every tick.** `world.self` is
the prefix on every record id we mint, and a *peer* gates each inbound record
with `isAuthoredBy(rec.id, msg.sessionId)` — the sender read live off the
envelope. So the model quietly depends on our session id never moving, and the
host does not promise that: the collab runtime adopts a restored pending
operation's session id when the outbox lease comes back
(`runtime.sessionId = runtime.pendingOperation.sessionId`), and the awareness
bus scope key includes the session id, so the whole bus is replaced with one
carrying the new name.

Left alone the symptom is **"his holes appear, his walls don't"**, and it reads
as a build-lane bug. Damage cells are unauthored, so they keep landing; every
piece, item, aperture and stroke is refused by every peer. Nothing looks wrong
locally — our prefix stays self-consistent, so `localWork`, `fullyMine()` and the
Save panel all keep telling the truth about us.

`pump()` therefore begins with `identityHeld()`, which `resyncNet()`s (see Part
1: the id alone cannot see this, because the id we can read belongs to the stale
bus) and compares `localSessionId()` against `world.self`. On a change it counts
`rekeys` and **renames the world in place** — `rekeySharedWorld(world, now)` —
then queues a snapshot so peers hear anything they missed promptly rather than at
the next heal. A vanished bus counts `busLost` and stops. A new name that could
never author a record counts `unsafeNames` and stops, for the same reason
`startWorldSync` refuses to begin on one: `rekeySharedWorld` rejects it by
returning `[]`, which is indistinguishable from "nothing was pending", so
carrying on would leave us publishing under a name no peer will ever vouch for.
The recovery is never silent: a silent recovery is nearly as bad as the bug.

**Rename, never restart — the difference is not cosmetic.** The obvious recovery
is to tear the session down, start a fresh one and re-mint the local scene under
the new name. It was implemented that way first and it is wrong on three counts,
all of which the rename avoids:

- It **republishes work every peer already holds**. Pieces would converge, because
  `PieceRec` carries a slot and the election keeps the later claimant; items and
  apertures carry no slot, so nothing elects between the copies and the furniture
  genuinely lands twice, co-located, in every peer that saw both.
- It **throws away what only we hold** — `dmg.mine`, `mySegments`, `killedByMe` —
  so the Save panel silently under-reports the player's own demolition. No
  single-world test can see that, because they all ask while one world is alive.
- It **invalidates the damage lane's wire-boundary identity translation**
  mid-flight: that lane names a placed piece by its record id outbound and
  resolves the name against the live `placed` list inbound, so re-minting under a
  new prefix breaks the bindings for frames already in the air.

Renaming keeps every record, every tombstone, the journal, the lamport clock
**and the grid stamp** — so there is deliberately no separate stamp rescue here;
one invariant, one mechanism. It also files the old name into
`world.formerSelves`, which is what keeps `isOurs(world, id)` — "did this *player*
make this", the question Save asks — true across a rename. `isAuthoredBy` stays
the **wire's** question and stays narrow: one live session vouches for one frame.

**The work a rename leaves stranded, and how much of it comes back.** An add that
was minted but still in the journal when the re-key landed carries the old name:
no peer has it, and no peer will accept it now that our envelope says someone
else. The bound is **"since the last `takePending`"**, which in play is one tick
(≤66 ms of building) because the tick drains the journal unconditionally — but a
harness that installs a lane sink instead of pumping never drains, so there every
record it ever made is pending and `staleMints` counts all of them.

`identityHeld` hands those ids straight to `remintSharedRecords(stale)`, which
re-publishes each one it can through the ordinary **local** path, so the new
records land in the journal and this tick drains them like any other — the adapter
remains the only thing that publishes. Four properties of that call are the
adapter's to keep, and are tested here rather than in the lane:

- **It runs before `queueSnapshot`.** The snapshot a re-key queues has to already
  contain the re-minted records, or a peer waits a whole heal period for work it
  could have had in the same breath.
- **It cannot cost us the snapshot.** Each id re-mints inside its own `try` in the
  lane, and the call site wraps the whole thing again and counts `applyErrors`, so
  a lane that falls over loses its own work and nothing else. Tested by making it
  throw and asserting the rename and the snapshot both still happened.
- **It is asked for exactly the stale ids**, and for nothing when the journal was
  empty.
- **What it skips, it skips on purpose.** An id with no runtime object left is
  gone or already resolved into the document, and re-publishing it would resurrect
  a wall the player deleted or saved. Strokes have no runtime object to re-read at
  all, only the coat ledger they already folded into.

So `staleReminted` is what came back and **`staleMints - staleReminted` is the
honest loss**: strokes, plus anything whose runtime object had already gone. Both
are on `__boots.worldSync()`. `staleMints > 0` with a matching `staleReminted` is
the ordinary reading of a re-key; either climbing repeatedly means re-keys are not
rare and this design needs revisiting.

Two choices inside the re-mint are worth knowing at this seam, because they look
like omissions. It does **not** tombstone the record it replaces: nobody ever saw
that record, and for pieces the election collapses the pair on its own — the
re-mint is canonically later, so it wins, and nothing is bound to the loser, so
`installPieces` uninstalls nothing and no false "Another builder claimed that wall
slot" fires. And the rebind is deliberately not unbind-then-bind: `unbindPiece`
drops the published fingerprint, so reconcile would read the piece as a *moved*
wall, tombstone the record just minted and mint a third.

**What makes that accounting trustworthy is an invariant, not luck.** Read on its
own, `remintSharedRecords` looks able to swallow work the adapter already counted:
it reads the build lane's own `sync` and returns `[]` when the lane is detached, so
a re-key taken before the piece tree mounts would report `staleMints` with nothing
recovered and no way to tell that apart from a genuine loss. It cannot happen, for
two reasons that are both worth re-checking before either is changed:

- `rekeySharedWorld` scans exactly the four record lanes (`LANES`), and
  `shared-build.ts` is the **only** production caller of `addLocalPiece` /
  `addLocalItem` / `addLocalAperture` / `addLocalStroke` — the one hit elsewhere,
  in `paint.tsx`, is a comment. The ids the accounting names and the ids the
  re-mint can act on therefore come from a single module, so a detached lane means
  those journals are necessarily empty and both numbers are zero in the same
  breath. **Mint into a record lane from outside that module and this stops
  holding**: `staleMints` would count work the lane has never heard of, and the
  loss figure would blame the re-mint for records it could never have seen. A
  source scan in `net-world.test.ts` fences it over all of `src`, and it matches
  `addLocal<Anything>` rather than those four names on purpose — **a fifth lane is
  the case a list of four literals sails straight through**, and it is the case
  most likely to be added. The model itself stays allowed, because the hazard is a
  minting path whose *lifecycle* is not the build lane's; the model has none, it
  mints only when called, so a private helper shared by the four minters is a
  refactor rather than a new site.
- `attachBuildSync` / `detachBuildSync` are called from `startWorldSync` /
  `stopWorldSync` and nowhere else in production, so for as long as `pump` runs the
  lane is attached — and attached to the *same world object* the adapter just
  renamed. That is one more thing rename-in-place buys quietly: a
  teardown-and-re-mint recovery would have left `sync.world` pointing at a world we
  had already discarded, and the re-mint would have read the dead one.

**The other door into a journal, and the precondition it no longer carries.**
`restorePending` re-journals record adds without going near `addLocal*`, so the
mint fence structurally cannot see it. It had no production caller, and a second
source fence kept that true — because the day a send-failure retry path wanted one,
this lane's numbers acquired an unstated rule: *hand `restorePending` only the exact
delta `takePending` returned.* `restoreLane` validated id *shape* only, never
authorship. Give it a *received* frame instead — exactly what a natural "apply
failed, put it back, retry" path does — and a stranger's records enter our journal.
The world survives that: peers refuse them, because `isAuthoredBy` compares the
record prefix against the envelope sender and our envelope says us. The *numbers* do
not. `rekeySharedWorld` returns every pending add id regardless of prefix, so
`staleMints` counts the stranger's work while the re-mint correctly recovers none of
it, and the loss figure above quietly stops meaning what it says.

**That refusal is now in the model, and the fence is gone (2026-08-31).**
`restoreLane` takes the world and drops any record that is not ours, so the
precondition is *unnecessary* rather than merely documented, and the retry path is
safe to write against whatever frame is in hand. The source scan
(`nothing outside the model puts records back into a journal`) was **deleted**
rather than kept as a belt: a fence that forbids all callers of a now-safe function
only blocks the path it was warning about. Its replacement is behavioural and lives
with the model, in `shared-world.test.ts`: `a restored frame keeps our records and
refuses another peer's`, `a re-key does not make our own pending work a stranger to
us` (trap 1), and `a tombstone goes back even though it kills someone else's piece`
(trap 2); traps 3 and 4 were already fenced by the epoch test beside them and by
`isOurs`'s own. The four decisions the change turned on, the third being the trap:

- **`isOurs(world, rec.id)`, not `isAuthoredBy(rec.id, world.self)`.** The narrow
  form refuses our own *pre-rename* adds, which drops work on the one path whose
  purpose is not to drop work — inside precisely the window `remintSharedRecords`
  exists to cover, so the two would fight over the same records. `isOurs` spans
  `formerSelves`, which is the whole reason the rename files the old name at all.
- **`restoreDead` must NOT get the check.** Tombstones carry the *victim's* prefix,
  not ours: our legitimate kill of a stranger's piece is a dead-lane id that
  `isOurs` refuses. And a tombstone is the only thing keeping a demolished wall
  demolished, so dropping it means a peer who missed the original frame watches the
  wall come back. **A resurrection bug is strictly worse than the corrupted counter
  this was fixing** — trading a wrong number for a wrong world.
- **The node/cell loop needs nothing.** Voxel damage is keyed by `nodeId` + cell and
  carries no record id, so there is no authorship to check; its epoch guard is
  already the right refusal and applies whoever sends it.
- **`MAX_FORMER_SELVES = 8` is the fail-safe bound, and it is a bound on the
  *check*, not just on memory.** A record minted more than eight renames ago can no
  longer be vouched for, so it would be refused — correct behaviour (bounded
  vouching beats unbounded trust), and the reason the refusal must never be
  described as "vouch forever".

`world.unsent` still counts a restore whatever the frame held, because it counts
*frames that did not go out*, which is the question the counter answers.

**Two residues, both deliberate.** Our snapshots still carry old-prefixed records
that peers refuse — wasted bytes and an inflated `dropped` on their side —
because "two peers answering one request produce byte-identical snapshots" is a
property of the format worth more than the saving. And a persisted per-browser
client id, the obvious "stable identity" fix, was **rejected on purpose**:
authorship here is a *capability*, not a label. A record is admitted only when
its prefix matches the sender the host's envelope named, and a self-asserted id
would let a hostile peer mint `<our-id>#<n>` and walk its wall into our own
`localWork` and from there into a scene write on the owner's disk. Binding a
persisted id to a session on first sight does not close it either, because two
tabs of one browser legitimately share the id, so a squatter is indistinguishable
from a second tab — and the window to squat is the re-key itself. A reload
therefore makes us a **new author** on purpose; `shared-invariant.test.ts` fences
the shared trio against `localStorage` / `sessionStorage` / `indexedDB` so the
rejected design cannot arrive quietly.

**This used to be a known limitation, and it was the owner's headline bug.**
"MASSIVE problem that others couldnt see my constructions… We should always all
see the state of the map as it is currently" (2026-09-01). A peer who joined
after our re-key never learned our pre-re-key records, because no live session
could vouch for them; the same hole made a fort vanish with the peer who built
it. Both are one cause: under a per-frame authorship gate, a record's ONLY
courier is its author.

**The gate is now SPLIT rather than relaxed** — the design this section used to
defer. A **delta** stays strictly authored: an increment is a claim about what
the sender just did, and nobody may put words in another peer's mouth. A
**snapshot** is a different speech act — "here is the whole world as I know it"
— which is exactly the aggregate a joiner needs, and `snapshotOf` always emitted
every peer's records anyway; the receiver simply threw the rest away. Accepting
them makes every peer a replica of the map, so the map outlives its builders.
See `mergeDelta`'s *relay gate* comment in `shared-world.ts` for the full
argument, and `net-world.ts`'s `relayed` counter for the observable.

**Why that is not a hole.** Every power it grants a hostile peer is one that peer
already had: it could always make a wall appear under its own name, and it could
always *delete* a stranger's wall, since tombstones are unauthored by design ("a
piece can always be destroyed") — editing is strictly less destructive than the
delete it already had. What it still cannot do: **resurrect** a destroyed record
(`dead` is monotone and checked on every merge), or **claim a stranger's work in
the document** — the Save projection reads authorship from the record id's own
prefix against `self`/`formerSelves`, never from who sent the frame, so a relayed
record is foreign to Save whichever road it arrived on. The authorship gate's
real job was always the Save boundary; it is still there in full, and it has
stopped censoring the view.

**What is still not handled, stated rather than hidden.** A frame lost to the
outbox cap (`overflow`) or to a host `'suppressed'` is never retransmitted on a
timer — it heals when the next snapshot goes out, up to `HEAL_PERIOD_MS` later.
That is the design, not an oversight: a lattice has nothing to retransmit *from*
once the journal has been taken. The cost is a bounded window in which one peer's
view of another can be stale; the fix, if it ever matters, is a shorter heal
period or a peer asking again, not a reliability layer.

**No build identity on the wire.** The envelope carries `v: 1`, a *protocol*
version, but nothing identifies the codec build. Two clients running different
`shared-wire.ts` revisions would decode each other's frames into the wrong cells
and neither would notice. Today the only way that happens is a stale hot-deploy
copy, which is a discipline problem rather than a design one; if flag-on testing
ever spans two machines, fold a codec fingerprint in beside `gridStamp` rather
than trusting that everyone copied the same files. Logged as a deliberate
deferral, not a surprise.

**Hot-deploy discipline (how this file breaks the host bundle).** Testing
flag-on means `cp`-ing changed files per-file into **both** host copies of the
package (`editor/apps/editor/node_modules/@pascal-app/plugin-boots/...` and
`apps/community/node_modules/@pascal-app/plugin-boots/...`); never rsync
directories. Two traps: a **new** file needs its own `cp` — nothing else will
carry it — and so does **every file that imports it**, or the host bundle fails
to resolve a module that exists in the repo and the editor route returns 500.
This bit once already: `net-world.ts` importing a never-deployed
`shared-build.ts` was harmless while nothing called `startWorldSync()`, and became
a hard 500 the moment `game-root.tsx` wired it up. If `localhost:3002` starts
answering 500 with "Can't resolve './shared-…'", the repo is fine and the copies
are stale.

# Part 5 — the call (`voice.ts`, `voice-policy.ts`)

The owner's ask was to talk to each other the way people on a call do, or
teammates in a squad game. Parts 1–4 replicate *what people do*; this part replicates *what they
say*, and it is the only layer in the plugin whose payload does not travel on the
host bus at all.

**The bus carries the handshake. The audio goes peer-to-peer.** Every frame in
Parts 1–4 IS the thing being replicated — a pose, a delta, a snapshot. A voice
frame is a *description of how to open a connection somewhere else*: two browsers
exchange SDP over the collab bus, and from then on the sound travels directly
between them over WebRTC. Nothing in this part ever puts audio on the bus.

That is not a preference. The host coalesces to the latest payload per
`(pluginId, event)` inside its window and caps a frame at 8000 serialized bytes,
so a channel that keeps only the newest thing it was handed cannot carry a
*stream*, where every packet matters and none supersedes another. What such a
channel is very good at is carrying **one small, current, idempotent fact** —
which is exactly what an offer, an answer and an ack can be made into, and the
whole design of this part follows from making them that.

| | |
|---|---|
| `voice-policy.ts` | Pure rules, no WebRTC / bus / DOM: `readVoiceFrame` (wire validation), `sdpIsAudioOnly`, `trimSdpToBudget`, `voiceOffererIsUs`, `nextSignalTarget`, `voiceRoom` / `voicePeersFor`, `proximityGain` / `mixGain`, `talkGate`, and every constant below. Unit-testable to the last branch, which is why the negotiation rules live here rather than beside the connection they drive. |
| `voice.ts` | The mesh: `startVoice` / `stopVoice`, `makeLink` / `closeLink` / `restart`, `makeOffer` / `makeAnswer` / `publishSignal` / `ingest`, `enableMic` / `toggleMic` / `setMicMuted`, `voiceTick`, `setVoiceMode` (persisted), `isPeerTalking`, `voiceDebug`. Owns all state; the only module here that touches `RTCPeerConnection`. |
| `voice-controls.tsx` | `<VoiceControls/>`: takes `'KeyM'` off `session.input.state.actions` at priority −1 and drives the HUD chip. No state of its own. |
| `game-root.tsx` | Starts/stops with the session, feeds `getLocalPosition`, exposes `__boots.voice()` and `__boots.voiceMode()`. |
| `session.ts` | `exitGame` → `stopVoice()`, so leaving the game releases the microphone. |
| `remote-players.tsx` | The speaking dot over a talking peer's name tag. |
| `panel.tsx`, `touch.ts` | The sidebar mode picker (Squad / Nearby) and the phone's MIC button. |

## The frame

```jsonc
{
  "v": 1,                     // VOICE_PROTOCOL
  "mode": "squad",            // informational: what MY mixer is doing
  "talking": true,            // the talk gate, for the dot and the HUD count
  "to": "session_b",          // whose description this frame carries (optional)
  "sdp": {                    // at most ONE peer's description per frame
    "type": "offer",          // 'offer' | 'answer'
    "epoch": 3,               // monotonic per link; an answer echoes the offer's
    "sdp": "v=0\r\no=- …"     // trimmed to MAX_SDP_CHARS, audio-only
  },
  "ack": { "session_b": 3 }   // newest epoch I have APPLIED from each peer
}
```

Everything except `sdp`/`to` is **cumulative state**, not an event: a frame is a
complete statement of where this peer is in every negotiation it has, so the
newest frame always supersedes the older one *correctly*. That is what makes the
host's latest-value coalescing harmless here instead of fatal.

## Non-trickle ICE, on purpose

Ordinary WebRTC trickles candidates: a description first, then a stream of small
candidate messages, all of which must arrive. On a channel that keeps only the
latest payload per event, most of that stream is dropped and the call never
connects — with no error anywhere, because nothing failed; a message simply
stopped existing.

So Boots gathers first and sends once. `makeOffer` / `makeAnswer` create the
description, `await gathered(pc)` waits for ICE gathering to finish (end-of-
candidates event, gathering-state change, or `ICE_GATHER_MS`, whichever comes
first — engines disagree about which of the first two they emit), and the
description that goes out already contains the candidates. One frame per
description, no ordering requirement, nothing to lose.

**And it is re-sent until acknowledged.** `link.outbound` holds the description
we owe a peer; `publishSignal` runs every `SIGNAL_EVERY_TICKS` ticks and puts one
owed description on the wire, round-robin across the peers that are owed one
(`nextSignalTarget`, which is why one slow peer cannot starve the rest). It stops
when their `ack[me]` names our epoch — or, for an offer, when their answer
arrives, because *applying* the answer is itself proof they had the offer.

**A description is only counted as sent when the host says `'sent'`.**
`'deferred'` and `'suppressed'` mean the frame is gone, and counting those as
sent would turn `offersSent` into a lie and hide the exact condition this whole
scheme exists to survive. They increment `notSent` instead — **expected to be
non-zero, and not a failure.**

## Who offers, and what happens when both do

`voiceOffererIsUs(me, peer)` is a total order on session ids: the lower id
offers, the higher one waits and builds its link when the offer lands. No round
trip, no leader election, and both sides reach the same answer from data they
already have.

Glare — both ends holding a local offer — is still reachable (a link rebuilt
while their offer was in flight, or a peer on a different build). It is resolved
by **the same total order**, so again both sides agree with no negotiation: the
side the order says owns the pair keeps its offer and drops theirs (`dropped++`);
the other rolls its own offer back (`setLocalDescription({type:'rollback'})`) and
answers. Deciding it any other way — newest wins, first wins — leaves two
half-open connections and silence.

A peer that offers when the order says it should not is **answered anyway**. The
order exists to avoid glare, not to police it, and refusing would turn a
version-mismatched peer into permanent silence.

## Epochs

`epoch` is per-link and monotonic, and an **answer carries the offer's epoch**.
That single choice is what makes late signalling harmless rather than confusing:
an answer to a superseded offer, or an offer we have already answered, is
*recognisable* and counted (`dropped`) instead of being applied against the wrong
negotiation and failing the pair for the rest of the session.

**The epoch belongs to the PAIR, not to the `RTCPeerConnection`.** A restart
rebuilds the connection and carries the number forward; resetting it to 0 was a
deadlock with no error anywhere in it. Walk it: we offered epoch 1, they answered
and recorded `applied = 1`, we restarted for any reason and offered epoch 1
again. They see `epoch <= applied` and drop it as one they have already answered.
Meanwhile their old answer — still being re-sent, because we never acked it —
matches our new offer's epoch *exactly*, so a description built for a dead
connection goes into a live one, `setRemoteDescription` rejects it, and we
restart. Which produces epoch 1 again. Four rounds of that and the pair is on the
`unreachable` list, having been reachable the whole time.

## Bounds

| Constant | Value | Why |
| --- | --- | --- |
| `MAX_VOICE_PEERS` | 6 | Mesh cost grows with the square of the room; six is where a phone still copes. |
| `MAX_SDP_CHARS` | 6200 | Under the host's 8000-byte frame budget with the envelope and the ack map beside it. |
| `MAX_ICE_CANDIDATES` | 24 | A validation bound on what a peer may hand us, not a target. |
| `MAX_ACK_ENTRIES` | `MAX_VOICE_PEERS + 2` | The ack map is bounded by the room, plus slack for a peer mid-swap. |
| `MAX_SESSION_ID_CHARS` | 128 | A `to`/`ack` key is an id, not a place to put a paragraph. |

`trimSdpToBudget` drops **candidate lines** — keeping at least one of each type
it can — rather than truncating the string, because half an SDP is not an SDP;
if it cannot fit, the description is abandoned and `tooLarge` counted. Every
inbound frame goes through `readVoiceFrame`, and `sdpIsAudioOnly` refuses any
description carrying a video or data m-line: a peer cannot negotiate a camera or
a side channel into a voice call.

**The cap is on the ROOM, not per peer.** `voiceRoom(roster)` picks the same
deterministic subset for everybody, and `voicePeersFor` derives one member's list
from it. A per-peer cap would let A be in a call with B while B's own list is
full — one-way audio, and a bug report nobody can reproduce.

## The mesh, tick by tick

`voiceTick(now)` runs every `VOICE_TICK_MS` and is the only thing that moves:

1. **Roster.** Peers are the presence remotes whose phase is `'game'` (an
   editor-only viewer is not in the call), minus the give-up list, capped by the
   room. Links to peers who arrived are opened, and the lower id offers. An
   `'idle'` link on our side of the order with nothing owed re-offers — that is
   the repair path for an offer whose publish was coalesced away before it was
   ever counted.
2. **Our own talk state**, from the local mic analyser through `talkGate`.
3. **Levels**, `mixGain(mode, distance)` per peer, written only on change — so a
   squad call touches nothing at all, and a refused autoplay heals here because
   by now the player has clicked something.
4. **One signalling frame**: every tick while any description is owed, otherwise
   every `SIGNAL_EVERY_TICKS` as a heartbeat, carrying at most one description.
   The heartbeat rate is right for what a heartbeat carries — a talk flag and an
   ack map — and wrong for a handshake, where it is pure added latency on every
   hop, twice per round trip, on top of ICE gathering.

### A peer missing from the roster has not left

**A link is only torn down once its peer has been absent for `PEER_ABSENT_MS`
(4 s), and `counters.reaped` counts it.** Presence is a lossy stream over a
coalescing bus, so a remote can drop out of the roster for a few ticks because a
publish lost its window or a tab was throttled mid-stride. Reaping on the first
tick that fails to mention them destroys the `RTCPeerConnection`, the gathered
candidates, the epoch and the applied watermark — so the pair restarts from zero
on **both** sides and never gets the few seconds a handshake needs.

This is worth stating plainly because of how it presented: two browsers on one
machine, each reporting a healthy session, each seeing the other in presence,
neither hearing anything, offers and answers flowing steadily on the wire. Every
voice readout said "unreachable peer"; the actual fault was one layer down and
the opposite kind of problem. `reaped` climbing during a call where nobody left
is now the tell, and `voiceDebug().peers[].absentMs` says which link is inside
its grace period rather than idle.

A description owed to an absent peer **keeps being re-sent** — their absence may
be the very loss that ate it.

Recovery is bounded: a negotiation still unconnected after
`NEGOTIATION_TIMEOUT_MS` is restarted — **doubled while ICE is `checking`,
`connected` or `completed`**, because a link with a live path to the other
machine is waiting on one more description and tearing it down at the same
deadline as one that never heard anything throws away the expensive half of the
handshake, at precisely the moment the answer is in flight (both sides started
their clocks together). A link that ended in a caught exception (`state` is
`'failed'`, `step` ends in `:threw`) is restarted too; until that branch existed
one rejected `createAnswer` meant that pair was silent for the rest of the
session with a full attempt budget unspent. After `MAX_NEGOTIATION_ATTEMPTS`
restarts the peer goes on the `unreachable` set and `given_up` is incremented —
**given up on deliberately and countably**, because with STUN only some pairs
genuinely cannot reach each other, and retrying forever would burn a connection
attempt every fifteen seconds for the rest of the session and still be silent.

`ICE servers` are public STUN, with `setVoiceIceServers` as the seam for a relay
when there is one. There is no TURN today; the honest consequence is in the "not
handled" list below.

### The answerer has to send, not only receive

**Before `createAnswer`, the answerer adopts the transceiver the offer created and
points it at `sendrecv`.** Without that step a call connects and exactly one
person can be heard.

WebRTC recycles an existing transceiver for an incoming m-line only when that
transceiver came from `addTrack`; one created with `addTransceiver` is understood
as a request for an m-line **of our own**. So the answerer ended up holding two:
the one it made up front, associated with no m-line and unable to ever acquire one
because an answer cannot add m-lines, and the one the offer implicitly created —
which the spec defines as **`recvonly`**. Its answer said "I only receive", which
was accurate. `voiceInternals()` on the two tabs, side by side:

```
A  transceiver mid=0     direction=sendrecv  current=sendonly
B  transceiver mid=null  direction=sendrecv  current=null
B  transceiver mid=0     direction=recvonly  current=recvonly
```

The offerer settled at `sendonly` and its receiver track stayed muted for the rest
of the session — with a live sender, a connected pair and a green readout on both
ends. Nothing threw and no counter moved, which is why this needed a per-direction
dump to find at all.

`adoptAssociatedTransceiver` also moves `link.sender` onto the associated
transceiver, because a mic swapped into the orphan's sender is a track attached to
no m-line: nobody is sent it, and every readout still says the mic is live. The
orphan is stopped so it cannot demand an m-line in a later negotiation. The
offerer's own transceiver is untouched — that side was never broken, and the fake
`RTCPeerConnection` in the tests models the implicit `recvonly` transceiver so
none of this can regress quietly.

### One negotiation at a time, per pair

**`link.busy` claims an epoch synchronously, before the first `await`, and is
released in a `finally`.** Signalling here is a resend loop and every stage of a
handshake is an `await`: the offerer republishes the same description every tick
until it is acknowledged, and it cannot be acknowledged until the answerer has
finished `createAnswer`, `setLocalDescription` and the whole ICE gather — up to
`ICE_GATHER_MS` later. `applied` is written at the **end** of that sequence, so it
could not stop the answerer starting a fresh negotiation for every copy that
arrived in the meantime. A two-browser run showed **4 offers applied and 7 answers
sent for one offer at epoch 1**.

Nothing about that looked broken, which is why it survived: both ends reported a
connected pair, and the local answer that happened to survive the interleaving
belonged to no offer the other side was still holding. **Media in one direction
only, with every readout green.**

The same hazard runs the other way. `outbound` is cleared when the answer
*finishes* applying, so a duplicate answer arriving first called
`setRemoteDescription` twice; the second rejects, and the rejection path
**restarts the pair** — the reward for the peer's patience was being hung up on.
Both directions are pinned by tests that fail without the guard.

### Liveness for a call comes from the call

**A voice frame from a peer is proof they are there**, and `ingest` refreshes
their absence clock on the strength of it alone. The two layers are driven by
different things: presence rides the render loop, voice rides an interval. So a
window sitting behind another one stops publishing poses entirely — a two-tab QA
run measured ~5.7 s of pose silence, well past the 3 s staleness sweep — while
its voice frames keep arriving the whole time. Building liveness for the call out
of the roster meant alt-tabbing hung up on somebody who was still talking. Both
channels have to go quiet before a link is torn down.

### A tick that arrives late is our own fault

Every deadline here reads `now - somethingAt > limit`, and each one assumes the
interval measuring it has been running. A backgrounded tab breaks that outright:
Chromium can suspend the page, so the tick that lands on resume carries thirty
seconds of clock nobody watched. Taken literally that single tick says every peer
went silent, every handshake timed out and everybody stopped talking — all at
once, all false.

So a gap longer than `TICK_STALL_MS` (1 s — longer than any interval could
produce) is **credited back** to every deadline each link owns: `seenAt`,
`startedAt`, `talkingAt`, `droppedAt`, and the local over-open clock. Time the
page was awake for still counts, which is the point — the credit forgives the
freeze, not the peer. `counters.stalls` says how often it happened, and a room
that empties itself the instant you come back to the tab is what it looks like
when this is missing.

### A dropped connection is not a dead one

`'disconnected'` is a **grace period**, not a verdict: ICE frequently recovers on
its own, so a link that reports it is left alone for `DISCONNECT_GRACE_MS` (5 s)
and only then rebuilt, with `droppedAt` cleared the moment it comes back. Without
that branch a link that fell over once read `state: 'connected'` beside a
`connectionState` of `'disconnected'` forever, with no counter moving anywhere.
And reaching `'connected'` **refunds the attempt budget** (`attempts = 0`): the
budget exists for "this pair cannot reach each other at all", and spending it on
recoveries wrote off pairs that kept proving they worked — permanently, since the
give-up list lasts the session.

The repair pass runs over **every** link, not only the ones the roster currently
mentions, because the links that most need repairing are exactly the ones whose
peer has flickered out of it.

## The microphone

One `sendrecv` audio transceiver is created **before any description exists**, so
enabling the mic later is `sender.replaceTrack(track)` with **no renegotiation** —
the alternative is a second handshake in the middle of a firefight. Two things
follow: you can hear the room with your mic off, and the handshake is expected to
complete while every mic in the session is off.

`MicState` is `off | live | muted | denied | unavailable`. `M` (or the phone's
MIC button) acquires on first press and mutes/unmutes after that; muting disables
the track and keeps the device, so the call survives. `getUserMedia` asks for
`echoCancellation`, `noiseSuppression` and `autoGainControl` — the three that
decide whether a game call is usable at all, since without cancellation everyone
hears themselves through everyone else. `enableMicIfAlreadyPermitted` turns the
mic on at session start **only** when permission was already granted, because a
permission dialog appearing mid-firefight is worse than no voice at all. And
`stopVoice` stops the tracks: leaving the game must turn the browser's recording
indicator off, or the next thing the player does is check whether we are still
listening.

## The talk gate, and who is talking

The gate is RMS with hysteresis and hang time: it opens at `VAD_OPEN_RMS`, holds
while the level stays above `VAD_CLOSE_RMS`, and closes `VAD_HANG_MS` after the
level was last loud enough to open — so a breath between words does not flicker
the dot. The analyser is WebAudio on the **local** mic only.

The resulting boolean rides on our own frames, and each peer's copy is stamped
with the tick clock when it arrives. `isPeerTalking` treats a flag older than
`TALKING_STALE_MS` as quiet, so a peer whose frames stop arriving goes silent on
the HUD instead of talking forever. `remote-players.tsx` reads it per avatar
(with wall time passed in explicitly, since the module's clock only advances
while the tick runs) and shows a dot over the name tag. **Which mouth a voice
belongs to is the one thing a call in a game needs and a call on a phone does
not.**

## Output goes through an audio element, never WebAudio

Each peer's stream is attached to a floating `HTMLAudioElement` — created with
`new Audio()` and deliberately never in the DOM, so the host page cannot style,
click or scroll it away — and its level is set with `element.volume`.

**A remote `MediaStream` routed through a `MediaStreamAudioSourceNode` is silent
on iOS Safari.** That is the whole reason the mixer is an element property and
not a gain node, and it is a trade with a visible cost: iOS makes `volume`
read-only, so **proximity is flat on iPhone** — you hear everyone at full level.
Squad, which is what most people want, is unaffected. The sidebar says so in
words ("Flat on iPhone") rather than leaving a phone user to wonder why walking
away changes nothing.

## Two mixes

| Mode | Behaviour |
| --- | --- |
| `squad` (default) | Everyone at full level, wherever they are. A party call. |
| `proximity` | Full within `VOICE_NEAR_M`, fading to nothing at `VOICE_FAR_M` on a `VOICE_ROLLOFF` curve. Walk over to talk. |

Distance is measured against the peer's latest presence snapshot — the voice
layer reads the avatar layer's ring and never samples the wire itself. Changing
mode sets every `link.gain` to `-1`, which forces the next tick to rewrite every
level. The choice is persisted per browser under `boots.voice.mode.1` (a
*preference*, not session state: somebody who picked proximity because they are
building at opposite ends of a house did not pick it for one page load), and an
unrecognised stored value falls back to the default rather than being trusted
into the state.

## QA surface

`__boots.voice()` dumps, per peer, the real `RTCPeerConnection` state
(`state / connection / ice`), what description is still owed (`owed`), the mixed
`gain`, whether a remote track has actually arrived (`hasTrack`), `attempts` and
their `talking` flag — plus `mode`, `mic`, `unreachable` and the counters:

`offersSent`, `answersSent`, `offersApplied`, `answersApplied`, `dropped`,
`tooLarge`, `restarts`, `given_up`, `notSent`, `reaped`, `stalls`.

Every one of those is a **silent** failure otherwise. `__boots.voiceMode(mode)`
exists because the picker is in the editor sidebar and a QA run is inside the
game, so without that seam the proximity mix is the one half of voice no harness
can reach.

`__boots.voiceInternals()` goes one level below all of it: per link, the
`signaling`/`connection`/`ice` states, every transceiver's `direction` vs
`currentDirection`, each receiver's track (`muted`, `readyState`), each sender's
(`hasTrack`, `enabled`), and whether the audio element actually holds a stream and
is playing. `voice()` answers "did the handshake finish"; this answers the
question that comes next and cannot be seen from there, because **media is
negotiated per direction**: a completed handshake where one side hears nothing is
a `currentDirection` of `recvonly` on one end, or a sender that never got the
track, and both of those look perfect in every other readout.

### Two-browser voice checklist (`docs/qa/qa-boots-voice.mjs`)

Two tabs, two live sessions, the host-faithful lossy bus shim
(`qa-collab-bus.mjs`) for signalling, and Chromium's fake capture device standing
in for a microphone. What it asserts is the pair of facts that make a call a
call:

1. each side's connection to the other reaches `'connected'` — **with both mics
   still off**, which is also the proof that the up-front transceiver works;
2. each side actually **holds** the other's audio (`hasTrack`); a `'connected'`
   link with no track is the failure mode that looks perfect in every other
   readout.

Then: a real `keyboard.press('m')` on both (so `input.ts` → `takeAction` →
`VoiceControls` is exercised, not just the module's entry point), a mode switch
to `proximity` and back, and the counters. The verdict is
`meshOk && audioOk && signalled && gaveUp === 0`; `notSent` is printed as an
expected non-zero. The talk gate is **reported, not asserted** — the fake device
is a periodic beep, so whether it opens inside any given window is luck, and the
gate itself is pinned by unit tests that feed it known levels.

**Run it from the QA directory** (`docs/qa`); `qa-playwright.mjs` finds the
browser automation package in the sibling host checkout, because plugin-boots
does not depend on one and no working directory can change that — bare-specifier
resolution walks up from the importing file, never from cwd.

**And hot-deploy BOTH host copies first.** `:3002` is served by
`editor/apps/editor`, so a run against a plugin copied only into
`apps/community/node_modules` tests a build with no voice module in it at all —
which reads, in every single readout, exactly like voice being broken. This bit
once: `__boots.voice()` came back `undefined` on both tabs while the repo was
perfectly fine. Sync both, restart the dev server (node_modules is not watched),
then run.

## What is not handled, stated rather than hidden

- **No TURN.** Two symmetric NATs will not reach each other with STUN alone.
  Those pairs are *counted* (`given_up`) rather than retried forever, and the
  seam to point at a relay is one function call — but until there is one, a
  minority of pairs will be unable to hear each other while everyone else in the
  same room can.
- **Proximity is flat on iPhone**, for the reason above. Squad is not.
- **Nothing measures whether a remote peer is actually audible.** The output is
  an element, so there is no analyser on it; "is he talking" is his own flag,
  relayed. A peer whose mic is captured but muted at the OS level looks talkative
  and is silent.
- **A mesh, not a mixer.** Every peer sends its audio to every other peer, which
  is why the room is capped at six. A server-side mix would lift that ceiling and
  is a different piece of infrastructure entirely.
- **No build identity on the wire** (the same gap as Part 3): `v` versions the
  protocol, nothing versions the codec. Two clients on different revisions can
  disagree about a field and neither will know.
- **Signalling is only as live as the tick.** A frame lost to coalescing costs up
  to four ticks before the next attempt; the resend loop is what makes that a
  delay instead of a failure, and `notSent` is what makes it visible.

## Part 5 — The link itself

A link that joins two people has to clear three conditions, and every one of them
lives outside this plugin. Worth writing down together, because for a full night
the plugin was blameless and the link still did nothing.

1. **The plugin code is on the host.** It ships as a git pin in the host's
   `apps/community/package.json`. A commit on `main` here is not deployed.
2. **The project carries the open-lobby marker.** A reviewed host-side entry
   (`open-lobby-policy.ts`). Not something visibility implies, and not something
   this plugin can grant.
3. **The project is public.** The marker alone never exposes a private project;
   the two conditions are independent and both required for a stranger.

Miss 1 and the visitor gets a canvas with no game. Miss 2 or 3 and `/play/<id>`
answers `notFound()` — deliberately the same answer for "no such project", "not a
lobby" and "private", so a link cannot be used to probe which projects exist.

### Telling from outside whether a link can work

The refusal being indistinguishable is right, and it also means you cannot check
your own lobby by fetching it: an anonymous `GET /play/<id>` returns the sign-in
gate for **every** id, including ids that do not exist. `sign-in` is decided
before the project is even loaded. A sign-in page is not evidence of a lobby.

Condition 3 is readable from outside, though, and this is the probe to use —
`/editor/<id>`, unauthenticated:

- **public** → the page carries a `NEXT_REDIRECT` to `/viewer/<id>`
- **private, or no such project** → the "you don't have access, ask the owner"
  page, with no redirect

Both are HTTP 200, so the status code tells you nothing; the body does. (This is
also what the owner's friend hit when he was sent `/editor/<id>` instead of
`/play/<id>` and reported "nothing happened" — for a public project that lands on
the read-only viewer, which has no plugin rail and no game.)

Condition 2 is not observable from outside by design. Read the allowlist.

### The sentence under the button has to distinguish 2 from 3

Because the owner cannot see any of this, the sidebar is the only thing that can
tell him — and it used to promise "anyone with the link signs in and drops
straight into your game" for any *public* project, which is condition 3 alone.
Bridge v2 gives the plugin `isOpenLobby` so `shareReach` can say which of the two
is missing, and `unknown` (a v1 host) promises nothing rather than guessing.
`docs/qa/qa-boots-share.mjs` drives that panel in a real browser against a real
bridge and reads the sentence back off the DOM.
