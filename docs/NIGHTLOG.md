# Night log

## Round 1 — 2026-08-25 (overnight, owner play-test feedback)

Landed:
- **Viewmodel pose** — weapons anchor low-right (classic FPS), full procedural
  stack: draw-in, breathing, look-lag spring, speed-cadenced run bob, landing
  dip. Muzzle flash rides the active gun's muzzle offset.
- **Weapon models** — new `weapon-models.tsx` (the dedicated agent stalled;
  manager wrote it to the agreed contract): pistol with slide/grip/guard/
  sights, rifle with receiver/handguard/mag/stock/muzzle brake, knife with
  guard + tapered blade, blueprint hammer. Grip at origin, -Z barrel,
  `MUZZLE_OFFSETS` exported.
- **Grass v2** — 5-blade tapered clusters (one InstancedMesh, ~300k tris),
  root-to-tip vertex-color gradient, density biased toward the building,
  bigger sparse clumps far out, flower discs, deeper ground tone.
- **Wall anatomy** — voxel targets generalized (`VoxelTarget`, any collider
  group), walls keep skins via `dropInteriorCells` + breakable studs
  (`StudMember` hp 3, `raycastStuds`/`damageStud`, analytic yaw-OBB ray).
  Renderer shows dents on chipped studs, hides broken ones; snap spawns
  falling wood + splinters.
- **Doors** — `doors.tsx`: E within 2.2 m toggles a 280 ms hinge swing away
  from the player, colliders off while open, creak/latch sfx, restore ledger
  on exit. Mounted in game-root; `__boots.doors` debug handle.
- **Everything breaks** — shooting pipeline rewritten: solid → voxel → stud →
  glass → bot with 1 cm class-priority tie-break; any destructible node kind
  (slabs, roofs, furniture, stairs…) voxelizes + carves on first hit.
- **Audio** — material voices (drywallCrunch, studHit/studSnap, doorCreak/
  doorLatch, woodCrumble) + round-robin detune so repeated shots never sound
  identical.
- **Integration (manager)** — created weapon-models.tsx; destruction now
  plays studHit on chips / studSnap directly, skips its generic crunch for
  walls (shooting.ts voices drywall); HUD prompt owner keys wired
  (guntable/doors); brand names scrubbed from src, package.json, MASTERPLAN.

Rough / next:
- Typical 0.10–0.15 m walls voxelize ONE cell thick at the 0.15 m cell, so
  the outer-skin/cavity/inner-skin read only appears on walls ≥ ~0.45 m.
  Needs anisotropic cells (thin cells across the thickness axis) — the
  owner's dual-skin ask is only half-visible until then.
- `sfx.woodCrumble` exported but not yet called anywhere.
- viewmodel derives its own look velocities; `playerRig.yawVelocity/
  pitchVelocity` (smoothed, from wiring) could replace that.
- No in-browser QA of this round yet (models scale/orientation, door swing
  in real plans, stud hit-feel) — round 2 starts with a play-test pass.

Checks: `bun run check-types` clean, `bun test` 28 pass / 387 expects.

## Round 2 — 2026-08-25 (overnight)

- **Wall anatomy v2** — `voxel.ts` grids are now anisotropic
  (`cellX/cellY/cellZ`, optional `VoxelCellOverride` on `buildVoxelGrid`);
  `destruction.ts` pins the wall thickness axis to thickness/max(3,…) cells,
  so 0.10–0.15 m walls really get outer skin / stud cavity / inner skin.
  `dropInteriorCells` picks the thickness axis by physical extent; DDA,
  removeSphere, and capsule push-out honor per-axis cells. 5 new grid tests.
- **Weapon models v2** — pistol (slide ribs, ejection port, hammer, closed
  trigger guard), rifle (charging handle, gas tube, front sight, 2-segment
  mag, stock wedge + butt pad), knife (fuller + bright edge), hammer (real
  two-prong claw). MUZZLE_OFFSETS retuned.
- **Viewmodel v2** — look-lag now reads `playerRig.yawVelocity/pitchVelocity`
  (teleport-safe, pre-smoothed); POSES retuned to the new model extents,
  everything clears the near plane through recoil.
- **Wiring** — `smoke.test.ts`: 11 headless tests over the full
  fire→voxelize→stud pipeline (skins+cavity, stud snap, slab volume, prop
  refusal).
- **Integration (manager)** — voxel-walls.tsx renders per-axis voxel scale
  (skins no longer draw as full cubes); input.ts pointer-lock promise
  rejection swallowed (console now clean on enter); doors stand down once a
  door is voxelized (no prompt/swing, colliders stay owned by destruction —
  fixes the invisible-collider resurrection); stud hp clamps to 0 on break.

Rough / next:
- Doors still never toggled in a LIVE browser (QA scene had no door) — seed
  one and verify open/close + walk-through.
- Two-skin read needs a close-up visual confirmation shot post per-axis
  scale fix.
- '1 Issue' editor badge after exit (likely host validation, pre-existing) —
  confirm not Boots-related.
- Headless fps floor ~3.5 (software GL) — validate smoothness on real HW.

Checks: `bun run check-types` clean, `bun test` 44 pass / 1828 expects.

## Round 3 — 2026-08-25 (live QA + diagonal-wall hotfix)

Live QA round (host UI at :3002, 4-wall room + door + standalone wall): no
worker source edits; wiring agent drove a full in-browser pass.

- **Doors on E** — PASS live: prompt in range, swings away from player,
  walk-through, close from inside, blocks again. `__boots.doors` works.
- **Door vs destruction** — PASS: rifle voxelizes the door, prompt stands
  down, toggle becomes a no-op.
- **Dual skins + studs** — PASS on axis-aligned walls: thin per-axis slab
  returns, outer skin / cavity+stud / inner skin all read, knife peels the
  outer skin only, capsule collides with live skins.
- **Viewmodel v2** — PASS: all three weapons low-right, muzzle toward
  center, no crosshair clipping. Knife silhouette weakest.
- **Console/exit/fps** — zero pageerrors, Esc restores scene pristine
  twice, ~120 fps steady through heavy destruction.

**Hotfix (manager)** — QA caught a severe regression: any wall >~5° off
world axes (i.e. every wall drawn in the rotated 3D view) vaporized on
first shot — `ensureVoxelTarget` ran `dropInteriorCells` on the legacy
isotropic branch too, and for deep diagonal AABBs the min physical extent
is the wall HEIGHT, keeping only top/bottom rows. Fix: skinning now runs
only in the anatomy branch, `dropInteriorCells` gained a `maxThickness`
bail (destruction passes `MAX_ANATOMY_THICKNESS`), and voxel.test.ts got a
diagonal-volume pass-through case.

Rough / next:
- Diagonal walls keep the legacy isotropic volume (no skins/cavity) — needs
  live re-verify post-hotfix; true anatomy would need an OBB-aligned grid.
- doors.tsx samples held keys per frame; a sub-frame E tap can be missed —
  consume the one-shot `KeyE` action instead.
- Knife viewmodel handle still reads slightly tube-like.
- Studs render slightly proud of the outer skin on voxelized walls (tan
  strips on the intact face) — okay-cartoony, could inset.
