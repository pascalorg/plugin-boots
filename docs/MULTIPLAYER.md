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

**One known interaction with the grid stamp.** `startWorldSync()` attaches in
`game-root.tsx`'s effect, but the lot's grid fingerprint is published later, from
`builder.tsx`'s grid effect when the piece tree mounts. Until then
`world.gridStamp` is 0, and the merge gate refuses any frame whose stamp is
non-zero — which is correct (we do not yet know our own lot) but reads to the
player as "a builder is on a different lot grid". Records are grow-only so a
later frame lands and nothing is lost; the honest fix belongs to the notice, not
the transport: *do not surface a grid-mismatch notice while `world.gridStamp` is
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

**The other door into a journal, and the precondition it will arrive with.**
`restorePending` re-journals record adds without going near `addLocal*`, so the
mint fence structurally cannot see it. It has no production caller today, and a
second fence keeps that true — because the day a send-failure retry path wants
one, this lane's numbers acquire an unstated rule: **hand `restorePending` only
the exact delta `takePending` returned.** Its `restoreLane` validates id *shape*,
never authorship. Give it a *received* frame instead — exactly what a natural
"apply failed, put it back, retry" path does — and a stranger's records enter our
journal. The world survives that: peers refuse them, because `isAuthoredBy`
compares the record prefix against the envelope sender and our envelope says us.
The *numbers* do not. `rekeySharedWorld` returns every pending add id regardless
of prefix, so `staleMints` counts the stranger's work while the re-mint correctly
recovers none of it, and the loss figure above quietly stops meaning what it says.

**An owed change, deliberately not made here:** the real fix is an authorship check
inside `restoreLane` — refuse a record this world could not have minted — and that
is in `shared-world.ts`, the frozen contract. A wiring lane fencing its own
precondition is the honest move; a wiring lane reaching into the model to relax or
tighten the contract is not. If a retry path is ever wired, do that check in the
model first and delete the fence, rather than satisfying the fence by convention.

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

**A known limitation, shipped as-is: a peer who joins after our re-key never
learns our pre-re-key records.** No live session can vouch for them, so the
authorship gate refuses them on arrival. It is the same hole as "someone builds a
wall, leaves, and everyone who joins later sees an empty lot" — inherent to
authorship-by-envelope, and pre-existing rather than introduced by the rename.
Relaxing the gate is **not** the fix: that gate is what keeps a stranger's wall
out of `localWork` and therefore off the owner's disk, which is worth more than
fort persistence in a lobby that is still human-gated and unreachable.

The intended shape, unimplemented, is to **split the gate rather than remove
it**: authorship gates the *Save projection* only, while visual replication
accepts relayed records. A relayed wall can be visible, collidable and shootable
without ever entering any player's `localWork`, which gets a public lobby its
persistent fort while leaving the scene-write boundary exactly where it is. It
was deferred because it changes what a record *means* in two different consumers
at once, and tonight's goal is a lobby that does not lie about what it replicated.

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
