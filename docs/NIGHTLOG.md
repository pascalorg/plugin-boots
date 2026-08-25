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