- Prop visuals stay intact while their colliders carve (guntable) — visual
  break-apart still open.
- Editor camera slightly more zoomed-out after exit (camera-controls state
  only, scene data untouched).

Checks: `bun run check-types` clean, `bun test` 45 pass / 1830 expects.

## Round 4 — 2026-08-25 (diagonal anatomy + QA sweep)

Landed:
- Diagonal walls get REAL anatomy: `VoxelGridData.yaw` (grid axis-aligned in
  a Y-rotated local frame, centers stay world), `buildDiagonalWallGrid` in
  destruction.ts — dual skins + cavity + breakable studs at any wall angle.
  raycastVoxels/removeSphere/collideVoxelTargets rotate queries internally;
  legacy grids take yaw==0 fast paths (byte-identical). 5 new voxel tests.
- Renderer wired for yaw grids (voxel-walls.tsx): instances now rotate
  [0, -yaw, 0] like studs — fixes QA's "venetian blinds" on diagonals.
- Stud depth derived from the grid's skin cells (`studDepth`): studs no
  longer render proud of intact drywall; smoke test re-derived (4.982) with
  a formula-robust `> 4.98` regression guard.
- Doors: tap-robust E via the one-shot action queue at useFrame priority -1
  (strips only KeyE, only when a door acts; guntable keeps keys-sampling).
  hud.ts `prompt()` clear branch now blanks textContent, so the doors-side
  blank-space workaround was dropped.
- Everything breaks: gun-table visible meshes ARE the colliders now (type
  'item') so its voxel replica is table-shaped and display guns blow off;
  builder pieces likewise self-colliding (type 'block'). New
  `dropTarget(nodeId)` in destruction.ts wired into builder G-undo so an
  undone voxelized piece drops its replica.
- Knife viewmodel reworked (blade-dominant, wood/steel grip); pistol mag
  baseplate flushed to the raked grip.
- Live QA (rotated room, 4 diagonal walls + door + table): axis-wall
  regression PASS, door tap/walk-through/stand-down PASS, prop carve PASS,
  island collapse sweep PASS, exit hygiene PASS twice, 120 fps steady.

Rough / next:
- Diagonal yaw-grid rendering fixed post-QA — needs one live screenshot to
  confirm the venetian-blind read is gone.
- Guns one-shot studs (damage 24-34 vs STUD_HP 3) — feel call for the owner.
- Bots deal ~45 hp/s at melee; a god-mode/bots-off toggle would deflake
  headless QA.
- guntable E is still keys-sampled (fine while it's hold-adjacent; queue
  pattern available if tap-robustness is wanted — one stripper per key).

Checks: `bun run check-types` clean, `bun test` 50 pass / 2337 expects.

## Phase 2, Round 1 — 2026-08-25 (can't die, grace countdown, builder feel)

Owner feedback round: no respawn-teleport on death, builder-generation build
mode, and a peaceful start with a ~5s countdown once you grab a gun.

Landed (5 agents + manager integration):
- **You can't die** (player.tsx / store.ts): respawn-teleport removed.
  `damagePlayer(amount, fromDir?)` is the one damage entry point — knockback
  shove (playerRig.shove, impulse accumulator), regen (+12 hp/s after 4s,
  writes chunked), and a 2.5s STAGGER instead of death: health pins at 1,
  `store.staggered` flips, walk-speed legs, no jump, camera sway, weapon
  droop + fire block (viewmodel.tsx), mercy window (no hp loss while
  staggered). Recovery at 40 hp. Safety net converts any raw health<=0
  store write into the stagger path.
- **Damage feel** (hud.ts / audio.ts): `damageFlash(angle?)` now directional
  — four edge-glow strips with cosine falloff (angle computed screen-relative
  in damagePlayer). Persistent low-HP vignette pulses on a severity-scaled
  heartbeat below 45 hp. Full-screen stagger overlay ("shake it off") keyed
  off `store.staggered`. Audio master chain grew a concussion lowpass
  (`sfx.setMuffle`) and a lookahead-scheduled `sfx.heartbeat()` handle.
- **Pacing** (enemies-state.ts / enemies.tsx): peaceful GRACE until the first
  gun pickup (pistol/rifle in owned) — building/breaking never wakes the
  machines. Then a one-shot 5s "They heard you — N" countdown top-center,
  WAVE 1 at zero; later intermissions show a subtle lowercase line. Melee
  routes through damagePlayer (knockback + directional flash for free).
  MERCY while staggered: ground bots hold a 4–6 m standoff ring, drones
  climb +1 m and hover. enemies.tsx also drives setMuffle on stagger edges
  and the heartbeat rate/level from health.
- **Builder feel** (builder.tsx): adjacency snap — walls chain end-to-end +
  stack (aim-gated), floors tile 4 ways, ramps dock low-edge to floor edges
  and wall bases (rise = WALL_H by construction). Hold-to-place sweeps runs
  (0.18s min interval, re-stamps on pose change). Occupancy check (pose
  modulo piece symmetry) tints the ghost red and skips silently. Pitch-
  shortened reach so the ghost tracks your aim. G-undo now splices the
  collider out and drops any voxel replica. 10 new tests.
- **Copy** (panel.tsx / README.md): builder-first story — "It's a game — and
  a way to build", grace/countdown and staggered-not-dead called out,
  hold-click runs documented.
- Manager integration: damageFlash cast in player.tsx made a direct typed
  call; redundant 0.5s stagger red-pulse/sfx removed from player.tsx (HUD
  overlay + enemies-driven heartbeat own it now); hud.ts staggered read made
  direct; audio.ts "exposed, not wired" comments updated (wired from
  enemies.tsx); builder placement gated while staggered to match the
  viewmodel fire block (prevFire still tracks the raw button).

Rough / next:
- Live QA pass pending (this round was headless-only): stagger feel timing,
  countdown legibility over the wave line, snap ergonomics at corners,
  drone hover during mercy.
- Stagger sway + weapon droop numbers are first-pass — tune after a live run.
- Ramp-on-ramp and wall-on-floor snaps intentionally absent (grammar keeps
  corners on the grid).

Checks: `bun run check-types` clean, `bun test` 65 pass / 2385 expects.

## Phase 2, Round 2 — 2026-08-25 (feel tuning: stagger camera, heartbeat sync, countdown drama)

- **Death dynamics** (player.tsx / viewmodel.tsx): stagger camera retuned from
  live traces — two detuned rolls (peak ~1.9°, under the motion-sickness
  band) + head-hang slump (SLUMP_PITCH, eased over 0.35s) + FOV tunnel
  92→86. 0.6s get-up beat at stagger end: exported pure `getUpPitch(u)`
  (slump releases (1-u)², small upward lift, settles to exactly 0) while the
  FOV settles back; viewmodel re-raises the weapon from below on the falling
  edge (negative drawT hold + clamped cubic). Mercy-window shoves dampened
  to 40% (`STAGGER_SHOVE_SCALE`) — the hit that CAUSES the stagger stays
  full power. Pile-on sim: 0.57 m net drift, never juggled. `playerDebug`
  grew `damage`/`drainShove()`/`sample()` (typed `PlayerSample`), published
  as `globalThis.__bootsPlayer` while mounted, deleted on unmount.
