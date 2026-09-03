# Boots QA harnesses

## `mp-harness.mjs` — two players, one browser, no login

Proves "players see each other", spectating and voice against the LOCAL dev
server (`http://localhost:3002`), which has no collaboration bus. The harness
supplies one: a faithful `__pascalCollabBus` v1 stub per page, bridged over a
`BroadcastChannel`. Nothing under `src/` is touched.

### Run

```sh
# prerequisites: the private-editor dev server is up on :3002 and its plugin copy
# matches this repo (cp changed files one by one into
# ~/Documents/GitHub/private-editor/editor/apps/editor/node_modules/@pascal-app/plugin-boots/src,
# then wait ~25 s for Turbopack):
diff -rq ~/Documents/GitHub/plugin-boots/src \
  ~/Documents/GitHub/private-editor/editor/apps/editor/node_modules/@pascal-app/plugin-boots/src | grep -v '\.test\.'
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3002/scene/65fbacdc1faf   # 200

cd ~/Documents/GitHub/plugin-boots
MODE=play     node scripts/qa/mp-harness.mjs                                  # A and B both Jump in
MODE=spectate SHOT_PREFIX=/tmp/mp-spectate node scripts/qa/mp-harness.mjs     # A plays, B watches from the editor
MODE=voice    SHOT_PREFIX=/tmp/mp-voice    node scripts/qa/mp-harness.mjs     # play + WebRTC voice mesh
MODE=listen   SHOT_PREFIX=/tmp/mp-listen   node scripts/qa/listen-harness.mjs # A plays, B HEARS A from the editor, then drops in
```

Each run takes ~20 s, prints a one-line JSON summary followed by `PASS` or
`FAIL: <reasons>`, and exits 0/1 (2 = harness exception, 3 = watchdog). It
takes the machine-wide browser mutex `/tmp/boots-browser.lock` (waits if
another automation browser is up, reclaims a lock whose owner pid is dead) and
releases it on exit/SIGINT.

Knobs: `HEADFUL=1` show the browser · `KEEP_OPEN=1` keep it up after the summary ·
`SCENE=<id>` (default `65fbacdc1faf`) · `BASE=<url>` · `SHOT_PREFIX=/tmp/mp` →
`<prefix>-A.png` / `<prefix>-B.png` · `BUS_RAW=1` disable the host-faithful 66 ms
coalescing · `ALLOW_CAPTURE=1` keep native pointer lock / fullscreen ·
`PE_ROOT=<private-editor checkout>` (playwright is resolved from there) ·
`WATCHDOG_MS` (default 170 000).

### What the summary fields mean

| field | proof |
| --- | --- |
| `framesAtoB` / `framesBtoA` | `pose` frames each page's bus stub RECEIVED from the other session (from `__bootsBusLog`). In `spectate`, `framesBtoA` is 0 by design: `startSpectating` is receive-only. |
| `positionsChanged`, `moved` | A holds **W** for 1.5 s; the `p:[x,y,z]` of A's last pose as received by B must move > 0.2 m. `moved.source` is `KeyW`, or `teleport-fallback` if walking produced nothing (then the wire is still proven, the walk is not). |
| `avatarsSeenOnA/B`, `avatars` | three.js objects named `boots-remote-<sessionId>` (remote-players.tsx) in each page's R3F scene, with mesh count, world position, NDC and an `onScreen` frustum flag. In `spectate`, A sees 0 (the spectator publishes no avatar). |
| `presence` | `__boots.presence()` on in-game pages: roster with names (`Alice`/`Bob` from the stub roster), positions, counters. `null` on a page that is not in the game. |
| `voice` | `MODE=voice`: `connectedBothWays` + per-peer `state/connection/ice/hasTrack` from `__boots.voice()` and raw `voiceInternals()` (transceivers/receivers/senders). The mic is NOT pressed on: the veil's JUMP IN acquires it (`mic-gate.ts` `beginEntry` — Chrome's fake UI reports the permission granted, so the plan is `enter-with-mic`) and both pages read `mic: 'live'` on entry; the harness only presses **M** as a fallback if a page did not. Other modes: a one-line read of A's voice layer. |
| `bus` | stub stats per page: `published / deferred / coalesced / suppressed / delivered`. |
| `screenshots` | look at them. In `play`/`voice` the two stand 3 m apart facing each other; in `spectate` A is teleported onto the surface under B's editor-camera centre ray (`spectatorTarget` names it, e.g. `merged-roof` 3.8 m away) so the avatar cannot be occluded from B. `onScreen` is a frustum test only — it does not see occlusion, the screenshot does. |

