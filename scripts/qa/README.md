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
| `voice` | `MODE=voice`: `connectedBothWays` + per-peer `state/connection/ice/hasTrack` from `__boots.voice()` and raw `voiceInternals()` (transceivers/receivers/senders). Other modes: a one-line read of A's voice layer. |
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
  `talking` flags reflect a synthetic tone, not speech.
- `voiceInternals` on the answerer can show one stopped transceiver + one ended
  receiver next to the live pair (an early renegotiation epoch). The live pair is
  what the pass criterion reads.