- **Damage feel** (audio.ts / hud.ts): `HEARTBEAT_HP`, `lowHpSeverity()` and
  `heartbeatBpm()` (70→150 bpm) exported as THE severity→bpm mapping; HUD
  beat() drift bug fixed (was on a different denominator). Phase lock:
  `setHeartbeatPulseListener` fires per audible scheduled lub; hud's new
  `beatPulse(delayMs)` retimes the visual pulse onto the sound, degrading to
  self-timing when audio is silent. Stagger overlay re-ordered UNDER the
  directional edge strips (DOM paint order) + peak softened so damage
  flashes stay readable mid-stagger.
- **Pacing** (enemies.tsx / enemies-state.ts): countdown drama with existing
  voices — a second droneBuzz spin-up swells 0→0.09 across the 5s, relay
  clack (doorLatch) on ticks 5–2, arming rack (reload) on the last; first
  wave lands as `HERE THEY COME` (later waves keep `WAVE n`). Headless QA:
  grace holds under rifle fire, countdown fires exactly once per session
  incl. resetBots() re-arm, zero pageerrors. Documented: bots steer without
  collision (can reposition through placed pieces during standoffs; never
  attack from inside one).
- **Builder feel** (builder.tsx): wall stacking gate raised mid-height →
  3/4 height (`STACK_GATE` 0.75): a level gaze at eye height 1.58 cleared a
  ground wall's midpoint (1.4), so holding fire auto-towered without looking
  up (live QA find). `builderDebug` (`__bootsBuilder`) dev handle: holdFire
  stands in for held LMB headless, `ghost()` snapshots the resolved pose.
- **Copy** (panel.tsx / README.md): countdown wording matches shipped pacing
  ("five-second countdown… HERE THEY COME"), stack-by-looking-up and
  machines-back-off stagger lines added; badge aligned to Alpha.
- Manager integration: enemies.tsx heartbeat now uses the shared
  `heartbeatBpm(health)` / `lowHpSeverity` from audio.ts (local
  HEARTBEAT_HP removed); STACK_GATE pinned by a new stacking-reach test;
  commercial-game-name comment in movement.ts neutralized.

Rough / next:
- Dedicated `sfx.machineSpinup()` (progress-driven pitch/lowpass sweep)
  would read better than the fixed-pitch droneBuzz under the countdown.
- Bot-state E2E hook (`__boots.bots()`) + god/bots-off toggle for headless
  mercy-ring/drone-climb verification.
- Builder: floor-on-wall-top (roofed boxes) still absent from the snap
  grammar; dog shove (~0.27 m) reads slightly under droid (~0.35 m).
- Dev copies in private-editor node_modules were partially synced by agents
  during live QA — full rsync at deploy time is mandatory (stale-code burn).

Checks: `bun run check-types` clean, `bun test` 74 pass / 2400 expects.

## Phase 2, Round 3 — 2026-08-25 (roofing, spin-up voice, shove floor, E2E hooks)

- **Builder feel** (builder.tsx + tests): floors now ROOF walls — new
  `resolveSnap` case `floor`-on-`wall`: two candidates at the wall top
  (`py + WALL_H`), centers offset `ROOF_OFFSET = SPAN/2 = 1.5` along the
  wall normal so the floor edge sits flush on the wall line, floor adopts
  the wall yaw (π/2 symmetry). Gated by the same 3/4-height aim test as
  wall stacking, evaluated at the wall's XZ — level-gaze ground tiling
  beside a wall never teleports up, and the Y weight in `consider()` keeps
  a same-level tile winning under a tilted aim. 7 new tests (gate, both
  sides, rotated wall, ground-tiling guard, tile-vs-roof priority,
  roof-level occupancy modulo floor symmetry).
- **Damage feel** (audio.ts): dedicated `sfx.machineSpinup()` countdown
  voice (the round-2 wishlist item) — `{ setProgress(0..1), stop }`;
  sawtooth 50→180 Hz through a lowpass 350→2200 Hz with AM tremolo
  18→40 Hz, level 0→0.09 hard-capped so it stays distant; all four targets
  ride `setTargetAtTime` ramps (safe per frame, no zipper, no allocs);
  routes through master so setMuffle concusses it; stop idempotent.
  `MachineSpinupHandle` exported; documented in the file-header "Loop
  voices" section + method JSDoc.
- **Death dynamics** (player.tsx + tests): `SHOVE_MIN = 2.2` m/s knockback
  floor inside the SHOVE_MAX clamp, applied before mercy dampening — a dog
  nip (9 dmg, raw 1.875 m/s ≈ 0.27 m slide) now reads as a real shove
  (~0.31 m); droid/drone/cap unchanged; mercy on a floored hit = 0.88 m/s.
  3 new tests (floor, above-floor passthrough, mercy-on-floored).
- **Pacing** (enemies.tsx / enemies-state.ts / game-root.tsx): countdown
  swapped from the second droneBuzz to `machineSpinup` (null-guarded),
  driving raw progress `1 − countdown/ALERT_SECONDS`; identical lifecycle
  (stop stale voice on resetBots re-arm, stop+null at zero, stop on
  unmount). New dev/E2E hooks: `debugFlags.botsFrozen` (enemies-state,
  cleared by resetBots) freezes ALL steering/attacks while walk cycles
  idle; `__boots.bots()` (plain snapshots) + `__boots.setBotsFrozen(v)` on
  the dev handle. Headless QA (fresh server, full src rsync first): grace,
  once-per-session countdown on the new voice, HERE THEY COME one-shot,
  freeze 0.0000 maxDelta over 5 s, mercy ring dists 4.03/5.99 m with hp
  pinned at 1 through a pile-on, get-up trace fov 92→86→settle + health
  landing exactly 40, Esc restore clean, zero pageerrors.
- **Copy** (panel.tsx / README.md): roofing documented — "look up to stack
  walls, cap them with floors" / "floors tile and cap wall tops (build a
  box of walls, roof it with floors)". Full claim→code re-verification of
  every panel/README line passed (countdown, mercy, keys, keep-scope).
- Manager integration: seam audit only, nothing dangling — enemies melee
  routes through `damagePlayer` (floor + flash + stagger for free),
  `hud.damageFlash(angle)` signature matches its one caller, muffle +
  heartbeat driven from the enemies stagger edge, staggered flows
  store→player/viewmodel/enemies, PlacedPieces colliders are pose-generic
  so roof-level floors are walkable.

Rough / next:
- Roofed-box live QA (walk up a ramp onto a placed roof) not yet run
  headless; builder snap covered by unit tests only this round.
- Doors still untested on blank-canvas QA scenes (no door nodes).
- Dev server on :3002 dies with the agent that started it — restart is
  part of the deploy runbook now.

Checks: `bun run check-types` clean, `bun test` 84 pass / 2429 expects.

## Phase 2, Round 4 + close — 2026-08-25 (heavy gun, atmosphere, manager seams)