### How it reaches the page (no `src/` edits)

- **Bus stub** (`installQaBus`, `addInitScript`): protocol v1, identity
  `A-session/A-client/A-user` and `B-…`, `projectId 'qa-project'`. Mirrors the host
  module `plugin-collab-bus.ts`: host-stamped sender, no self-echo, 8 000-byte
  serialized cap → `'suppressed'`, latest-value coalescing per `(pluginId,event)` at
  66 ms → `'deferred'`. `getParticipants()` returns both sessions from the start;
  `onParticipants` pushes the roster once after subscribing. Per page:
  `globalThis.__bootsBusLog` (ring, cap 2000, `{dir:'in'|'out', event, sessionId, t, data}`),
  `__bootsDeliver(msg)` to inject a frame as a fake peer, `__bootsQaBus()` stats.
- **Scene access** (`installQaHooks`): a `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub records
  every fiber root; R3F's root has `containerInfo === its zustand store`, so
  `__bootsQaScenes()` returns `{scene, camera, gl, …}` in ANY phase — that is how a
  spectator page (no `__boots`) is inspected. `__bootsQaAvatars()` and
  `__bootsQaCamera()` are built on it.
- **Capture guard** (`installQaCaptureGuard`): `requestPointerLock` /
  `requestFullscreen` are denied and `document.fullscreenEnabled` reads `false`.
  Reason: `session.ts` treats a LOST lock/fullscreen as Esc, and two pages in one
  browser share one focus — without the guard, bringing A to the front threw B back
  to the editor mid-run. Unlocked sessions are explicitly playable (input.ts), and
  the session takes its own CSS fake-fullscreen path.
- **Drive**: `/scene/<id>?boots=drop` shows the drop veil (`[data-boots-drop-veil]`)
  with the name input (`[data-boots-name-input]`) and the `JUMP IN` button; the
  spectator loads the plain `/scene/<id>` so the veil does not cover the editor view.
  If no Jump-in offer appears within 25 s, the Plugins-panel install recipe is tried
  (role/text selectors, then the left-rail pixel sweep from the older scripts).
- **In-game hooks used**: `__boots.presence()`, `voice()`, `voiceInternals()`,
  `teleport(x, z, yaw)` (yaw convention: forward = `(-sin yaw, -cos yaw)`),
  `cameraPose()`.

### Known limits / gaps

- The stub bus is same-origin and same-browser only (BroadcastChannel). It does not
  exercise the real server round-trip, auth, or the host's rate limiter beyond the
  66 ms coalescing.
- The plugin must already be installed on the project for the spectator page (the
  install recipe is only run on A; the project `65fbacdc1faf` has it).
- The mic is Chrome's fake device (`--use-fake-device-for-media-stream`), so
  `talking` flags reflect a synthetic tone, not speech. It is acquired by the veil
  (JUMP IN → `beginEntry`), not by a key press; `--use-fake-ui-for-media-stream`
  answers the permission read as granted, so the one-click `enter-with-mic` path is
  what runs. The ask-first path (permission `prompt`) is covered separately by
  `docs/qa/qa-boots-sidebar-jump.mjs` below.
- `voiceInternals` on the answerer can show one stopped transceiver + one ended
  receiver next to the live pair (an early renegotiation epoch). The live pair is
  what the pass criterion reads.

## `listen-harness.mjs` — hearing the game from the editor (voice lane)

`mp-harness.mjs` plus `MODE=listen`: A jumps in, B stays in the EDITOR (like
`spectate`) and must HEAR A without ever being in the game, then drops in through
the spectator hint pill and the SAME connection must survive the handover.

```sh
cd ~/Documents/GitHub/plugin-boots
MODE=listen SHOT_PREFIX=/tmp/mp-listen node scripts/qa/listen-harness.mjs   # ~45 s; same knobs as mp-harness
```

Page hooks: the spectator page installs `globalThis.__bootsListen`
(`spectator.tsx`, while the listen effect is up) with `debug()`, `internals()`,
`stats()`, `pill()`, `resume()`, `localEcho(on)`; the player page has
`__boots.voice()` / `__bootsVoice.pill()` / `__bootsVoice.stats()` as in `voice`.

| `summary.listen.*` | proof |
| --- | --- |
| `handle` | `__bootsListen` appeared on B once a live player name was seen (`WATCH_POLL_MS`) — `startVoiceListen` ran. |
| `recvonlyLink` | B's `debug().listen` is true and its link to A is connected with a `recvonly` transceiver. |
| `playerSendonly` | A's link to B is marked `listener` and its transceiver reads `sendonly` (the answer to a recvonly offer). |
| `rtpBytes`, `bytesReceived` | `getStats` on B: inbound RTP bytes from A > 0. |
| `elementPlaying` | B's audio element holds a stream and is not paused. |
| `listenFlagOnWire` | B's outbound `boots/voice` frames carry `listen: true` (a soft field: older pins ignore it and still answer). |
| `pillListening`, `pill` | the body-level listen pill reads `🔈 LISTENING · N ON VOICE`; `🔇 SOUND BLOCKED — CLICK TO HEAR THE PLAYERS` is the autoplay-refused state (a button → `resumeVoiceOutputs`). |
| `micNeverAsked` | `getUserMedia` was called 0 times on B and its mic reads `off`. |
| `playerPillNamesListener`, `playerPill` | A's mic pill says `1 LISTENING FROM THE EDITOR` — the only trace a listener leaves for the players. |
| `handover.*` | after B clicks the hint pill and enters: `listenOffB` (B's session is a game session now), `sameLinkB` (no restart, nothing reaped on B), `noRestartA` (A's link stayed connected, `listener` cleared), `sendrecvA` (A's m-line flipped), `bytesAtA` (B's mic RTP arriving at A). |

Audibility is NOT asserted and cannot be here: both pages share one browser, so
`voice.ts` mutes the pair as SAME DEVICE (gain 0). Bytes, directions and element
state are the proof; `__bootsListen.localEcho(true)` un-mutes for a human listening
in `HEADFUL=1`. Screenshots: `<prefix>-B-listening.png`, `<prefix>-B-dropped-in.png`.

## `docs/qa/qa-boots-sidebar-jump.mjs` — the sidebar Jump in runs through the mic gate

One page, permission read forced to `prompt` (the branch `--use-fake-ui` hides):
click 1 on the left-rail `⏵ Jump in` must NOT enter — it becomes the permission
prompt (`ALLOW THE MIC ↑`, disabled, then `⏵ PLAY`) and calls `getUserMedia` once;
click 2 enters with `mic: 'live'` and no second `getUserMedia`. Prints one JSON line
(`labels`, `enteredOnFirstClick`, `gumCalls`, `micAfterEntry`) + `PASS`/`FAIL`;
screenshots `/tmp/sidebar-play.png`, `/tmp/sidebar-ingame.png`.

## `see-swap-harness.mjs` — the bus is not forever (presence lane)

`scripts/qa/see-harness.mjs` (three pages, held/late bus, drop-in, Escape) plus
step 3b/3c: the three things the host's awareness runtime does to
`__pascalCollabBus` (`use-project-awareness.ts` + `plugin-collab-bus.ts`), first
on the SPECTATOR page B, then on the PLAYER page A.

```sh
cd ~/Documents/GitHub/plugin-boots
node scripts/qa/see-swap-harness.mjs            # ~45 s; same knobs as see-harness (HEADFUL, KEEP_OPEN, SHOT_PREFIX=/tmp/see-swap, SCENE, BASE, BUS_RAW)
```

Stub hooks (installed by `installQaBus` on every bus page, callable from
`page.evaluate`):

| hook | what the host does that it mirrors | pass criterion |
| --- | --- | --- |
| `__bootsQaSwapBus(over?)` | channel restart: the bus object is uninstalled (handler sets cleared) and a NEW object with the SAME identity is installed synchronously (`over` re-keys it) | followed by object identity on the next tick — transport + roster re-subscribed on the new object, registry intact (`rosterVersion` unchanged), fresh frames heard (`remotes[].lastSeenMs` advances), `presence().swaps/rebinds ≥ 1`; on the PLAYER side the outbound seq continues (B's `netDropped` does not climb, Alice never despawns) |
| `__bootsQaBlipRoster(laterMs)` | the awareness reset: an EMPTY participant list pushed now, the real one `laterMs` later | nobody despawns, `rosterVersion` holds, `rosterMissingMs` never expires |
| `__bootsQaOutage(gapMs)` | teardown → later re-install: NO bus at all for `gapMs` | `presence().bound` false meanwhile, peers stay listed, bound again after, frames flow, no leave/join |

Summary fields: `steps.busSwap`, `steps.rosterBlip`, `steps.busOutage` (spectator
side) and `steps.playerBusSwap`, `steps.playerBusOutage` (player side). Against the
pre-fix `presence.ts` the spectator steps report the deaf new bus and Alice
despawning; against a `net.ts` that reset `outSeq` on start the player steps report
"no fresh frames from Alice after HER bus swap" (B refuses the rewound stream).