- **Arsenal** (weapons.ts / weapon-models.tsx / viewmodel.tsx / guntable.tsx /
  audio.ts): new `minigun` — 24/s auto, 10 dmg, 0.15 m holes, wide spread,
  tiny constant kick, `spinUp: 0.45` (held trigger accelerates barrels
  before the first round; release spins down). Real `MinigunModel` on a
  second "heavy" table mirrored BEHIND spawn ("E — The big one"); viewmodel
  drives rotary spin state, per-shot flash, and the new `sfx.minigun()`
  voice (twin detuned saws + barrel-pass AM whine, round-robin shot ticks).
- **Atmosphere** (dust.tsx NEW / sky.tsx NEW / debris.tsx / audio.ts):
  `spawnDust`/`spawnHaze` camera-facing quad pools (one draw call each,
  strict caps, zero per-frame allocs) — impact puffs + lingering collapse
  haze; `GameSky` overcast warm-gray dome (BackSide sphere + CanvasTexture,
  zero per-frame cost) replaces the editor void during sessions; debris
  gains flat "plate" shards with papery flutter (`spawnFlatDebris`);
  crumbles seat a low rumble + dust-hiss bed. Phase-3 one-shots pre-built,
  no callers yet by design: `paperTear`, `charSnap`, `treeCrackle`.
- **Manager seam close**: WeaponId widened with 'minigun' in store.ts (the
  round's bridge casts now no-ops); `Digit5` added to input ACTIONS so the
  viewmodel's slot-5 switch actually receives the key; `<DustSystem/>` +
  `<GameSky/>` mounted in game-root (with `clearDust()` in teardown);
  dust wired to its call sites — bullet-chip puff on non-destructible
  impacts (shooting.ts), carve-scaled puff in `damageTarget` and one haze
  plume per island crumble (destruction.ts); `__boots.fire` accepts
  'minigun'. player.tsx shove-comment numbers corrected to QA-measured
  slides (dog ≈0.24 m / droid ≈0.28 m / drone ≈0.34 m — crisp-stop trims
  the old v/friction estimates); MASTERPLAN paint-tool slot note fixed
  (slot 5 is now the heavy gun).

Rough / next (morning):
- This round is type/test-clean but NOT live-QA'd (last headless pass was
  p2r3, pre-minigun): QA the heavy-table pickup, spin-up feel, dust/haze
  density, sky dome look, flat-shard flutter.
- Wire paperTear/charSnap/treeCrackle + spawnFlatDebris call sites
  (drywall skin plates want paperTear + flat shards).
- Still open from r3: roofed-box live QA (ramp onto a placed roof), doors
  untested on blank-canvas QA scenes (seed a door into the QA recipe).

Checks: `bun run check-types` clean, `bun test` 84 pass / 2429 expects.

## Phase 3, Round 1 — 2026-08-25 (3x3 build grammar, sandwich-ready renderer/routes, manager close)

Two of eight workers (wall-sandwich = destruction core, trees-fire) failed
to land; everything that touches them is feature-detected and inert until
their APIs exist, so the tree stays green and live-testable.

- **3x3 build grammar** (store.ts / builder.tsx / keep.ts / builder.test.ts):
  `BuildPiece` ramp→**roof** rename; every `PlacedPiece` carries a 9-bit
  `mask` (bit = col + row·3, `FULL_MASK = 511`, `setPlacedMask` swaps the
  piece so mesh+collider re-register). Pieces render as merged-box geometry
  of live cells (cached per piece+mask); one merged collider per piece.
  **F edit mode**: builder equipped + F on a placed piece ≤6 m → 3×3 cell
  overlay (gold hover / blue live / red dead), LMB toggles a cell, F exits.
  **Keep mapping**: 511→plain wall; dead end-columns→shorter wall; center
  pocket→wall+WINDOW node; bottom-center pocket→wall+DOOR node; roofs
  attempt real shed `roof-segment` nodes (pitch ≈43°); floors game-only.
  New planning API in builder.tsx (`raycastPieceCell`, `planWallMask`,
  `trimmedWallSpan`…), re-exported by keep.ts; +31 test suites.
- **Sandwich-ready renderer** (voxel-walls.tsx): rewritten — skins keep the
  queue-drain but allocation-free; NEW instanced `MemberLayer` draws
  `target.boards` (flat drywall plates, hairline seams) and
  `target.segments` (skinny lumber, chip-tint + pinch) as ONE InstancedMesh
  each, synced by an alloc-free hp/flag checksum; legacy `studs` render
  through the same instanced path (≤40 meshes/wall → 1 draw call).
- **Shot routing** (shooting.ts): priority ladder solid→skin→board→segment
  →tree→glass→bot with 1 cm near-tie window; phase-3 façade
  (`raycastBoards`/`damageBoard`/`raycastSegments`/`damageSegment`) is
  existence-guarded — segments fall back to the legacy stud lane today;
  carves pass shot direction; every hit class puffs dust;
  `registerTreeRoutes()` lets the future trees module plug in combat;
  `FireOutcome` gains 'tree'.
- **Wiring** (input.ts / world.ts / game-root.tsx / hud.ts): `KeyF` in
  GAME_KEYS; Bones overlay roots (`bones:framing/lumber/service/device`)
  collected in `world.overlayRoots` and hidden via the session ledger — the
  unbreakable X-ray ghost layer is gone; `<Prevoxelize/>` drives
  `destruction.prevoxelizeTick(world, 2)` per frame (feature-detected,
  no-ops until wall-sandwich lands); `hud.editHint()` line above prompts;
  `__boots` debug gains boards()/segments()/trees()/pieces().
- **Manager close**: minigun now trips the gun-pickup alert (enemies.tsx)
  and gets a HUD label ('THE BIG ONE'); builder drives `hud.editHint` on
  edit-mode enter/exit; panel.tsx copy refreshed (roofs try real nodes,
  slot-5 + F-edit controls, Keep result surfaces windows/doors/roofs).

Rough / next (round 2):
- wall-sandwich MUST land: pre-voxelized cladding at spawn
  (`prevoxelizeTick`), `boards`/`segments` members + damage/raycast APIs
  (contracts pinned in shooting.ts + voxel-walls.tsx doc blocks),
  paper-tear plates (`spawnFlatDebris` + `sfx.paperTear`), charcoal-stick
  segments (`sfx.charSnap`), floating-island collapse for item voxels.
- trees-fire MUST land: trees-destruct.tsx (voxel collapse or ignite→
  charcoal→stump), `registerTreeRoutes` at init, `sfx.treeCrackle` drive,
  `<TreesDestruct/>` mount + trees() debug swap in game-root.
- player.tsx: optional `playerRig.speedScale` so a spun-up heavy gun can
  slow the carrier (minigun agent's ask).
- viewmodel Q piece-cycling isn't edit-mode-aware (harmless; builderDebug
  could expose isEditing).

Checks: `bun run check-types` clean, `bun test` 98 pass / 2489 expects.

## Phase 3, Round 2 — 2026-08-25 (dust rework + wiring; sandwich/trees workers failed again)

Round outcome: the two core workers (wall-sandwich, trees-fire) failed to
land for a second round — destruction.ts still has the phase-2 anatomy
(no `prevoxelizeTick`, no boards/segments/sheets) and no trees-destruct
module exists. Everything around them landed and is green.

- **Dust rework** (dust.tsx + dust.test.ts): glowing balls gone —
  NormalBlending gypsum quads with ragged CanvasTexture atlas silhouettes,
  per-instance alpha fade, coned ejection around the surface normal; kinds
  chip/puff/plume + haze; pool-pressure guard. destruction.ts owns ALL wall
  dust (shooting.ts is wall-silent); carves throw a 'plume' aimed through
  the hole via damageTarget's optional direction arg.
- **Tear feel prep** (weapons.ts / shooting.ts / debris.tsx): per-weapon
  `tearRadius` for wall targets (pistol ~0.9 m holes); board lane removed
  from routing (sheets become logical voxel groups when sandwich lands);
  torn-edge plate debris proportions + ground-slap chip + flat-shard cap.
- **Spin drag** (player.tsx / viewmodel.tsx): `playerRig.speedScale` API
  (move-loop multiplier, writers restore to exactly 1); rotary spin lerps
  it 1→0.55 so the heavy gun slows the carrier; restored with the
  spin-down whine and on unmount.
- **Overlay ghosts** (game-root.tsx / world.ts): ForeignOverlayHide +
  OverlaySweep re-hide late-registering Bones overlay roots (frames
  0–120, idempotent, every flip in the restore ledger) with a layer-mask
  backstop restored on exit.
- **Z-fighting** (nature.tsx / builder.tsx): lawn disc raised + building
  footprint cut from the ground geometry; builder ghost inflated 1.03.
- **Manager close**: `__boots.targets()` census dump added (nodeId, kind,
  aliveCount/totalCount, revision, brokenStuds) — QA can now measure voxel
  removal and island collapse numerically; commercial-name grep clean;
  panel copy tweak (construction boots / not-OSHA joke) folded in.

QA round 1 verdict recap (still open): (a) pre-voxelized look FAIL,
(b) sandwich FAIL (one rifle hit pierces the whole 0.12 m wall — tear vs
skin layering needs the real anatomy), (d) trees ABSENT, (g) island
collapse FAIL on the wall cut / untested on item volumes. PASS: minigun
rear table + sweep-leveling, 3x3 pocket→window Keep mapping, sky, exit
restore, 120 fps.

Round 3 MUST-land (same contracts, pinned in shooting.ts +
voxel-walls.tsx + game-root.tsx doc blocks):
- wall-sandwich: `prevoxelizeTick(world, budgetMs?) => boolean` (driver
  passes a ~4 ms TIME budget), sheets/segments members + damage/raycast,
  paper-tear + charcoal-stick feel, thickness-aware tear so one hit ≠
  through-hole, island collapse incl. studless item volumes.
- trees-fire: trees-destruct module, `registerTreeRoutes()` at init,
  ignite→charcoal→stump, `<TreesDestruct/>` mount + trees() debug swap
  (exact patch recipe in wiring's round-2 report / game-root comments).
- sky nit: brighter breaks barely visible at zenith + faint concentric
  banding at the dome pole.

Checks: `bun run check-types` clean, `bun test` 113 pass / 4139 expects.

## Phase 3, Round 3 — 2026-08-25 (sandwich finish + manager-built trees + remount healing)

Round outcome: wall-sandwich delivered the full round-3 slate; trees-fire
failed a THIRD time so the manager built trees-destruct directly. Wiring
closed every other seam. All in: `bun run check-types` clean, `bun test`
139 pass / 6351 expects.

- **Sandwich (destruction.ts / voxel.ts)**: skin-aware pierce —
  `removeSphere` takes an optional `SkinLimit`, wall carves under
  `WALL_PIERCE_RADIUS = 0.6` only open the ENTERED face (the far skin
  falls to the follow-up shot through the hole; a future heavy weapon
  gets both with `tearRadius ≥ 0.6`). Sheet fly-off sheds ≤ 12 torn-edge
  plates + crumbs; carves shed rim shards. `SegmentMember` charcoal
  sticks at real lumber cross-section (0.038 × 0.089 m; verticals split
  2-3 sticks, plates ~1.2 m runs, hp 2) with `raycastSegments` /
  `damageSegment` (+ legacy stud aliases).
- **Island wraparound root cause (voxel.ts)**: `findUnsupportedIslands`
  read neighbors without bounds checks — `gridKey`'s flat linearization
  aliased out-of-range coords onto real cells (−y under the base row =
  top row of the previous z-slab), teleporting the support flood into
  floating islands. Bounds-checked both floods; the QA floating-tabletop
  and the owner's cut-shower now crumble. Regression tests pinned.
- **Trees (trees-destruct.tsx, NEW — manager-built)**: nature's grove
  (same scatter seed, nature.tsx no longer renders trees) is a target
  class. State machine per tree: trunk fire fells (hp 70) into a voxel
  burst in the tree's colors down to a stump; canopy damage ≥ 48 ignites
  — crackle loop + smoke puffs + embers while the crown chars over 4.5 s,
  then it collapses into charcoal voxels leaving a black trunk + 3 bare
  branch sticks; each further hit snaps one (charSnap), the last bursts
  the trunk to a stump. Four InstancedMeshes for the whole grove; analytic
  trunk-cylinder/canopy-sphere raycasts; routes registered via
  shooting.ts's `registerTreeRoutes`; `__boots.trees()` dumps live state.
  11 headless tests on the pure helpers.
- **Remount healing (game-root.tsx)**: a mid-session ActiveGame remount
  (Fast Refresh during fleet syncs) used to snapshot a world whose walls
  were still session-hidden — "the building vanished" QA burn. Now: on
  unmount-while-live the hidden-object ledger restores early, and a mount
  effect re-collects once if the render-time snapshot saw zero walls.
- **Wiring**: `prevoxelizeTick`/`dustDebug` direct imports; `boards()`
  documented as a sheets alias (sheets ARE the drywall plates);
  `overlayRoots` flipped to required on GameWorld (all fixtures updated);
  sky pole cap kills the zenith banding and doubles as the overhead
  light break (warm gray, never blue).

Open for QA (round 4 gate): re-verify (g) volume islands (fixed at the
root, needs the in-browser repro), (d) trees full loop in-browser, and
the in-game-vs-editor fps ratio watch item now that grass + prevoxelized
walls + the grove render from session start.

## Phase 3, Round 4 — 2026-08-25 (QA + wiring verification pass, instanceColor fixes, overlay-hide hardening)

Round outcome: verification round. QA round 3 = FULL PASS (22/22 steps,
zero pageerrors) and wiring's four-item verification pass = PASS on real
GPU. Manager integrated the round's two code streams and fixed the one
new finding. All in: `bun run check-types` clean, `bun test` green.

- **QA r3 (all owner items green in-browser)**: (a) pre-voxelized
  cladding at spawn, zero shots; (b) sandwich tear — flat drywall plates
  flutter off, studs snap like charcoal sticks, through-hole from
  behind; (c) rotary gun on its own second table behind spawn, 120-shot
  sweep leveled the building (dust at caps); (d) trees ignite/char/snap
  to stump AND fell-by-trunk; (e) 3x3 mask pocket renders + Keep maps it
  to a real window node; (f) sky warm gray, blueness −6, breaks visible,
  pole banding gone; (g) island line-cut collapses same-frame; (h) Esc
  restore pristine. fps: editor 60.0 → in-game 60.1 on real hardware
  (vsync-capped, loadavg ~8) — the owner's fluidity is intact.
- **Wiring r4 verification**: trees full loop headless (fell→stump,
  ignite→char→snap→stump); volume islands PROVEN in-browser — severed
  table legs (band emptied around all 4) crumble the top within ~0.4 s,
  and the shower repro (cut in half) drops the upper half. p3r2's
  "floating top" was under-severed legs (voxelized legs rasterize ~2
  cells wide), not the bug. Remount: Turbopack hard-ignores node_modules,
  so mid-session fleet syncs CANNOT vanish the building on this server;
  the r3 healing path stays as a dormant safety net.
- **instanceColor fixes (debris.tsx / trees-destruct.tsx / dust.tsx)**:
  the host WebGPURenderer compiles a mesh's pipeline on first draw; a
  mesh whose FIRST `setColorAt` lands mid-session gets a pipeline
  without instanceColor and renders white forever. Debris now primes all
  768 slots at mount, charred branch sticks color every slot in
  syncInstances, and dust primes both pools in initMesh — tree bursts /
  table rubble / dust now read in material colors (this was also QA r3's
  "pale char-collapse" watch item).
- **Overlay-hide hardening (world.ts / game-root.tsx, + owner feedback
  B "a face that can't be destroyed")**: overlay kinds now swept by
  `bones:` PREFIX (future bones engines can't resurrect the ghost face),
  name predicate exported as `isOverlayName` over OVERLAY_NAME_PREFIXES,
  OverlaySweep runs for the whole session (a bones renderer REMOUNT
  re-registers fresh visible roots — the old 2s window missed those),
  and `__boots.countCoplanarSuspects()` is a read-only tripwire QA can
  assert is 0 in-game. 6 new tests pin the predicates + probe
  (overlay-hide.test.ts).

- **Grass off the pavement (world.ts / nature.tsx, concurrent worker)**:
  `collectRoadFootprints` gathers hard-surface XZ footprints — every
  Streetscape `road-*` surface mesh (exact projected triangles, with
  preview/hit/bridge/earthwork meshes excluded) plus flat ground pads
  (slab/item/block under 0.35 m thick near y 0, e.g. driveways and
  parking pads) — and `scatter()` rejects samples within 0.3 m of any
  (`pointOnRoad`, AABB pre-filtered). Trees inherit the rejection since
  trees-destruct builds on the same scatter. 13 tests
  (road-scatter.test.ts).
- **bun test rescue (bunfig.toml + src/test-preload.ts, manager)**: the
  prod hotfix's `useEditor`/`useViewer` imports in session.ts made six
  test files load @pascal-app/editor|viewer for real under bun — viewer's
  dist pulls `three/examples/jsm/Addons.js`, whose TTFLoader/LottieLoader
  use CDN URL imports bun can't resolve offline (ENOENT), and the
  src-only editor package graph pinned `bun test` at 100% CPU for an
  hour (six zombie runners killed). Test-only preload now mocks both
  packages with zustand-shaped stubs; the host bundler keeps the real
  imports. Suite: 158 pass / 7001 expects in ~0.7 s.

Open: exercise countCoplanarSuspects + overlay hiding against a REAL
Bones-installed scene in-browser (fixtures so far had overlayRoots 0);
owner feel-pass on the char-collapse burst now that colors land.

## 2026-08-25 — Phase 4 round 1: hammer / grenade / ADS / theatre (manager stitch)

Combat + world groups landed in parallel; the manager pass wired the seams:

- **Slot 6: the warhammer** (weapons.ts `smashRadius` 0.55 + arsenal def,
  weapon-models WarhammerModel, viewmodel two-phase wind-up→slam swing with
  the hit resolving at impact, shooting.ts smash routing: crater +4–6 rim
  nibbles + area knockback via smashKnockback). `'hammer'` added to
  store.ts WeaponId — both `as WeaponId` bridge casts deleted.
- **THE MEGA-GRENADE** (grenade.tsx): G throws everywhere (builder undo
  lives on Z), arc + single bounce, 2.5 s fuse with beeps, radius-3.2 carve
  (fallback path until destruction.damageExplosion lands), bot fling,
  playerRig.shake kick, dust storm. Manager wiring: `<Grenades world/>`
  mounted in game-root's ActiveGame, HUD pip driven per frame from the
  component (`hud.grenadePip`), viewmodel's opaque dynamic-import bridge
  flipped to a static `import { throwGrenade } from './grenade'`.
- **ADS (RMB, pistol/rifle)**: viewmodel writes playerRig.ads (±12/s) and
  now drives `hud.setAds` (crosshair ticks→dot morph); player.tsx lerps
  FOV 92→60 + scales sensitivity; shooting.ts aimDirection now cuts spread
  ×(1−0.75·ads) — the accuracy payoff existed nowhere before this pass.
- **Siren countdown theatre** (guntable.tsx): boots pair + warhammer on the
  tables, rear pickup grants minigun+hammer, siren beacon spins its
  `beacon-light` head ~7 rad/s + red point light + sfx.sirenLoop — now
  gated on the landed `waveState.countdownActive` flag (fallback expr
  removed).
- **Material dust routing** (destruction.ts → dust.tsx): wall carves +
  sheet fly-offs emit kind `'drywall'` (puff, upgrading to plume+haze when
  heavy), plain volumes emit `'concrete'` (half-size gray), framing hits
  emit nothing (wood = splinters from debris alone — shooting.ts chip
  dropped for segments). shooting.ts's local DustOpts façade widened to
  the material union.
- **Copy/keys coherence**: panel.tsx Controls now lists 6 hammer, RMB aim,
  G grenade, R rotate, Z undo; hud.ts controls pill already matched;
  destruction.ts G-undo comment → Z-undo.

Suite: 206 pass / 0 fail, tsc clean. STALLED from round 1 (specs handed to
round 2): collapse agent's skeleton collapse + `damageExplosion` export
(grenade currently runs its fallback carve in-game), trees-host scope.

## Phase 4, round 2 — manager integration pass (2026-08-25)

QA p4r1 gate: FAIL on exactly one item — skeleton collapse (f). Everything
else passed (hammer, grenade, ADS, bot wall rule, siren theatre, tables,
R rotate, instant voxel-clad, material dust, Esc restore, 0 errors,
120 fps steady). This pass closes the gate item + every seam the group
briefs flagged.

- **Skeleton snap (QA f fix)** (destruction.ts): a wall whose cladding
  hits ZERO live voxels can no longer keep its bare frame floating —
  every remaining segment snaps top-down staggered across ~1.5 s
  (`maybeSkeletonSnap`, armed from damageTarget, island crumbles, sheet
  fly-offs, and the 30%-support avalanche bands; timers cleared in
  resetDestruction). Rounds out the round-2 structural-collapse work
  already in tree (30%-support chain rule + hanging-stick drops,
  debounced 160 ms after segment breaks).
- **damageExplosion landed** (destruction.ts): the export grenade.tsx has
  feature-detected since round 1 — full-depth center carve + 5 ragged rim
  nibbles per destructible collider group in radius, framing segments
  inside the blast snap (cap 48, arming the support check). Returns total
  voxels removed. Grenade detonation now takes the real path; its
  fallback stays for older checkouts.
- **Glass vs grenade** (grenade.tsx): flight steps sweep world.glass —
  a pane crossed mid-arc SHATTERS and the grenade flies on (QA feedback:
  it used to sail through glazing untouched); on boom every pane inside
  the 3.2 m radius shatters (shatterPane is idempotent).
- **Windows shootable** (shooting.ts): 'window' joined DESTRUCTIBLE —
  window FRAMES voxelize + carve like any solid (world.ts routes glass
  meshes to world.glass, never into colliders, so only the surround is
  affected). No more sparks-only dead window bands. Mirrored in
  destruction's EXPLODABLE + grenade's fallback set.
- **hud.ghostStatus wired** (builder.tsx): the documented-but-unwired
  build-ghost status line under the crosshair now runs —
  `ghostStatus?.(occupied ? 'occupied' : null, 'builder')` per frame,
  cleared on deactivate/edit-mode/unmount. (Grid-locked phase-5 builder
  can upgrade the call to the full TargetResult.reason when it lands.)
- **Warhammer display visibility** (guntable.tsx): QA flagged it nearly
  invisible flat behind the minigun — it now LEANS against the rear
  table's +x end, pommel on the floor, head crowning just above the
  tabletop in the spawn sightline.
- Checked, already coherent (no change needed): playerRig.ads/shake
  wiring, siren countdownActive flag, KeyZ undo / KeyG grenade / Digit6
  hammer bindings, panel.tsx Controls copy, instant-voxelize placement,
  dust material plumbing ('wood' emits nothing), commercial-name sweep
  (clean; 'war hammer' is the generic weapon term, user copy says
  'hammer').

Tests: destruction/grenade/shooting suites green including 3 new tests
(explosion carve, blast isolation, staggered skeleton snap). Full-tree
tsc/test pending the phase-5 builder agent's in-flight rewrite of
builder.tsx (their errors, their files — recheck before ship).

## Phase 5, round 1 — Build Grammar v2 lands (2026-08-26, manager stitch)

The ghost is SLOT-LOCKED. Four agents + manager wired the whole v2 contract
(REVIEW-binding) on top of the shipped grid.ts/support.ts foundations:

- **ghost-targeting** (builder.tsx/.test.ts): rawGhost/resolveSnap/aimHeightAt
  and the old snap constants are gone — one authority per frame,
  `grid.resolveTargetSlot` (reused input, no hot-loop allocs). Ghost renders
  at the slot pose ONLY; blue/red = TargetResult.valid; failing reason feeds
  hud.ghostStatus. R = rotState 0..3 (wall far-edge flip / roof ascent /
  floor no-op), resets on piece-TYPE switch only. Turbo: press 0.15 s, held
  new-slot ≥0.05 s, per-hold dedupe Set, died-slot lockout. Placement →
  registerPlacement (registry refusal rolls the store back); Z-undo →
  onPieceRemoved. PlacedPieces owns session wiring: scene-support probe
  (skips `__boots-piece-*`; disabled colliders defer to live voxels in the
  slot AABB +0.35 m), collapse listener (removePlaced + debris + crumble),
  resetPieceSlots on unmount. builderDebug.ghost() exposes slot poses for QA.
- **support-hooks** (piece-slots.ts NEW + support.ts): the single occupancy
  authority — slotId ↔ pieceId 1:1, SupportGraph over grid.slotsTouching,
  memoized isSupported (occupied → BFS, empty → terrain ∨ scene probe ∨
  supported neighbor), onPieceRemoved = THE removal entry point, BFS-ring
  cascade at 50 ms/ring via onCollapse, died-slot lockout (150 ms) stamped
  on undo/destruction/cascade, cleared on re-fill. flushCollapse for
  teardown/QA.
- **store-keep** (store.ts, keep.ts + tests): PlacedPiece.slotId? (legacy
  pieces render-only, off-graph); addPlaced returns the stored piece;
  removePlaced(id) for cascade eviction anywhere in the list. Keep now
  ATTEMPTS real slab nodes for floors (3×3 world footprint, yaw-rotated,
  schema-parse guarded — skips like roofs, never throws); walls/roofs
  untouched; keep tests round-trip REAL @pascal-app/core schemas.
- **hud-panel** (hud.ts, panel.tsx): hud.ghostStatus(reason, owner) — red
  line 16 px under the crosshair ("needs support" / "occupied" / "too far"),
  owner-keyed, change-gated, type-aliased to grid's TargetResult reason.
  Panel copy: the mandated grid/ceiling/R/ramp-chain sentence verbatim;
  shortcuts deduped.
- **manager stitch**: the two unowned destruction seams —
  settleSupportAfterRemoval funnels EVERY voxel-removal path (carve, island
  crumble, avalanche bands, sheet fly-offs, dropTarget): a placed piece
  carved to zero voxels runs the exact undo cleanup (store removal → unmount
  splices collider + drops replica → onPieceRemoved lockout + cascade);
  scene carves fire a 160 ms-debounced notifySceneSupportChanged so pieces
  propped by demolished scene geometry fall. +2 integration tests
  (builder.test.ts). Also fixed a float-boundary flake in the lockout test
  (stamp+150 exact-edge assert rounds below the window at big
  performance.now values).

Landed alongside (parallel owner pass, committed separately): carve splash
chips framing (chipSegmentSplash, hp-1 floor). Suite: 307 pass / 0 fail,
tsc clean, real exit codes checked. Known QA-watch items: no budgeted
placement-voxelize queue (turbo worst case ~20 ensureVoxelTarget/s), panel
copy still says floors stay game-only (Keep now attempts slabs).

## Phase 5, round 2 — turbo clad budget + Keep toast truth (2026-08-26, manager stitch)

Two workers this round; both landed clean on top of the overnight owner
commits (quaternion-grid basis, E-interact, Phase A stacked levels).

- **ghost-targeting** (builder.tsx + builder.test.ts): the REVIEW's perf
  risk closed — requestPieceClad replaces the raw ensureVoxelTarget call in
  PlacedPieceMesh's layout effect. Gap ≥ CLAD_BURST_MS (125 ms, between
  TURBO_FIRST 150 and TURBO_NEXT 50) with no backlog → instant bricks
  (single clicks unchanged); otherwise a head-index FIFO (dedupe per
  nodeId, backlog captures slow newcomers so order beats freshness) that
  PlacedPieces drains CLAD_DRAIN_PER_FRAME=2 per frame (~120/s vs 20/s
  worst case). cancelPieceClad on unmount — a drained slot never clads a
  dead entry; already-clad pieces (bullet-hit damageTarget) no-op.
  Deferred pieces keep the plain solid mesh: visible, collidable,
  shootable. resetCladQueue in session teardown. +7 tests.
- **hud-panel** (panel.tsx): Keep toast now surfaces result.floors; wall
  count fixed (kept counts roofs/floors too — walls = kept − roofs −
  floors); keep-note copy matches keep.ts slab semantics (full slabs only,
  3×3 partial edits deferred). hud.ts audited, no changes needed.
- **manager**: seams audited (KeepResult.floors exists; PlacedPieces
  mounted in game-root drains + resets the queue; no host wiring). Brand
  grep clean. tsc exit 0; bun test exit 0 — 369 pass / 0 fail, 26 files.

Carry-over from p5r1 QA (gate c FAIL, still open — grid.ts untouched since
ad1b970): slotsTouching 'R' has no cross-storey R↔R adjacency, so ramp
chains read unsupported (flat sawtooth); movement can't walk the plank; and
keep.ts roof→roof-segment conversion silently skips (all 8 roofs skipped in
QA). Round 3 tasks dispatched: ghost-targeting owns the grid adjacency +
ramp-run targeting + slope walk; store-keep owns the roof-segment debug.

## Phase 5, round 3 — ramp chains hold + host defaults untrusted (2026-08-26, manager stitch)

Gatekeeper found the repo quiet; ghost-targeting stalled (2nd stall →
hand-built per protocol), store-keep landed.

- **manager (hand-built ghost-targeting scope, grid.ts + grid.test.ts)**:
  p5r2 QA gate c root cause closed — slotsTouching's R-case now carries the
  4 storey-diagonal roof↔roof neighbors per axis (R:i±1,k,s±1 /
  R:i,k±1,s±1): a ramp's high edge at y=2.8·(s+1) is real contact with the
  next cell's ramp one storey up. Symmetric by construction (mirror pairs
  in each expansion); feeds BOTH candidate support (piece-slots.isSupported
  on empty slots) and the collapse BFS through the one shared function.
  +1 regression test (R:12,8,1 ↔ R:11,8,0 etc, QA's exact failing slots);
  the existing symmetry sweep covers the mirrors. QA's ramp-run targeting
  trace already picked the right s+1 slots — support was the only lie.
  Slope-walk: placed ramps are live colliders, 43° → normal.y ≈ 0.73 >
  0.55 ground threshold; live re-verify is on next QA.
- **store-keep (keep.ts + keep.test.ts)**: p5r1 gate-g roof skip solved —
  the live host's roof-segment defaults() THROWS on every call (stub id
  'roof-segment_default' fails core's rseg_ template check), so
  def.defaults?.() inside the try guard-skipped 8/8 roofs. New module-
  private safeDefaults (try/catch → {}) at all 4 defaults sites; schema
  field defaults carry the parse. "HOST DEFAULTS ARE UNTRUSTED" doc block.
  +2 regression tests against the REAL RoofSegmentNode schema with the
  host's throwing defaults() verbatim (RED pre-fix, GREEN post).
  UPSTREAM BUG to report: host roofSegmentDefinition.defaults() throws for
  ALL callers — palette/tool creates of roof-segment likely broken too.
- **manager**: hud.ts ghostStatus doc block synced to the grid-locked
  caller. Seams audited (single slotsTouching feeds support + collapse;
  keep bridge untouched). Brand grep clean. tsc exit 0; bun test exit 0 —
  375 pass / 0 fail, 27 files.

Open for next QA: gate c live re-run (run up ramps holding place). QA's
secondary finding stands: pieces die only at aliveCount === 0 exactly
(destruction.ts settleSupportAfterRemoval) — bulk fire strands ~9–22
straggler bricks; a <3 % alive death threshold or island sweep would fix
d/f playability.

## 2026-08-26 — phase 4 round 3, manager stitch

Round shape: COMBAT group produced nothing (collapse agent stalled — its
QA item "skeleton-collapse verification on real scenes" re-queued);
trees-host stalled too. WORLD QA gate FAILED on two verified runtime bugs;
both fixed here by the manager:

- **game-root.tsx ResurrectionSweep hosted-children fence (QA p4r3 bug 1)**:
  the ~0.5 s resurrection sweep used a bare `root.traverse` — on a
  voxelized wall it descended into the wall's NESTED registered door/
  window/item roots and ledger-hid them, so live windows and doors
  vanished half a second after jump-in. Now sweeps through the exact same
  lane collectWorld uses: `collectMeshes(root, collectSolidRoots())` —
  both newly exported from world.ts (the fence set is rebuilt per 2 Hz
  sweep so mid-session registrations fence correctly).
- **world.ts collectMeshes material-visibility filter (QA p4r3 bug 2)**:
  windows ship full-rect interaction HITBOXES as `mesh.visible = true`
  meshes whose MATERIAL has `visible = false`; three.js never renders or
  raycasts those (Mesh.raycast bails), but our mesh.visible-only check
  collected them as solid 'window' colliders that ate every glazing shot
  and grenade pass. New isMaterialInvisible predicate (array materials:
  all-invisible ⇒ skip) wired into collectMeshes — hitboxes never become
  colliders, glass, or sweep victims. Landed together with fix 1 so the
  sweep can't re-hide the freed panes.
- **world.ts collectSolidRoots + GameWorld.solidRoots**: fence builder
  extracted + exported; collectWorld now also returns the fence on the
  snapshot (`world.solidRoots`) for future consumers.
- +2 regression tests in world-hosted-children.test.ts (hitbox never a
  collider/glass; fenced sweep returns only the wall's own mesh).
- Seam audit: KeyZ undo / KeyG grenade / Digit6 hammer consistent across
  input.ts, builder.tsx, viewmodel.tsx, panel.tsx copy; playerRig.ads
  writer (viewmodel) / reader (player FOV) intact; siren flag
  enemies-state → guntable beacon intact; no stale imports of any
  never-landed collapse API (support.ts exports unchanged). Panel Controls
  copy already lists Z undo, G grenade, 6 hammer, RMB aim, R rotate — no
  edit needed. Brand grep clean in src (docs/RESEARCH.md keeps its
  verbatim OSS repo citations for license attribution).
- tsc exit 0; bun test 377 pass / 0 fail, 27 files (375 + 2 new).

Open for next QA: re-run the two BLOCKED gates with headed browser —
glazing shatter via the glass lane and grenade mid-flight + 3.2 m
detonation shatter (aim pane QUARTER points, not centers; script
/tmp/boots-night/p4r3/qa3.mjs). Open design call (builder's latent gap):
transformPlaced keeps the old wall slotId when an edit-exit turns a wall
into a ramp — ramp stays registered on the W slot, the overlapping R slot
stays placeable, ramp pose is off the R lattice. Re-queue: skeleton
collapse on real scenes + owner feel-pass on char-collapse burst
(GRAND-PLAN line 65 / MASTERPLAN T4); trees-host scope untouched.
