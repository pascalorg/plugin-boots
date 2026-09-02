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

### P4R3 manager QA re-run (post-fix, headed, /tmp/boots-night/p4r3/qa3.mjs)

PASS: setup, c-ghost-occupied, a-glazing-lane (glass,glass,glass,none — the
previously BLOCKED gate; window hitbox fix confirmed live), i-exit ×2,
j-pageerrors 0, j-console 0.
b-grenade-flight: core spec PROVEN (pre-check glass → grenade crossed the
pane plane at +0.37 s → instant re-check non-glass = shattered mid-flight →
boom +2.65 s, carve 431). Flagged FAIL only on the script's stale
`wallsUnchangedAtCheck` (walls −4 tolerance): the probe pistol shot now
flies through the freed sash and tears the interior wall (tearRadius
0.45 m ≫ 4 voxels) — pre-fix it was eaten by the hitbox. Recalibrate.
b-grenade-detonation: FAIL is a lob-placement artifact — the grenade
rested 4.12 m from the glazing point and the pane correctly SURVIVED
(post-check glass), which demonstrates the ≤3.2 m radius rule's negative
half; pre-check 'wall' raced the early-session window-pocket carve. The
positive half (pane shatters when the boom is within 3.2 m) still needs a
verified run with the lob landing on the player's side ~1.5 m from the
pane. Queued for feedback next round.

### QA round-2 item 3 (door lane) — resolved + re-verified headless

The doorway-never-clears FAIL decomposed into three stacked causes, each
now fixed and verified:
1. collectWorld's wall sweep baked the closed leaf/frame into the wall's
   voxel grid — fixed by the hosted-child mesh fence (f968e01).
2. ResurrectionSweep re-hid nested door/window meshes ~0.5 s after
   jump-in — fixed by fencing the sweep through collectMeshes (83b5160).
3. ensureVoxelTarget's `visible = false` on the wall's render mesh CULLED
   the nested door/window roots (three.js visibility cascades): invisible
   closed doors that still blocked an apparently-open doorway. Fixed in
   5b8be1d: hideForGameKeepingRoots masks (layers 0 — masks don't cascade)
   any mesh on a path down to another live node's registered root
   (world.solidRoots fence) and visible-hides only kept-free branches;
   restore rides the session teardown ledger, hideForGame gained a mask-0
   guard so the sweep can't undo it. +3 planner tests (380 green).

Re-verify (canonical repro /tmp/boots-qa7/run6.mjs, fresh-drawn room +
mid-wall door): closed prompt span [-0.4..0.4]; closed leaf renders and
blocks (identify 2.2 m pair, walk stops); E opens; OPEN identify clear at
span center and ±0.3 (first hits 6.5 m THROUGH the doorway); open
walk-through passes, y flat (no invisible-voxel climbing);
DOOR_RESULT {closedBlocked:true, openThrough:true}. Scene c2cf8aafeb0e:
E prompt + toggle green, countCoplanarSuspects 0, masks stable over 8 s,
shots through open front door carve ZERO wall_s voxels. Residual blockage
at door_bed1/door_bed2 there is fixture authoring (doors centered exactly
on wall junctions — the neighbor wall's uncut end owns half the aperture),
not a game bug.

## Phase 5.5, night round — pieces / overlays / build table / catalog (2026-08-27, manager stitch)

Four disjoint lanes integrated in one pass; full suite 563 pass / 0 fail
(18,225 assertions), `tsc --noEmit` clean.

- PIECES (store/grid/builder/keep/roof-corners): `BuildPiece` split into
  wall | floor | stairs | roof. 'stairs' is the old walkable plank
  (STAIR_TILT pose, R = ascent quarter, chains storey-per-cell, Keep →
  shed roof-segment); 'roof' is the 2×2 corner patch — the ghost now
  renders the real bilinear preset and R cycles SHAPE presets (slope →
  corner-tip → valley → flat cap) with yaw pinned to the facing. Direct
  hotkeys Z/X/C/V pick pieces while the builder is held; undo moved to U.
  Real bug fixed: grid.roofQuarter had the ±Z quarters swapped — ramps
  facing ±Z rose TOWARD the player; all four cardinals now test-pinned.
- EDIT-OVERLAY (edit-overlay.tsx, new): the F-edit 3×3 ghost boxes became
  outlined lattices floating off BOTH piece faces (inset tiles, live blue
  fill / dead red outline, hovered gold with a change-gated pulse);
  corner roofs get a 12-edge wireframe marker set. Manager wired the
  builder.tsx swap + SWIPE CARVING: holding LMB in cell-edit toggles each
  NEW cell the crosshair enters (per-hold dedupe, corner roofs stay
  press-edge).
- BUILD-TABLE (guntable.tsx): third table 2.37 m from spawn, opposite
  side from the gear table — a blueprint-blue display hammer and a
  "START BUILDING" sign ("BUILD AWAY" after pickup). E gives + equips the
  builder only; the wave director keys off pistol/rifle/minigun ownership
  so building stays peaceful. interact.tsx E-ownership extended to the
  third table (the door double-fire class); viewmodel wheel list deduped
  ('builder' entering `owned` used to trap the wheel on it).
- INVENTORY (inventory.tsx / item-place.tsx / item-keep.ts, new): I opens
  the creative-mode catalog over the host's bundled CATALOG_ITEMS (~92
  floor-standing rows, 5 category tabs, ≤32 cards each; mouse + keyboard).
  Picking arms an aim-anchored half-ghost GLB (R turns, LMB places, RMB
  stows, weapon switch stows); placements are game-only fixtures (one
  box collider each — bullets spark, never voxelize) until the sidebar
  Save runs item-keep's schema-parsed createNode pass (Discard forgets).
  Failed GLB loads degrade to labeled proxy boxes. input.ts gained the
  menuOpen latch (keydowns route to the menu, pointer/wheel pass through
  to the DOM; the backdrop swallows clicks so the host still sees none);
  session.ts skips the deliberate pointer-lock release while the menu is
  open and folds placed items into pendingDecision.
- Manager wiring beyond the lane diffs: hud.ts keybind bar (R rotate/
  shape · U undo · I catalog), panel decision copy + Save/Discard call
  sites + controls text, GameItems mounted in game-root.

Deferred / follow-ups: docs/BUILD-GRAMMAR-V2.md still describes the
3-piece grammar + the old roofQuarter comment (refresh next round);
KeepResult.roofs counts stairs+roofs together (split counter someday);
legacy corner-less 'roof' pieces keep the plank fallback; Draco/KTX2
catalog GLBs fall back to proxies until host decoders are wired; QA
should sight-check the build-table hammer rake and the overlapping
build/gear prompt circles; optional makeSceneSupportProbe '__boots-'
prefix widen (tall furniture can prop an upper build slot) left as-is.

## Phase 6 round 1 — switch wall / real items / perf / ramp fixes (2026-08-27 night, manager stitch)

Four disjoint lanes integrated in one pass; full suite 610 pass / 0 fail
(19,842 assertions), `tsc --noEmit` clean.

- SWITCH-WALL (enemies-state/enemies/guntable): combat is now OPT-IN.
  Gun pickup NEVER triggers waves — the wave director is a pure state
  machine (`tickWaveDirector` in enemies-state.ts, allocation-free
  DirectorStep) armed ONLY by `armWaves()`, which fires from the new
  SwitchWall fixture: a concrete stub + steel cap 3.4 m forward / 2.2 m
  lateral of spawn (gear-table side), wearing a two-hand industrial
  breaker (twin arms + red cross-grip, 0.4 s sweep chasing
  `waveState.armed`), "PUT YOUR BOOTS ON" placard and twin siren beacons
  (the single red pointLight MOVED here from the gear table). E throws
  the breaker → latch clunk → the existing countdown theatre runs
  unchanged. Gear-table sign: GEAR UP → YOU ARE COOKED; its E grants
  gear only. `resetBots()` swings the handle back up. Opt-in invariant
  pinned: owning pistol+rifle+minigun for a simulated 60 s produces zero
  director events and zero bots (enemies-waves.test.ts).
- ITEMS-REAL (item-place/destruction): catalog GLBs now LOAD in prod —
  the bare GLTFLoader threw "No DRACOLoader instance provided" on every
  Draco-compressed system-catalog model and everything degraded to proxy
  boxes; `itemModelLoader()` wires DRACOLoader (gstatic 1.5.5 decoders)
  + MeshoptDecoder per session (KTX2 deliberately unwired — no catalog
  GLB needs it). Item destruction wears the material: voxelize-time
  `sampleItemCellColors` gives each cell the dominant tone (material
  color × 8×8 map average, group-resolved multi-materials, volume
  tiebreak so detail shells win) of its nearest sub-mesh region;
  `target.baseColor` becomes the palette average; `cellTint` feeds
  debris in carves/crumbles/collapses. Silhouette pinned: item grids are
  surface-traced at 0.055–0.11 m (L-shape test — no AABB fill).
- PERF-FIXES (shooting/warmup/audio/probe-memo/dust/debris): fire() got
  a ray-vs-worldBox broadphase before any BVH touch (kills the shot-#1
  build-every-BVH freeze, ~95 % distance-cull steady-state);
  PipelineWarmup drains remaining lazy BVHs at 4 ms/frame after the
  material pass and pre-warms the crater dirt + scorch decal pipelines
  with craters.tsx's real geometry builders; `sfx.prime()` moves the 48k
  noise-buffer fill + voice-path compile into the Jump-in gesture; new
  probe-memo.ts (0.5 m XZ buckets / 1 m Y bands / 400 ms TTL, packed
  numeric keys) memoizes dust floor probes and debris apex probes with
  an 8-miss/frame cap.
- RAMP-FIXES (grid/hud/builder): R slots (stairs/roof) march the aim
  ray's successive cells world-aware — first PLACEABLE cell wins, so one
  placed ramp no longer dead-ends every later aim as "occupied"; beyond
  ±PITCH_BAND a crossing disagreeing with the aim intent bumps one
  storey from the player's (no double-bump). HUD keybind bar is
  weapon-tracked (builder shows the full piece/cycle/edit/undo set) and
  mount() upgrades captions via navigator.keyboard.getLayoutMap() so
  AZERTY players see the keys their physical positions actually are.
  STAIR geometry documented (4.1 m at ≈43°: STOREY 2.8 ≠ CELL 3).
- Manager wiring beyond the lane diffs: voxel-walls.tsx consumes
  `wall.cellColors` per instance (item voxels wear their region tone,
  same jitter); dust.tsx `tint` opt + destruction call sites (item dust
  blends 65/35 toward concrete gray); destruction B2 settle jitter
  (round-robin 0–150 ms so multi-node blasts' crumbles/structure checks
  don't coalesce — two test waits widened 240/260→450 ms) + B5 indexed
  removedQueue pushes (spread-push argument-limit landmine);
  `sfx.breakerThrow()` (low thunk + metallic snap + contact buzz,
  louder than doorLatch) swapped into the SwitchWall throw;
  `<PipelineWarmup world={world} />`; panel controls copy rewritten for
  opt-in combat.

Deferred / follow-ups: PROD PIN is the real ramp outage (pins 54 commits
behind, no 'stairs' piece at 7f5b912) — needs a host release-PR bump;
optional e.key piece-hotkey fallback for Firefox/Safari AZERTY captions;
turbo slow-hold double-place (per spec — revisit if the owner hits it);
STOREY 2.8 vs real 2.5 m host levels + world-aligned grid vs rotated
buildings (design-level); community `file:` dep can nest npm 0.9.1 under
the plugin locally (prod unaffected); QA scripts that gear up and wait
for waves must now throw the breaker (`armWaves()` from enemies-state).

## Phase 6 fix round 1 — in-game placements break for real (2026-08-27, manager)

QA P6R1 was GREEN except Gate D as literally specified: shooting a
just-placed catalog item only sparked. Root cause: PlacedItemMesh
registered ONE invisible Box3 proxy collider with nodeType 'fixture'
(not destructible). QA's suggested one-word flip ('fixture'→'item')
would have been WRONG twice over: ensureVoxelTarget collects a node's
collider meshes as its voxel sources, so it would have voxelized the
featureless invisible box (box silhouette, palette sampled from the
box's blank material) while the real GLB stayed visible next to the
voxels.

Real fix (item-place.tsx only): placements now register their REAL
sub-meshes as colliders — the collectWorld convention for saved item
nodes. mountItemVisual grew an `onContent` callback (fires on the
immediate proxy show AND the async GLB swap; ghost passes nothing);
PlacedItemMesh (re)registers one ColliderEntry per solid sub-mesh with
nodeType 'item', LAZY `get bvh()` (never builds GLB trees at placement
time), glass-like sub-meshes skipped exactly like collectWorld (the
in-game glass lane stays the phase-6 open item). Swap/unmount releases
entries by identity + dropTarget(nodeId) — a GLB landing over a shot
proxy, or Save/Discard, never leaves carved voxels of the old shape.
The invisible box mesh is gone; the proxy box (load pending/failed) is
itself the collider, so degraded placements stay solid and shootable.
Result: shooting an in-game placement voxelizes through the SAME
silhouette + per-cell material-palette lane QA already proved on saved
item nodes (hideHostNode hides the GLB and disables the entries in the
same tick).

Non-blocking QA notes carried, not changed: wall-top R-slot pitch-band
feel (mid-pitch aims resolve ground slots beside a wall top) and the
gear/build/switch grab-disc proximity (~1.0–1.5 m, nearest-untaken
arbitration held) — both logged for the owner's feel pass.

610 tests / 19.8k assertions green; tsc clean.

## Phase 6 round 2 — paint feel + lag recorder (2026-08-27, fleet round 3, manager stitch)

Four lanes launched, two survived. ROOF-CLIP and COLORS+CEILING died
leaving zero files in the tree — nothing to salvage, nothing to revert;
their cross-file wiring requests (roof-planes re-exports, paint serial
clear) had no deliverables behind them and were skipped. Both requeue.

PAINT-FEEL (paint.tsx + paint.test.ts):
- Fixed SPLAT_RADIUS retired for pure `splatRadiusAt(distance)` —
  clamped quadratic ease-in, r = 0.12 + 1.28·t², t = clamp((d−1)/7, 0, 1).
  ≤1 m paints exactly one 0.15 m wall cell (legible writing strokes);
  ≥8 m blooms to 1.4 m. sprayPaint records the true hit distance
  (voxel-skin wins update bestDist, misses null it). Manager decision:
  PAINT_RANGE 7→9 m KEPT so the 8 m broad-cone anchor is reachable —
  flag to the owner if the reach change reads wrong in play.
- The can shows its color: valve-collar cap ring in the live palette
  color + enlarged label band wearing a "PRESS R" CanvasTexture
  (palette background, rec-601 contrast ink via `paintLabelInk`; band
  rotated π off the cylinder UV seam). Texture cache is a module Map
  gated on palette membership, built per coat, never per frame, never
  disposed (dust-texture idiom); frame loop swaps material.map only on
  hex change — no shader recompile, zero per-frame allocations.
- Writing-mode HUD prompt: `WRITING_DISTANCE = 2`, pure `paintPrompt` —
  actively spraying a surface hit < 2 m flips the owner-keyed
  hud.prompt line to 'WRITING MODE — R next color' (feature-detected;
  no hud.ts or viewmodel.tsx changes needed).

LAG-RECORDER (perf-monitor.ts + 16 tests):
- createFrameStats: injectable-clock pure factory; Float32Array(3600)
  ring (60 s @ 60 fps), exponential mean (alpha 0.02) seeded by frame 1;
  spike = delta > max(3× rolling mean-before, 50 ms), log capped at 200.
- Spikes tagged by the most recent perfEvent(name) within 500 ms wall
  clock. Singletons: perfEvent (two writes, safe anywhere), perfSnapshot
  ({frames, mean, p95, worst, spikes} — copies, never live refs),
  perfReset. PerfMonitor: the one useFrame subscriber (priority 0),
  resets on mount, console.info dump on session exit.
- Manager wiring: PerfMonitor mounted in ActiveGame; `__boots.perf()` +
  `__boots.perfReset` handles; perfEvent call sites in grenade.tsx
  (grenade-boom), viewmodel.tsx (minigun-trigger, once per spin-up from
  rest), destruction.ts (voxelize, after cache-hit/roof-group early
  returns), builder.tsx (clad-drain, only when work drained),
  item-place.tsx (item-load, on GLB ready), enemies.tsx (wave-spawn).

634 tests / 19,948 assertions green; tsc clean; both real exit codes 0.

## Phase 6 fix round 2 — roof clip / roof color / ceiling carve (2026-08-27, manager)

QA round post-50bceea: A/E/F PASS, B/C/D FAIL — the three dead-lane
features. Manager fixed all three directly (minimal diffs):

ROOF CLIP (B — roof-framing.ts + roof-planes.ts):
- enumerateRoofPlanes now packs each plane's FOOTPRINT triangles into
  `polyTris` (plane space, across from the eave center / upSlope from
  the eave — re-based after the extents pass).
- buildRafters clips every rafter line to that polygon: per-line
  eave→ridge span via `footprintSpan` (edge crossings of the vertical
  line, rake lines sampled 1 mm inside), lines shorter than 0.15 m
  dropped. Hip triangles get varying jacks and NO rake-edge lines; no
  stick top can pass the polygon's upper edge (the QA "tops 2.24 m vs
  ridge 2.01 m" overshoot is structurally impossible now). Ridge boards
  clip to the footprint's upper-edge across-span (`topLen`/`topMid`) —
  hip ridges stop floating past both hip ends. No polyTris = the old
  rectangle, bit-identical (pinned by test).

ROOF COLOR (C — destruction.ts + voxel-walls.tsx):
- The dead lane's roof-planes.ts tone rig existed but nothing wired it:
  voxel-walls now registers the live renderer (setRoofTextureRenderer
  via useThree gl), and buildRoofPlaneTargets calls resolveRoofSkinTone
  — the async GPU readback that covers the host's compressed KTX2
  shingle maps (white base color, so the sync sample stayed white).
- New VoxelTarget.skinRevision: tone lands → baseColor.copy + bump;
  VoxelWallMesh re-primes the skin layer once (primeSkin extracted from
  the mount effect; one number compare per target per frame otherwise)
  and clears the mesh-side paint gates so drainPaintTints re-coats
  painted cells from the ledger — paint serials never move.

CEILING CARVE (D — destruction.ts entrySkin + shooting.ts):
- Root cause: a synthesized ceiling plate holds ALL its cells in the
  top thickness layer, so an upward shot's DDA point lands EXACTLY on
  the skin-halves boundary — float noise picked the empty bottom half
  and the skin-limited removeSphere deleted nothing (QA: 6/8 silent).
  entrySkin now takes the shot direction and steps half a thickness
  cell INTO the grid before picking the side (grazing shots keep the
  raw halves test). Pinned by a test that fails without the nudge.
- Impact fallback: shooting.ts carve() emits one small chip puff + a
  light voxelCrunch when a voxel hit removes 0 cells (destruction.ts
  emitted nothing on that path, so no double-voicing).

QA recipe corrections for the next round's contract: build palette =
LEFT RAIL (28,78) then img[src*="roof.webp"] at (99,246); roof draft
corners must move down-LEFT/down on screen ((700,420)→(807,683) gives
6.5×3 m); the (1365,107) chevron step is unnecessary — select the roof
then click the visible "Hip" text after the two-click draft.

639 tests / 20,115 assertions green; tsc clean; real exit codes 0.

## Phase 6 round 3 — first-blast hitch + three worktree branches (2026-08-27 night 3, 2 lanes + manager)

Profiled root cause of the remaining FIRST mid-house grenade hitch:
391 ms = ~15 dormant-target wakes in ONE frame each mounting a fresh
InstancedMesh + full primeSkin, then 267 ms = island flood-fills +
settle timers expiring behind that long frame and coalescing.

WAKE PRE-MOUNT (voxel-walls.tsx, lane 1):
- Dormant replicas mount HIDDEN at prevoxelize time (group.visible =
  false, host keeps rendering); pipeline warm from frame 1. Skin
  priming for dormant replicas defers through a module queue drained at
  DORMANT_PRIME_PER_FRAME = 2; wake = syncDormantWallFrame (pure,
  exported): visibility flip + primeDormantNow fallback if the queue
  had not reached the target yet. Blast frame cost per wake: one
  boolean write. Paint gates intact (primeSkin clears the mesh-side
  serials; paint's resolveMesh traverses invisible meshes). Unmount
  tombstones keep the drain O(1) past dead replicas; queue cleared on
  VoxelWalls unmount. Debug: dormantPrimeQueueSize().

SETTLE DRAIN (structure.ts + destruction.ts, lane 1):
- Keyed settle-task queue (scheduleSettleTask/cancelSettleTask/…,
  SETTLE_DRAIN_BUDGET = 3 per 16 ms self-rescheduling pump). Logical
  delays + jitter unchanged; only EXECUTION is capped — a 35-40-target
  house drains in ~12-14 frames instead of one macrotask. Riders:
  structure:tick ('keep'), structure:wave:N, island:<nodeId> (140 ms,
  'replace'), framing:<nodeId> (160 ms). Skeleton-snap, blast-ring and
  sceneSupport timers deliberately untouched. Debug:
  settleTasksPending(prefix?). Cascade-cadence tests pass UNCHANGED.

BOOM TRIM (audio.ts + grenade.tsx, lane 2; wiring by manager):
- snapVoiceGate: rolling 120 ms window, first 5 studSnaps voice, 6th
  becomes ONE meatier collapsed crack, rest silent — 48-snap floods
  (~240 WebAudio node chains) drop to ~6 voices. Single shots always
  voice. No wiring needed (destruction calls sfx.studSnap()).
- Blast debris queue: 240 preallocated slots, hex colors, drained
  80/frame by <Grenades/>; explodeAt opens a 0.25 s window. Manager
  wired destruction.ts damageSegment: emit = blastDebrisActive() ?
  queueDebris : spawnDebris for the 4 chips / 2-3 stick pieces / 6
  splinters (~600 inline ring spawns off the blast frame). Gunshot
  breaks keep the inline path. Glass shatter staggered: 2 panes on the
  boom frame, 3 at +40 ms, rest at +80 ms (shatterPane idempotent).
- Dust/crater audited: already budgeted ring-slot writes; left alone.

MERGED WORKTREE BRANCHES (in order, all --no-ff, all auto-merged clean,
suite verified green after EACH):
- feat/gable-residual (45fc91d): enumerateRoofPlanes fills a residual
  out-array (pitch-gate rejects, cluster-cone misses, orphan
  undersides); buildRoofPlaneTargets builds one '<nodeId>#residual'
  volume member via buildVoxelGrid surfaceOnly (open soup — no interior
  fill), tinted by residualSurfaceColor (gable ends read as siding, not
  shingle; async roof retint skips it). Registers in roofGroups like
  any plane: damage fan-out, dormant wake, dropTarget, demolition all
  cover it. Gable ends stop vanishing on first shot.
- feat/smooth-climb (bf535af): placed stairs/roof planks mark
  walkOnClad; voxelize handover keeps the collider capsule-solid as
  walkOnly (movement rides the smooth plane, bullets/paint/melee see
  voxels) until >WALK_ONLY_MAX_DAMAGE (12%) of cells gone, then holes
  get real. moveCapsule step offset 0.35 m with headroom guard +
  velocity restore; grounded velocity projects onto walkable slopes
  (normal.y >= cos 50°) keeping horizontal speed — 43° stairs climb at
  flat-run speed. Bots/grenades keep plain collideCapsule.
- feat/adaptive-storeys (48f3642): session storey LADDER (setStoreyLadder,
  storeyBase/Span/OfY, ladder-aware floor DDA) derived in world.ts from
  post-snap stacked level Ys (top level closes at measured height,
  +3 sky rungs); anchor owns XZ+yaw, ladder owns Y; no ladder =
  bit-exact legacy 2.8 multiples. PlacedPiece.height stamps the slot's
  local span at placement — walls, stair rise/tilt/plank, roof corner
  rise, 3x3 rows, ghost/overlays/support boxes all conform. Keep
  parents each piece to the level its base maps to (fixes the latent
  everything-parents-to-selected-level bug), payloads level-local.

Integration notes: lanes' destruction/structure edits and gable/climb
branches overlapped in destruction.ts + structure.ts — ort auto-merged
all of it and the combined suite is green after each step; no manual
conflict resolution was needed. Re-measure the first-blast spike with
qa-grenade-perf.mjs next session (expect ≤ ~3 settle tasks + ≤2 primes
per frame behind the boom).

731 tests / 20,757 assertions green (was 655 at round start); tsc
clean; real exit codes 0, full suite re-run stable.

## Phase 6 fix round 3 — QA night-3 flagged items (2026-08-28, manager)

QA verdict on cd82556: NOT GREEN — (1) first BIG blast boom frame still
80–119 ms tagged `grenade-boom`; (2) untagged 75–106 ms spikes on a fresh
session's first ceiling/item shots; (3) placed-piece ramps pulse uphill
(0.77–0.88 vs the ≥0.9 gate). Fixes, in dependency order:

CLIMB (3) — two layers deep:
- Layer 1: placed pieces now PREBUILD DORMANT, and collideVoxelTargets
  still collided their coincident voxel grids while the HOST plank
  collider also collided — voxel lips past the plank surface bumped the
  feet. Dormant targets now skip capsule collision exactly like
  walkOnly planks (the host owns collision until wakeTarget hands it
  over).
- Layer 2 (the one the ratio was made of — VELOCITY lied): with layer 1
  fixed, velocity read a perfect 6.5 m/s parallel ride while POSITION
  advanced at ~0.6× in a full/one-fifth/one-fifth frame cycle. Cause:
  collideCapsule pushed ground contacts out along the TILTED normal
  (horizontal advance cancelled), and the step retry's down-settle
  lands GRAZING (distance == radius, never penetrating → "not
  grounded") so the step aborted and the clipped flat slide stood.
  Fix: walkable ground contacts (normal.y ≥ WALKABLE_NORMAL_Y) now
  resolve VERTICALLY (depth / n.y) — the classic character-controller
  ground resolve; walls/ceilings/too-steep faces keep the normal push.
  climb-feel.test.ts's ramp sim now pins the POSITIONAL rate (goal at
  the top, arrive < 1.3 s), not just velocity.
Live gate (qa-night3-climb2.mjs, headed, 3 ascents of the 43° placed
plank): flat 6.502 → best contiguous ascent 6.498, RATIO 0.999 (was
0.755–0.88; gate ≥ 0.9; steady 6.5 through the whole rise, all repeats).

PERF ATTRIBUTION (1)(2) — wired + extended the recorder instead of
guessing: `__boots.dormantPrimeQueueSize` + `settleTasksPending(prefix?)`
(QA drain-bound asserts); `perfEvent('wake <nodeId>')` at wakeTarget,
'teleport' at applyTeleport, 'bvh-build' at bvhFor cache misses;
`perfSection(name, ms)` accumulator (`__boots.perfSections()`) timing
boom rings/glass/crater/segments/debris-drain/settle-drain/prime;
PerfMonitor spike rows now carry `cpu` (addEffect→addAfterEffect span)
and `render` (a wrap around the renderer's own render) + a >30 ms
slow-submit console line with renderer.info counters. What it proved:
the 100 ms first-blast frame was 14 ms of carve + ~95 ms INSIDE the
render submit, on the frame the first wakes flip visible — carve CPU,
wakes (0.4 ms/14) and settle drain (budgeted, ~7 ms over 26 pumps)
were all innocent.

FIRST-BLAST (1), three legs:
- WARM DRAW: a dormant replica primed while hidden uploads nothing —
  its GPU buffers landed on the mass-wake frame. After each budgeted
  background prime the replica now renders ONE frame far underground
  (visible, y −600, 2-frame countdown vs drain/subscriber order, abort
  guard if woken mid-warm) so buffers are resident before any wake.
- STAGGERED RING NODES: damageExplosion's 30/70 ms rings now walk their
  nodes nearest-first at EXPLOSION_NODES_PER_STEP (4) per display frame
  (16 ms steps, "not before" gates keep the ring marks, blastEpoch
  aborts a torn-down session's tail). Bounds carve + wake breadth per
  frame; still reads as one expanding shockwave.
- WAKE-AHEAD: while a stick grenade cooks (~2 s fuse ≈ 100+ frames),
  updateGrenades wakes ONE dormant explodable node near the grenade per
  frame (wakeAheadTick, zero-alloc nearest scan, roof groups resolve
  through their member ids) — detonation lands on already-awake targets
  and the boom frame pays repeat-blast prices.

FIRST-SHOT SPIKES (2): PipelineWarmup's background BVH drain was
one-shot — item GLBs that replace their shot proxies AFTER load pushed
fresh colliders nobody warmed, so the first shot built a Draco-mesh BVH
(the untagged ~106 ms "item window"). The drain now re-opens when the
collider array's TAIL entry changes (pushes append; same-length
splice+push moves it too) — one identity compare per frame while idle.

Headed QA (qa-grenade-perf.mjs, 2×2 house + roof + saved items,
mid-house G-grenade): boom frame CLEAN (no spike at detonation; repeat
blasts worst 10–19 ms). One residual spike remains, moved OFF the boom:
the first HOST CATALOG ITEM wake (~62–68 ms, tag `wake item_…`, once
per session, during the wind-up). Renderer forensics say it is a
monolithic render-submit stall with NO program/texture/geometry count
change and identical triangle volume — not carve, not our buffers
(slab/wall wakes with far bigger replicas are clean, a lone table wake
is free). Next-round lead: host-side interplay when the host's GLB item
meshes get visibility-hidden.

Ceiling regress: clean, no spikes. Discard identity + censuses
byte-identical; zero INVARIANT VIOLATION; zero deduped console errors.
731 tests / 20,757 assertions green; tsc clean; real exit codes.

## Phase 9 — spray / support / drones / juice (2026-08-28 night, fleet 5 lanes, manager stitch)

Five lanes on one tree; four landed, the breakage lane died with zero
output (nothing to salvage — destruction.ts untouched by it; the manager
applied every cross-file diff there instead). 797 tests / 22,305
assertions green; tsc clean; real exit codes.

SPRAY (paint.tsx, dust.tsx, skin-tone.ts NEW, paint-keep.ts,
viewmodel.tsx): P1 mist — tinted cone off the can nozzle each tick,
bounce-back cone at the hit, air puff on a miss (paint DustMaterial
variant: puff shape, x0.35 size, PURE tint, short ttl; reuses the dust
pool, zero allocations). P2 accumulation — the paint ledger packs
(color<<8)|strength per cell; splatFalloff smoothstep feather + COAT_ADD
0.45 + deterministic rim speckle per (cell, serial); drain lerps the
TRUE primed base tone → coat by strength. The per-cell prime color math
moved to skin-tone.ts (primedCellColor) and voxel-walls.tsx now calls
the shared helper — bit-identity pinned by skin-tone.test.ts, so paint
and prime can never drift. P3 feel — wrist-flick shake + can rattle on
R-cycle and draw-in (sfx.paintRattle: 3-5 metallic ticks), nozzle-press
lean while spraying. P4 drips — 48-quad InstancedMesh pool, walls only,
prev strength > 0.75, p 0.25, cap 2/tick, one cached streak texture.
P5 pristine decals — painting NO LONGER voxelizes: pristine hosts get
DecalGeometry splats (plain BufferGeometry + shared standard material,
polygonOffset -4, depthWrite off; 256 global / 64 per node, 1 texture +
<=7 materials, >5k-tri guard falls back to the voxel path); the new
destruction.setTargetLiveListener hook converts a node's decals into
full-falloff ledger coats the moment its replica goes live (awake
voxelize, roof-plane decomposition, dormant wake); paint-keep merges
live-decal votes area-weighted so decal-only nodes Keep correctly.

SUPPORT STRICT (builder.tsx, piece-slots.ts): the scene-support probe's
AABB test is now broad-phase ONLY — the grant is a real BVH-vs-OBB
narrow phase in the grid frame (PROBE_MARGIN expands the slot box as
contact tolerance, never the world AABB); anchor allowlist = structural
node types only (wall/slab/roof/floor/stair/column/door/window family —
items, blocks, fences, props never prop a build); piece-as-unit death:
a placed piece's replica dies whole at <15% alive fraction
(pieceReplicaDead, wired into settleSupportAfterRemoval) — planks
demote to walk-only at 12% damage long before they burst. Pin tests:
a huge host-roof AABB over empty air no longer grants; a killed host
wall drops its propped stack through the debounced sweep.

DRONES REAL (enemies.tsx, enemies-state.ts): drones collide for real —
one drone capsule pass per frame through collideCapsule +
collideVoxelTargets AFTER the altitude lerp and horizontal step (no
more phasing through elevated floors/roofs/pieces); path-aware
avoidance sweeps the actual displacement segment (vertical intent
included) + a wall-top skim probe; descent holds while the corridor
below is blocked; reach is 3D (a drone parked high over the roof is
not "in range"); meleeBlocked gates ALL bot kinds and swings sweep an
exact segment-vs-AABB test — no more damage through a closed door leaf.

JUICE (hud.ts, audio.ts, shooting.ts + wiring): once-per-session
micro-hints above the keybar (builder keys, paint "hold close to
write", RMB-to-aim, catalog after 20 s — suppressed if the catalog
opens first); hitmarker kinds — carve pulse (0.45 opacity, 80 ms) vs
kill flare (warm, 160 ms, OWNS its window so a burst can't stomp the
killing blow) + sfx.killConfirm; viewmodel's legacy double-voiced
hitmarker removed (shooting.ts owns feedback now); WAVE CLEARED center
banner on the alive>0 → 0 edge (death/reset silent); droneBuzz rebuilt
as a low dual-rotor beat-frequency hum with squared distance falloff
(one shared voice by construction); metal items (dominant sub-mesh
metalness > 0.5 at voxelize) throw 3-5 spark streaks + sfx.metalPing
on carve instead of drywall chips.

Manager wiring applied (was cross-lane): sfx.paintRattle in audio.ts ·
voxel-walls primedCellColor adoption · destruction.ts
setTargetLiveListener + 4 call sites, pieceReplicaDead in
settleSupportAfterRemoval, VoxelTarget.metal at voxelize ·
enemies.tsx wave-cleared edge · inventory.tsx hintSeen('catalog') ·
viewmodel.tsx double-feedback removal.

QA leads for next round: headless spray-a-slab pass under the perf
monitor (PaintDecals re-renders its slot map at up to 9 Hz while
actively spraying a pristine node — bounded but unmeasured); host
block/chimney/dormer nodes no longer anchor builds (intended
strictness — verify no E2E scene depended on it); cross-color respray
overwrites the color index while strength keeps accumulating
(spec-literal; cross-fade is a possible follow-up); decal-lane drips
out of scope this round.

## Owner fix round 5 — boom hitch / roof-edge whites / glass plates (2026-08-28, fleet 3 lanes, manager stitch)

Three lanes on one tree, all landed; manager integrated. 897 tests /
23,912 assertions green; tsc clean; real exit codes. Owner-reported
triple from wave-4 play on his REAL house: (a) hitch AT detonation,
(b) white voxel cubes on roof edges over a dark shingle field,
(c) glass breaking into cubes.

BOOM MOMENT (destruction.ts, grenade.tsx, voxel-walls.tsx): profiled on
a new 3×3-room QA house (52 targets, ~20,100 voxels — qa-boom-scale.mjs,
headed, 120 Hz). Suspects acquitted by measurement: skin-drain 0.1-0.5 ms,
boom-glass 0.8, boom-dust 0.1, boom-sfx 0.1, boom-bots 0.2, boom-crater
0.1, settle-drain ~0.3 ms/call. Convict: the synchronous ring-1 first
step inside explodeAt — 4 full-depth node carves in the detonation frame,
and a roof node fans its carve to EVERY sibling plane while counting as 1
against the 4-node budget. Fix: EXPLOSION_CORE_NODES=2 (boom frame carves
the 2 nearest nodes for the instant hole; the rest rides the existing
16 ms staggered steps under the flash/dust) + collectExplosionNodes
returns a plane-count weight so a heavy roof node can't squeeze into a
nearly-spent step (only a step's first node may overshoot). Numbers:
boom-carve-sync 7.0/2.4 → 5.4/0.2 ms, boom-explode 8.1/2.6 → 6.7/0.6 ms,
worst blast frame 16.6/12.7 → 15.3/11.6/10.9 ms; 5482 voxels removed
before AND after (identical blast). Zero ≥50 ms spikes, zero invariant
violations. removedQueue→instanceMatrix upload budgeting deliberately
NOT added: CPU trivial, no render-submit spikes, and spreading it means
extra full-buffer uploads without updateRanges on three r185 — logged as
a WebGPU-path candidate only.

ROOF-EDGE WHITES (roof-planes.ts, skin-tone.ts): NOT the ToneGrid — live
instrumented probe (qa-roofedge-probe.mjs) showed plane cells uniformly
dark including eave/rake rows, while the #residual member carried 836
cells, 332 of them INSIDE the kept planes' slab volumes at the polygon
border, mean color exactly #ebe7df (dominantResidualMaterial picks the
near-white trim/deck slot on host roofs). fillResidual had only excluded
down-facing tris directly opposing a plane, so eave fascia / rake
bargeboards / ridge caps / overhang soffits were re-traced as a white
cube shell over the dark plane grids. Fix: triInSlab + pointNearPoly —
any face whose 3 vertices sit within one kept plane's slab band
(normal range [nInner−0.1, nOuter+0.1], polygon dilated 0.15 m) is
dropped from residual; gable ends keep ≥1 vertex far below the inner
surface and survive with their own trim tone (vanishing-gable-end fix
intact). Offline replay of the dumped host shell: residual 91 → 39 tris,
all 52 rim faces excluded. Hardening: toneGridFromPixels treats
alpha<128 texels as holes and backfills from the nearest opaque texel,
so a thumbnail's transparent margin can never tile white onto edge cells.

GLASS PLATES (glass.tsx, game-root.tsx wiring): routing exonerated —
pane material matches isGlassLikeMesh, all rifle shots returned 'glass',
the window voxel target stayed dormant 84/84 alive; the cubes were
shatterPane's own 26 uniform spawnDebris cubes. Replaced with a
self-contained instanced plate-shard pool: cap 96 thin plates, one draw
call (boxGeometry + transparent standard material #bcd8e2 opacity 0.55,
depthWrite off; no instanceColor), zero per-frame allocations. Shards
are real glass: 8 mm sliver axis (spec 6-10 mm), 0.06-0.22 m face edges,
oriented IN the pane plane at spawn, launched off both faces, full
gravity + fast tumble, one dead bounce, settle, shrink-out; count scales
with pane area (10-34 clamp). Floor probed once PER PANE FACE at shatter
(upstairs panes drop onto their own storey) — also removes the old
26-per-pane debris apex probes. resetGlass clears the pool (post-Esc
waves spawn nothing). Two-stage crack decals preserved. Headed: all 34
shards fall, land, drain to 0 at ~120 fps; debris ring gains ZERO pieces.

Manager integration: cross-file wiring was already in-tree from the
lanes (game-root.tsx glassShardCensus/setGlassFloorProbe + __boots
.glassShards(); grenade.tsx boom-carve-sync/bots/sfx/dust sections;
voxel-walls.tsx skin-drain/skin-reprime sections). world.ts glass fence
and voxel-walls upload budget were REQUESTED as leads but both lanes'
measurements refuted the need — not applied. QA scripts saved in
private-editor: qa-boom-scale.mjs, qa-roofedge-probe.mjs,
qa-glass-lane.mjs, qa-glass-plates.mjs, qa-glass-headed.mjs.

QA leads for next round: owner-scene acceptance on his real house
(eave/rake ring reads shingle-dark; detonation frame stays clean at his
target density); first host-item wake spike still open from fix round 3;
removedQueue upload budgeting if/when a WebGPU path lands.

## Night 4 — species / silhouettes / face-keyed eaves / shell S0 (2026-08-29, fleet 3 lanes + shell track, manager stitch)

Three lanes on one tree plus the supervised shell branch; manager
integrated, merged, gated. 1004 tests / 38,640 assertions green; tsc
clean; real exit codes.

EAVE TEETH (skin-tone.ts, destruction.ts, voxel-walls.tsx): root cause
REVISED from the round-5 brief — live hosts voxelize ceilings as a
SINGLE 0.025 m cell layer (one Y-plane at 2.473), so the same cell's
bottom face IS the room ceiling while its top/rim faces are the attic
floor seen through the eave slit. Cell-keyed color can never satisfy
both faces (the prior session's mute darkened the interior; its ny<2
guard resurrected the teeth). The fix is literally face-keyed:
CEILING_GEOMETRY (unit box, vertex colors — 4 bottom verts at 1, 20
structural verts at CEILING_FACE_TINT ≈ [0.221, 0.186, 0.140]) + a
CEILING_SKIN_MATERIAL with vertexColors:true (the only new material
variant; vertexColor × instanceColor, no custom shader, WebGPU-safe).
Interior white × tint lands EXACTLY on STRUCTURE_TOP #7a6f5e.
isStructuralTopCell is walls-only again (plate row iy===ny-1);
VoxelTarget.ceilingTop is the geometry pick key. Diag rig (per-instance
AABB raycast, entry face + effective rendered color): slit rays L 0.809
→ 0.148 (rim) and 0.369-0.872 → 0.105-0.155 (plate row); ceiling
instance-color census bit-identical to baseline — interior provably
unchanged. Known out-of-scope: pre-existing light wall-body texture
cells (ty=2.3, present at HEAD); stepped gable-top walls would need
column-top keying.

TREE SPECIES (tree-species.ts NEW, trees-destruct.tsx, nature.tsx):
4 low-poly cartoon species — tiered conifer ~40% (2-3 stacked cones,
seeded overlap), broadleaf ~38% (crown blobs + bark stub, connectivity
test-pinned), birch ~22% (thin tall trunk, light bark instanceColor,
high tuft), bush (nature.tsx: three squashed lobes baked into ONE
geometry, single draw). Distribution + all params from hashXZ (XZ
quantized 0.25 m + seed → mulberry32) — stable across sessions by
construction. Per-instance: height 0.7-1.4x, crown 0.8-1.25x,
palette-family green jitter, 2-4° render-only lean, trunk 0.85-1.2x.
Budgets: shared UNIT geometries, grove 5 draws / nature 5 (10 total,
same class as before); zero per-frame allocations; burning flicker
paints the species' own slots. COMBAT SYNC: treeParamsAt(x,z) is the
single source of truth — raycasts (per-species trunk cylinder +
analytic crown sphere), fell/ignite/char bursts, char branches, stumps,
and host-replacement apex parity all read it; a felled birch chars as a
birch. __boots.trees() now dumps species.

ENEMY LOOKS (enemies-state.ts, enemies.tsx): droid grew an articulated
silhouette (torso core + chest plate + pelvis, smaller head with glowing
visor slit, shoulder pads + left stripe, thinner counter-swinging limbs
with joint spheres); dog got head/snout/ear blocks, a chase-wagging
tail, per-leg seeded gait offsets (no more synchronized pogo), 2 body
lengths; drone got 2 or 4 spinning elliptical rotor discs (alternating
direction), round vs boxy bodies, an unlit red sensor eye. All seeded
per unit id via botVisualParams(id, kind, wave) stamped at spawn —
render-only, logic never reads it. Visor + stripe take a PER-WAVE
accent (ACCENT_PALETTE red/green/blue/amber — a wave reads as one
color). Damage read: 2-stage shared-material scorch swap at 40%/20% hp
(the group idiom has no instanceColor — honest deviation). Budget: 3
shared unit geometries + 18 shared module materials; ZERO geometry/
material allocations per spawn (previously ~5-7 of EACH per bot);
per-part anim params in userData once at mount.

SHELL S0 MERGED (origin/feat/shell-s0, milestones 1-4b — the final
integration milestone per docs/SHELL-DESIGN.md): conforming wall-surface
fragments behind a session-latched flag, OFF by default — pure surface
partition (Sutherland–Hodgman clip + clustering + packing, shell.ts),
degenerate-index carve renderer with partial uploads (shell-render.tsx),
20-slot pooled world-frame fragment debris (shell-debris.tsx), dormant-
until-first-damage swap + core mode wired through destruction.ts /
voxel-walls.tsx / shell-layer.tsx / game-root.tsx. Merge conflicts
(destruction, skin-tone.test, voxel-walls, voxel-walls.test) were all
additive — both lanes' exports/fields/describe-blocks kept; toneKind
(floor lane) feeds dominantTargetMaterial, wallShell rides beside
floorCore/ceilingTop on VoxelTarget.

Integration notes: local main already carried the floor-white fix
(d4a8987) — nothing to pull. Hot-deployed changed files (cp, per file)
into BOTH host copies. QA leads: headed visual pass on species + enemy
looks batched next round; shell flag stays dark until its own QA night;
pre-existing light wall-body texture cells (out of scope above).

SPRAY WHITE-FLASH — NOT REPRODUCIBLE ON LOCALHOST (2026-08-31, open).
Owner report, prod: "quand je spray paint, ca clignote en blanc au niveau
de la ou le spray touche le mur (cercle) au moment ou je click. apres la
couleur reste tout bien." Harness:
private-editor/qa-boots-spraywhite.mjs (untracked, alongside the other
qa-boots-*.mjs). It aims yaw/pitch only from where the player already
stands (never teleports into geometry), probes candidate walls by
broad-face area until one takes a stamp, arms a self-rescheduling rAF
recorder (scene.onAfterRender never fires here) plus a CDP screencast,
and files per frame every mounted paint lane by its polygonOffset
fingerprint (craters -2, sprites -3, decals -4) with material/instance
colours, plus live dust instances by instanceAlpha.

THREE NEGATIVES, 887 captured frames, zero white pixels at the crosshair
(threshold: max channel > 236 with saturation < 16, in a 90x90 patch):
  1. warm pristine wall, one 2.6 s click-and-hold with the aim sweeping,
     16 decal stamps -> every stamp reads #e5443b on its first frame;
  2. wall voxelized first with 14 rifle rounds so the spray takes the
     SPRITE lane instead (census sprites 8 / decals 0 -> the fork really
     flipped) -> every sprite reads #c80f0b (that is #e5443b in linear
     working space), the _splatWhite priming is never what draws;
  3. COLD: no warm-up probe at all, six bursts each preceded by R, so the
     first stamp of RED/ORANGE/YELLOW is the first ever use of that
     palette entry's lazily-built MeshStandardMaterial (decalMaterialFor)
     and of the airbrush CanvasTexture -> #e5443b, #f28a2e, #f5c542, each
     correct on its debut frame.

RULED OUT BY READING: spawnPaintDecal writes slot.color BEFORE
emitDecals(); stepSplats and stepPool both write matrix and colour in the
same pass; refreshMistTint() is unconditional before the impact puff, so
mist/bounce dust always wears the live coat (and _mistTint inits to black,
not white); drainPaintTints starts from primedCellColor, not a white
default; the ADS crosshair morph is gated to pistol/rifle so paint never
touches it; paint calls no hitmarker.

ALSO ESTABLISHED: the app renders with three.js WebGPURenderer /
WebGPUBackend (isWebGPU true, coordinateSystem 2001) — there is no WebGL
context, so gl.readPixels is unavailable and pixel truth has to come from
the screencast. polygonOffset IS honoured on this path: three 0.185.1
maps polygonOffsetUnits/Factor to depthBias/depthBiasSlopeScale in
WebGPUPipelineUtils (triangle-list only), so the decal lane's separation
from the wall is real, not a silent no-op.

FOURTH NEGATIVE — ON THE REAL GPU (2026-08-31). The variable named below
as the one left is now controlled: `GPU=1` runs the same harness HEADED,
with WebGPU enabled, on the owner's own Metal device (window parked
off-screen so it does not take the desktop). 441 recorder frames, 155
screencast frames, 17 decal stamps over a 2.2 s sweeping hold: every stamp
reads #e5443b on its first frame, every live dust instance wears the coat
(#b5..#d3 red at alpha 0.06-0.22), and there is no near-white frame in the
crosshair patch after the trigger. The captured frames are real pixels —
checked by eye, not just by the threshold — so this is a negative and not
an empty canvas.

WHAT IS LEFT. Two differences from the owner's session remain, and neither
is the GPU:
  1. BUILD — the harness drives `localhost:3002` (the editor app in dev).
     The report is a production bundle: no dev double-effects, different
     scheduling. Not run here because `next build` writes the same
     `.next/` the running dev server is using, and taking that server
     down is not worth a speculative test.
  2. ROUTE — the owner enters through `/play` (lobby lease, host-app
     mount) or `/editor`; the harness enters through `/scene`.
Still deliberately NOT shipping a speculative pre-warm "fix" for an
artifact four measured runs have not seen. The cheapest thing that would
end this is still one answer only the owner can give: FIRST click of a
session or EVERY click, and was the wall already shot up. Re-run with
NOPROBE=1 CYCLE=n (cold, per-colour), VOXELIZE=1 (sprite lane), or GPU=1
(real device) once that is known.

NOTE FOR WHOEVER READS THE PALETTE. `PAINT_PALETTE[0]` is WHITE, and two
paths fall back to index 0: `SPLAT_TINTS[s.color] ?? SPLAT_TINTS[0]` in
stepSplats, and `colorIndex`'s own initial value. Neither explains the
report: a local stamp always carries the live index, and a session that
starts on WHITE stays white until R is pressed.

A first draft of this note went further and claimed a wire colour from a
peer on a longer palette would land on white. IT WOULD NOT, and the claim
is retracted here rather than left to send the next reader chasing it.
`foldRemoteStrokes` filters `rec.color < PAINT_PALETTE.length` before
anything indexes the palette, and skips the node when nothing survives —
already pinned by shared-build.test.ts "a colour outside this client's
palette is refused". The `??` and the `null` from `decalMaterialFor` are
defence behind that gate, not the gate.

What the gate DOES cost is worth writing down, because it is the opposite
of a wrong colour: in a mixed-palette lobby the older client shows NO
paint where the newer one shows a coat. That is a silent divergence, and
this game's rule is that builds and destruction are synchronous. It cannot
happen today — one global pin means every client carries the same twelve
swatches — so nothing is being changed for it. The day the palette grows,
the choice to make is fold-to-a-known-index (both clients agree the wall
is coated, hue may differ) over drop (one client never sees it), and this
paragraph is the argument for it.

────────────────────────────────────────────────────────────────────────
THE FIFTH NEGATIVE, AND THE BUG IT TURNED UP INSTEAD
────────────────────────────────────────────────────────────────────────

BUILD is now eliminated as well. The editor app was built and served in
PRODUCTION mode on :3002 and the spray harness re-run against it on the
real GPU: 441 frames, all 17 decals `#e5443b` on their first frame, dust
red at alpha 0.06–0.22. NOT reproduced. Five runs, five negatives. The
only named difference left from the owner's session is the ROUTE — the
community app's `/play` / `/editor` versus the open-source app's `/scene`
— and the question that would end it is still the one only the owner can
answer: FIRST click of a session or EVERY click, and was the wall already
shot up.

That production run did report something the four dev runs never had:

    ReferenceError: window is not defined
        at module evaluation (…/chunks/3wa_bin88y_vc.js:1:301299)

Two runs were spent misattributing it to the harness (a pointer-lock
`addInitScript` shim, which got a `typeof window` guard it should have had
anyway — but the error survived). Adding stack capture to the harness is
what settled it: a real app chunk, evaluated through the turbopack loader.

Read at that offset, the code is three's own module-eval epilogue. three
r185's SOURCE guards it:

    if ( typeof window !== 'undefined' ) { … window.__THREE__ = REVISION }

The production bundle does not. The optimizer kept the neighbouring
`typeof __THREE_DEVTOOLS__` guard and folded the `typeof window` one away,
because for a browser target it is always true — on the main thread. The
same chunk is also what a WORKER loads.

plugin-boots ships exactly one worker: `bvh-worker.ts` →
`three-mesh-bvh/worker`. A probe that enters the game and watches worker
traffic confirmed it, from the worker's own chunk list inwards:

    8.0s  created …turbopack-worker-….js#params=[[…,"…/3wa_bin88y_vc.js",…]]
    8.0s  ReferenceError: window is not defined (module evaluation)
    37.6s [boots] BVH worker unavailable — builds stay on the main thread
    37.6s CLOSED …turbopack-worker-….js

So off-main-thread BVH building had NEVER ONCE WORKED in production. Perf
fix #3 shipped on 2026-08-29, was verified in dev, and was inert in prod
from that day to this one: every main-thread build stall it was written to
remove was still there. Dev builds skip the fold, so nothing about a dev
session could have shown it.

The degradation path did hold — correctness never depended on the worker,
and the queue fell back to lazy synchronous builds, which is the behaviour
that predates the perf fix. But it cost 30 s to engage, and those are the
same first 30 s of a session that background priming exists to protect.

THE FIX is two things.

`bvh-worker-entry.ts` is now the worker's script instead of the package's:
define `window` (aliased to the worker global — everything three could
reach through it lives there anyway), THEN let three evaluate. Its
load-bearing property is that it has NO STATIC IMPORTS, since those are
evaluated before its first statement and one of them reaching three would
restore the bug exactly, in production only. `bvh-worker.test.ts` pins
that by reading the source: not the type check, not a dev run, and not the
diff can see it otherwise. The PROTOCOL stays three-mesh-bvh's —
`runTask` borrowed off `GenerateMeshBVHWorker.prototype` instead of
reimplemented (verified byte-identical between the 0.9.14 here and the
0.9.10 the host resolves), so there is one place for the two ends to drift
and it is upstream's.

And a boot handshake, because the 30 s was its own defect. A throw during
module evaluation does NOT fire the parent's `Worker.onerror` — verified;
the dead worker sat there alive until we terminated it — so silence is a
dead worker's only symptom. The worker now sends one unsolicited message
once its handler is installed, and the builder gives up on THAT instead of
on a task reply. A future bundler surprise costs 10 s, not 30.

VERIFIED on a production build, real GPU, from inside the worker itself:

    {hasWindow:true, windowIsGlobal:true, threeRevision:"185",
     handlerInstalled:true}

`threeRevision:"185"` is the point — the exact line that used to throw now
completes. Zero page errors, no fall back to the main thread, worker still
alive at 53 s where it used to be disposed at 37.6 s. 2116 pass / 0 fail,
tsc clean.

WORTH REMEMBERING GENERALLY: any worker in this app that imports three has
this problem, and it will not show up in dev. If one is ever added, it
needs the same entry treatment — or `bvh-worker-entry.ts` needs to become
a shared one.

AND A SECOND REASON, IN THE OTHER ENVIRONMENT. Fixing prod is not the
same as knowing dev still works, so dev got the same probe — and the
worker died there too, 100 ms in, for an unrelated reason:

    [boots] BVH worker unavailable — builds stay on the main thread
    Error: [boots] BVH worker: already running a job

React mounts the game twice in development, so `collectWorld` runs twice
and two `primeColliderBvhs` queues overlap. `activeBvhPrime.cancel()`
cannot recall a build already posted, so the second queue asks while the
first is in flight, and the worker takes one task at a time. This
predates the shim — three-mesh-bvh's own class throws `Already running
job.` in the same situation, and `generateInWorker` read any rejection as
a broken worker and latched it off for the page's life.

So there were TWO independent reasons the perf fix never ran, one per
environment: `window` in production, contention in development. Neither
was visible from the other side, and the second only turned up because
the first fix was checked in both directions instead of one.

Contention is not breakage. Callers queue now, bounded by their callers
(runBvhPrimeQueue is sequential, a cancelled queue schedules nothing
more). The task timer moved inside `generate` at the same time: a job must
not be timed out for time spent queued behind someone else's build, and
waiting for boot is not the task taking long either — one budget for
coming up, one for the work.

Re-entering the game (Esc → Jump in) is the same shape in production, so
this was not a dev-only defect waiting to matter.

The test for it uses a fake worker that ANSWERS the protocol on the main
thread — real serialize/deserialize round trip — which makes overlap
observable as post/reply/post/reply instead of post/post/reply/reply, and
covers the borrowed `runTask` end to end into the bargain. That borrow is
the module's one coupling to a package it does not control, and until now
nothing exercised it outside a browser.

---

## WHO ACTUALLY BUILDS THE BVHs — MEASURED, AND ONE HYPOTHESIS KILLED

The worker fix landed and the main-thread build count did not move: 118
cache-miss builds per session before, 118 after. The hypothesis was that
the queue was still failing somewhere. It was not. A timestamped stack
probe over `bvhFor`'s miss branch named every caller instead:

    pickAimedOperable (interact.tsx)   x76      -> 0 after the cull
    ensureVoxelTarget (destruction.ts) x30      -> x105 after
    stepBvhDrain (warmup.tsx)          x10
    useFixtureColliders (guntable.tsx) x10      -> 0 after
    spawn probe                        x1

Three lanes were asking for a BVH before the worker could hand one over,
and `ColliderEntry.bvh` is a lazy getter that BUILDS on read — so
"asking" and "building" are the same act. The aim probe alone accounted
for 76 of them, every frame, over every operable, because it had no
broadphase; the bullet lane has had one since the minigun first-fire
freeze. Glass had none either, and panes are not colliders, so nothing
else ever builds them. The gun depot built all its fixtures eagerly at
mount whether a ray came near them or not.

All three are fixed (ba74ffe), each with a test that fails when the fix is
reverted.

AND THE TOTAL STILL DID NOT DROP. It went the other way: the prevoxelizer
absorbed the work, x30 -> x105. Those BVHs are not waste — `ensureVoxelTarget`
genuinely needs the geometry it voxelizes, and it was simply finding the
cache already warm before, because the three eager lanes had paid for it
first. So "yield to the worker and the count falls" was WRONG, and is
recorded here as wrong. What changed is WHO pays and WHEN: a per-frame
probe over every operable no longer does, and `perf()` reports 0 spikes
over 7255 frames, which says the remaining builds are budgeted rather than
user-visible. That is the argument for NOT re-architecting destruction.ts
tonight.

### THE AIM PICK WAS ACCUSED AND CLEARED

`qa-boots-aimpick` read 12/22 door sides picked before the cull and 8/22
after — an apparent interaction regression, on a commit already pushed.
Two measurements settled it:

1. The cull's exactness, directly. A probe recorded the AABB verdict beside
   the raycast result for every collider, with the cull DISABLED, over 266
   poses: every operable, both sides, point blank / standoff / 3.5 m,
   off-axis and pitched. 79,800 collider checks, 257 raycast hits, and ZERO
   colliders where the box said miss and the BVH said hit. Exact, as the
   geometry requires — culling on a MISS only is what preserves the
   point-blank case, since a ray whose origin is inside the box gets its
   exit point back.

2. The probe's own repeatability. Byte-identical game code, run twice:
   6/22, then 8/22. The spread was the instrument. Straight after entry a
   door's collider group AABB can still come back in a half-applied frame
   with its thin axis reading as the wide one — door_5ehohrtqaxcer6up
   measured span [1.01, 2.10, 0.13] on one run and [0.13, 2.10, 1.01] on
   the next — so the derived standoff stood BESIDE the leaf and the miss
   said nothing about the crosshair. Every door was otherwise identical in
   the census: closed, settled, host visible, no disabled collider, no
   voxel target.

Waiting until two consecutive censuses agree on every live box, then
re-reading each box at use time, gives 22/22 and 20/22 WITH the cull.
(The one residual, door_klmiwhsd0uup6hvy, is the 30-collider double leaf —
probe geometry, not the pick.)

The lesson worth keeping: the aim lane had no headless reading at all, so
every question about it had to be asked through a walk, a teleport and a
keypress. `__boots.doors.aimed()` (afd6ef6) runs the frame loop's own
two-step on demand and reports which lane answered. A change to a pick
needs a measurement OF the pick.

---

## THE SUITE WAS READING STATE IT NEVER SET — nine files, one shape

`bun test` passes 2133/2133 in the default file order. `bun test --randomize`
does not, and every failure it produced was the same bug wearing a different
coat: a test file whose assertions depend on a module singleton it never sets,
inheriting whatever an earlier file happened to leave there. bun runs every
test file in ONE process, so every module-level store, pool, latch and registry
is shared. The default order is not a specification — it is the alphabet.

Nine files fixed, and the interesting part is that the failures were not test
noise. Two of them were the suite asserting the wrong thing, and one was a
production asymmetry.

### 1. A door swings away from the player — and the player is a singleton

`--seed=42`: four failures in `door-stale-pose.test.ts`, every one a voxel
raycast that found nothing where the leaf should be. The file passes 8/8 alone.
A pairwise sweep over all 120 files named exactly one culprit:
`enemies-drone.test.ts`.

Two hypotheses died first, both measured rather than argued: leftover
registered passages masking the ray through `_skipOpenDoorway`, and leftover
destruction targets. A probe printed `passages: 0 targets: 0` — identical alone
and paired.

What the grid dump showed instead: same cell size, same 3×14×6 dims, same 168
cells, same 160 alive — and `yaw` NEGATED. `-0.4636` alone, `+0.4636` paired.
The grid was MIRRORED.

`toggleOperable` decides which way a leaf swings from where the player stands
(interact.tsx: `state.hinged.sign = tmpVec.z >= 0 ? 1 : -1`, the player's
position in the hinge frame). `enemies-drone.test.ts` parks `playerRig` at
(0, 1.6, −0.5) and never puts it back. The next file's doors then open the
other way. `door-stale-pose` and `door-repose` both build their entire geometry
on "the leaf sweeps into the room along −Z, and the aim line at z = −0.5
crosses it" — true only for a player on the +Z side. They were relying on the
default rig sitting at the ORIGIN, where z = 0 lands on the `>= 0` side of that
comparison by luck.

Both now state the stance they need; the five files that move the rig hand it
back at the origin.

### 2. `debrisDump()[0]` is only "my chunk" if the pool is empty

`ground.test.ts` and `roof-framing.test.ts` read the debris pool by index and
by delta. The pool is a fixed ring that only recycles on an update tick, and
nothing in a test ticks it: arriving full, it REFUSES every new particle, so
`debrisCensus().live` stops rising — which is exactly what the rafter-chip
assertion measures (768 before, 768 after, seed 246810). Arriving merely
non-empty, `debrisDump()[0]` is a stranger's chunk (seed 65536).

Same fix as the damage-parity harness got earlier tonight: EMPTY is a state,
so take it going IN, not just coming out. Both files now run their teardown as
`beforeEach` and `afterEach`.

### 3. A pool that clears its slots and keeps its cursor is not empty

This one was a production bug, and the only failure of the night that was not
order-dependent: `debris.test.ts`'s "identical spawn sequences shed identical
shapes" failed about one run in eight IN A FIXED ORDER.

`clearDebris()` reset `alive`, `liveCount` and `spawnSeq` — but not `cursor`.
So the next burst started writing wherever the last one stopped, and every
slot-ordered reader (the dump probe, the instance matrices) saw the same pieces
in a ROTATED order — including a wrap that splits a burst across the ends of
the ring. Whether it wrapped depended on how far the cursor had travelled,
which depended on how many rim nibbles earlier carves happened to roll. Hence
one in eight.

`clearGlassShards()` had the identical asymmetry. Both now reset the cursor:
one clear, one state.

### 4. Whole-store assertions, foreign rows

The rest were files asserting on the ENTIRE contents of a singleton — which is
the right assertion, made against the wrong population:

- `builder.test.ts` — `placed.length` is 0 once everything cascaded, and
  `before[1]` is a specific wall. A stranger's piece shifts every index.
- `shared-build.test.ts` — `reconcileSharedPieces` walks the whole placed
  store, so a leftover piece publishes a record the file never asked for.
- `save-demolition.test.ts` / `shared-damage-remote.test.ts` —
  `captureDemolition` counts the whole destruction ledger and the whole
  pending list. "Only wall-1 is offered" saw two.
- `world-levels.test.ts` — asserted `world.levelId === 'level-test'`, the
  preload stub's DEFAULT. `keep`/`item-keep` re-pin the viewer's selected level
  per test and never hand it back, so seed 11111 read `level_test`. The test
  now SETS the selection and asserts the mirror, which is what its name always
  claimed: `collectWorld` mirrors the viewer, whatever the viewer says.
- `preview.test.ts` — `shouldPreview` reads the PHASE as well as the lanes. A
  file that left the store mid-session made the gate refuse for the right
  reason and the wrong test.

### The rule this leaves

A test file may not read a singleton it did not set. Teardown after yourself is
politeness; setup before yourself is correctness — the file that fails is
downstream of the file that leaks, and only the reader can defend itself.

Verified across the default order and 40 `--randomize` seeds.

---

## TWO SESSIONS, ONE BUILDING — the claim nobody had ever tested

"Everything must be synchronous in multiplayer — builds AND destruction" is one
sentence, and until tonight nothing in this repo could answer it. The unit
suite drives ONE copy of the world with a scripted transport: it proves the
merge, the authorship gate, the lattice join and the chunker, and it cannot
prove that two real runtimes in two real browsers end up holding the same
house. Those are different claims, and only the second one is the product.

`docs/qa/qa-boots-twoclient.mjs` closes that. Two tabs, two live game
runtimes, one wire — and the wire is the interesting part.

### The shim mirrors the host, not an idealised wire

`:3002` is the editor dev server, not the app: there is no collaboration bus
there, and net.ts is feature-detected, so Boots on `:3002` is deliberately
solo. So the harness installs the missing half — a `__pascalCollabBus` v1 over
two BroadcastChannels.

A test transport that delivered everything instantly would have proved nothing,
because the real bus is LOSSY BY DESIGN. So the shim reproduces, from the host
module it stands in for: latest-value coalescing per (pluginId, event) behind
the host's window — intermediate payloads for one key are DROPPED; the
8 000-byte serialized frame budget, measured on the same probe shape, with an
over-budget publish returning 'suppressed' rather than throwing; host-stamped
identity, so the receiver's sessionId/clientId/userId come from the transport
and never from the payload; and no echo to the sender's own session.

### Four legs, because a one-way wire looks exactly like a working one

From whichever end happens to be driving, a wire that only carries traffic one
way is indistinguishable from a wire that works. So all four:

    BUILD  A→B  slot Wx:3,6,0    both 0 → 1     ✓
    BUILD  B→A  slot Wz:3,6,0    both 1 → 2     ✓
    LEVEL  B→A  wall_5a1q…       both  0/685    ✓
    LEVEL  A→B  wall_zij1…       both  0/170    ✓

`worldSync` on both ends: lost 0, oversize 0, applyErrors 0, unsent 0,
overflow 0, busLost 0, throttled 0, rekeys 0, staleMints 0, unsafeNames 0.
Zero page errors on either tab.

### Two ways the harness lied before it told the truth

**The piece `id` is not a piece's identity.** The first version of the build
leg compared `pieces()[].id` across peers. That is a PER-SESSION runtime
counter — shared-build binds a locally minted runtime id to the shared record —
so A's first wall is `1` on A and whatever B was up to on B. The assertion
would have failed a working wire. `slotId` is `${kind}:${i},${k},${s}` straight
off the grid: a pure function of where the piece sits, therefore the same
string on every peer that holds it. That is the cross-peer identity, and
comparing counts instead would pass two peers each building their own wall
somewhere else.

**Both sessions spawn at the same point facing the same way.** So the second
builder aimed at the slot the first one had just filled, the placement was
refused as `occupied`, and the leg read as "nothing synced". The reverse leg
now turns first (under pointer lock a mouse sweep IS a yaw).

### Two counters that look wrong and are not

`laneSinkIgnored: 35` on the peer that did the damage. By design: net-world
hands DamageSync a publish that only increments a counter, because damage
already journals itself through `noteLocal*` and the tick drains the journal —
letting that lane send would publish the same cells twice. Counted rather than
empty so a future rewiring shows up as a number instead of a silent doubling.

`[A] remotes 0` in one co-presence sample, with almost no poses published.
That was the HARNESS: Chromium throttles a tab it believes nobody is looking
at — rAF stops, timers are clamped — and only one of two pages is ever focused.
`--disable-background-timer-throttling --disable-backgrounding-occluded-windows
--disable-renderer-backgrounding` plus a sampler that alternates which tab is
in front made the counters symmetric. Every "the peer never sent anything"
reading before that was an artefact.

One real observation survives it: at ~1.5 fps on a 485 k-triangle scene the
keep-alive cannot outrun the 3 s staleness window, and a remote avatar can
blink out and back. Not a wire fault — a note for the frame budget.

## TWO PEOPLE, ONE CALL — three bugs between a connected pair and a conversation

The ask was to talk to each other the way people on a call do, or teammates in a
squad game. Every unit test passed and the mesh was reported as connecting, so the
two-browser harness (`docs/qa/qa-boots-voice.mjs`) was written to answer the one
question none of them can: do two real Chromium sessions on the real bus end up
holding each other's audio? Its verdict was **false** on every run until tonight,
for three different reasons in sequence. All three are the same *kind* of bug —
nothing threw, no counter moved, and both ends reported a healthy call.

**1. Presence churn was destroying handshakes.** A link was reaped the first tick
its peer failed to appear in the presence roster, taking the connection, the
gathered candidates, the epoch and the applied watermark with it — so the pair
restarted from zero on both sides and never got the few seconds a handshake needs.
The roster sampler added for this printed the evidence directly:
`roster {"drops":1,"maxAgeMs":5668}` with `reaped: 1` on both sides of a call
nobody had left. Presence rides the render loop and voice rides an interval, so a
backgrounded tab stops publishing poses entirely while its voice frames keep
arriving the whole time — which makes the roster the wrong place to ask whether
somebody is still in a call. Liveness now comes from their voice frames, and
absence needs `PEER_ABSENT_MS` before anything is torn down.

**2. A frozen tab reaped the whole room on its first tick back.** Every deadline
in the module is a difference against a clock the interval is assumed to be
advancing. `stalls: 35` per run says how untrue that is: gaps over a second, in a
tab that was merely behind another one. Read literally, the tick that lands on
resume says every peer went silent and every handshake timed out, simultaneously.
A gap over `TICK_STALL_MS` is now credited back to every deadline each link owns.
Time the page was awake for still counts — the credit forgives the freeze, not the
peer.

**3. The answerer never negotiated its own audio.** With the mesh finally staying
up, the harness reported `A holds B's audio: false` / `B holds A's audio: true` —
a connected pair, a live sender on both ends, and one person inaudible.
`voiceInternals()` was written for exactly this, because `voice()` cannot see it:

```
A  transceiver mid=0     direction=sendrecv  current=sendonly
B  transceiver mid=null  direction=sendrecv  current=null
B  transceiver mid=0     direction=recvonly  current=recvonly
```

WebRTC recycles an existing transceiver for an incoming m-line only when it came
from `addTrack`; one created with `addTransceiver` is a request for an m-line of
our own. So the answerer held two — its own, which could never acquire an m-line
because an answer cannot add them, and the one the offer implicitly created, which
the spec defines as **recvonly**. Its answer said "I only receive". Accurate, and
fatal. The answerer now adopts the associated transceiver before `createAnswer`,
forces it to `sendrecv`, and moves its sender there so the mic reaches the m-line
rather than an orphan.

Found on the way, both from the same root — **signalling here is a resend loop and
every stage of a handshake is an `await`**: the answerer started a whole new
negotiation for every duplicate of an offer it was already answering (4 applied and
7 answers sent for one offer at epoch 1), and a duplicate *answer* hit
`setRemoteDescription` twice, whose rejection path **restarts the pair** — hanging
up on a working call as the reward for the peer's patience. `link.busy` claims the
epoch synchronously, before the first await.

**Verdict now, twice in a row:** mesh connected both ways, audio flowing both ways,
0 given up, 0 reaped, 0 restarts, and the talk gate observed end to end — A's mic
opened and B's HUD counted A as talking. 2303 tests, tsc clean.

The harness had been muting both microphones, incidentally: the session comes up
`live` when permission was already granted, and M is a toggle. A call where nobody
can speak was never the thing under test.

## PUBLIC IS NOT THE SAME AS JOINABLE — the sentence that told him it worked

The link half of "1 link join" had a second failure, and it was not in the routing:
it was in the sentence under the button. **Share link** said, for every *public*
project,

> Link copied — anyone with it signs in and drops straight into your game.

Dropping in needs two independent things. Public is one. The other is the project
being an **open lobby**, a separate host decision that visibility deliberately does
not imply — a public project is published for *viewing*, and every public project
silently becoming world-playable is the accident that marker exists to prevent. On a
public non-lobby the link renders the building read-only and nobody joins anything.

Which is exactly the report: *"nothing really like joining a game together"*. The
copy was part of why it took a live share to find out — it told the owner the link
worked, so there was nothing to check.

The plugin could not have known better: bridge v1 exposed visibility and nothing
else. So v2 adds `isOpenLobby` (the marker only — the plugin already knows whether
the project is private and combines the two itself, and folding them together would
leave it unable to say *which* condition is missing), and `shareReach` turns it into
the only three answers there are: `drops-in`, `view-only`, `unknown`.

**`unknown` is not `false`.** An `isOpenLobby ?? false` default would print "they
land on a read-only view" on every host that has not shipped the field, including
the ones that do drop them in. Absent means we do not know, and the line says the
condition out loud instead of promising either way.

Two smaller things fell out of it. The plugin's version gate went from `== 1` to
`>= 1`: a v2 host — one that can tell us *more* — must not read as *no bridge at
all*, which would have traded the private warning and its one-click fix for a
version bump. And a `view-only` line is styled amber, like a failed publish: it
looks like success and isn't, so it may not sit greyed out under a copied link.

`qa-boots-share.mjs` drives the real panel in a real browser against a real bridge
and reads the sentence off the DOM, because none of this is visible to a unit test:
whether the panel reads the bridge at all, whether it reads it at *click* time, and
whether the amber lands on the caveat. Four combinations, all four correct, 0 page
errors — including the trap in the one-click fix, where "Make it public" succeeds and
the old copy congratulated the owner with a promise publishing has no power to make
true.

Getting the harness to the panel took two tries. On a bare `/scene` the plugin is not
loaded at all, and the rail entry for a plugin is an icon with no text and no
`aria-label` — the only thing in the DOM that names Boots is the image source.

## THE SILENCE — nobody could tell whether the other person had arrived

The report was never "it crashed". It was *"so nothing really like joining a game
together"*, and after a night of chasing why the link didn't work I noticed the
sentence describes something else: two people, one link, and **neither screen said
whether the other one was there**.

That single silence covers at least four unrelated failures — the link never opened,
it opened read-only, the bus was off, or both of them arrived and never found each
other inside a big building. All four look identical from the sidebar, so the only
report available to the person holding the link is that multiplayer doesn't work.

One line under Play together splits it in two, which is the only split that matters
when you are trying to fix it:

```
Just you in here right now.       -> nobody arrived. The LINK is the bug.
Anna is in here with you.         -> the link worked. Look downstream, in the game.
```

Two ways to get this wrong, both of which I had to write down before I trusted it.

**It has to read the HOST bus, not the game's.** `net.ts` captures the bus in
`startNet()` and is only alive for the duration of a game session, so its roster is
empty in the editor — which is exactly where the sidebar is, before Jump in and right
after Esc. Empty renders as "just you": the wrong answer at the worst possible moment,
and the moment a real user is most likely to read it. `getCollabBus()` is the host's
object, alive as long as the editor's awareness session, so the line is readable in
every phase. The browser QA proves that specific case — it reads the line *after Esc*.

**It has to count sessions, not users.** The likeliest first test of a share link is
one person, two devices, the same Google account — which the host reports as ONE
participant with TWO sessions. Counting distinct users would have told that person
they were alone while they stared at their own phone sitting in the lobby.

It says "in here", never "in the game", because the host roster knows who has the
project *open* and cannot tell an editor tab from someone already running around
inside. Claiming the stronger thing is the same class of mistake the share sentence
had just been fixed for, and it would send someone hunting the wrong bug.

And no-bus is `null`, not an empty list, printed as its own sentence: a page with no
shared session is not an empty room, and "nobody can join here" is the useful thing to
say. Same rule as the share bridge's reach — `unknown` is not `false`.

While wiring it I found the other half of last night's lie still standing. The
paragraph directly above the share button promised "they land in this project and can
jump straight into the game with you" unconditionally — sitting on top of a button
that had just been taught to say the opposite when true. Whichever of the two he reads
first is the one he acts on, so the blurb follows reach too now.

## THE WHITE CIRCLE — what the pixels say, and what they still cannot say

The report was precise: "quand je spray paint, ca clignote en blanc au niveau de la ou
le spray touche le mur (cercle) au moment ou je click. apres la couleur reste tout
bien." Three lanes draw a circle at the impact point, and two of them deliberately
prime an InstancedMesh's colours WHITE before the first draw — the sprite pool and
dust both carry the same comment about a WebGPU pipeline compiled without
instanceColor ignoring every later setColorAt. So reading the code produced three
plausible culprits and no way to choose between them.

`docs/qa/qa-paint-flash.mjs` samples the pixels under the crosshair on every animation
frame across a spray pulse and prints the trace. **On the decal lane there is no
flash.** 240 frames at 60 fps, twice over, plus another two dozen traced pulses at
distances from 1.3 m to 4.9 m: the pixel goes straight from the wall to the coat and
stays there. Decals grew on every single pulse, so the spray really was landing.

Three earlier attempts had to be thrown away, and how they failed is the useful part:

**A steady pixel is not evidence.** The first two runs traced a beautifully constant
colour and would have reported "no flash" — while `census()` sat at all zeros. Nothing
had been sprayed at all. The editor's wireframe LineSegments sit in front of every
surface, so `identifyAim()[0]` is never the wall, and paint only lands on nodes whose
type is PAINTABLE. The fix is to stop aiming by geometry and aim by outcome: spray each
candidate pose and keep the first one where the census actually GROWS. Any paint QA that
does not assert a census delta is asserting nothing.

**Palette index 0 is WHITE (#f4f4ef), and it is the default coat.** A trace taken on a
fresh session cannot tell a white bug from white paint — the first run's one bright
frame was simply white paint, correctly rendered. Cycle off index 0 first.

**Standing 0.3 m from the wall invalidates the run**: the whole sampled patch starts
inside the coat, so there is no before-colour to flash away from. That is how the third
attempt "cleared" a lane it never traced.

What is still open: the splat-SPRITE pool only draws on Boots-owned voxels — a wall
that has already taken damage — and it cannot be reached from a script, because guns
have no QA fire hook (paintDebug and builderDebug expose `holdFire`; the gun path does
not). Every wall in the test building is pristine, so `sprites` never moved. The
sprite lane is the one lane the report could still be about, and it is also the lane
carrying the white priming and the header that calls its stamps "circles near AND far".

So the localizing question is now a single yes/no, and it is the owner's to answer:
does the flash happen on a wall he has ALREADY SHOT, or on an untouched one? Untouched
means the decal lane, which is on the record as clean and would send us to the mist
puff or the HUD instead. Already-shot means the sprite pool, and the trace tooling is
sitting there ready to run.

## The rebrand — Pascaline gets the plugin (2026-09-01)

The ask: keep the name, replace every logo and image, put an animated loader
above the loading bar, all of it on the mascot.

What was there: a rail icon of a frightened man in a helmet between two boards —
generated, off-brand, and the only picture the plugin owned. The loading screens
were type and nothing else.

What landed, and the one decision behind all of it: **nothing is generated.**
Every pixel of Pascaline comes out of the official render pack
(`pascalorg/pascaline`, 2048×2084 PNGs); `docs/brand/build-brand-assets.py` only
frames her, lights her and animates the plate around her. A model asked for "the
mascot" drifts off-model every time, and the mascot belongs to the product, not
to this plugin. Full rationale in [`docs/brand/README.md`](brand/README.md).

- `src/assets/boots-icon.webp` — 512², the badge. Rail entry, Plugins list,
  panel header. **Filename deliberately unchanged**: `qa-boots-roster.mjs` finds
  the rail entry with `img[src*="boots-icon"]`, because the host renders it as an
  icon with no text and no `aria-label`.
- `src/assets/boots-loader.webp` — 700×300, **24 frames, 1.92 s**, above the bar
  in *both* loading surfaces (`game/hud.ts`'s in-game card and
  `game/drop-gate.tsx`'s share-link veil), so the two screens a visitor sees back
  to back are one brand.
- `src/art.ts` — the two URLs, one place. `panel.tsx` header badge,
  `index.ts` panel icon + copy, README hero.

Three things cost a pass each, and all three are the kind that only a browser
tells you:

**The crop is sized against 20 px, because that is what the rail renders**
(`h-5 w-5` in the host's `use-plugin-panels.tsx` — measured in host source, not
guessed). The first badge took in the collar and jacket; rendered at exactly 20 px
and upscaled NEAREST, the bottom half is one dark smear. Hat-to-smile is what
survives.

**Centre on the hard hat, never the alpha bbox.** The bbox moves with whichever
arm is outstretched, so a pose cycle anchored on it swings her sideways every
eight frames. `head_anchor()` finds the hat instead — the only large bright,
unsaturated, fully opaque region in the top third — which is also why the cycle
is `thumbs-up` / `wave` / `hands-palm` and not the other four: those three
register on the hat to the pixel. `celebrate` and `point-left` would jump.

**`object-fit: cover` at a fixed height ate the plate's own hazard rail** in both
surfaces (520×196 displayed against a 2.33:1 source). Both are `height:auto` now,
with a 1 px frame so the straight edges read as a deliberate inset panel.

Animated **WebP**, not GIF: a quarter of the bytes, 24-bit instead of a 256-entry
palette that visibly bands a soft-shaded render, and `src/assets.d.ts` already
declares `*.webp` so it rides the existing static-import pipeline. It is a plain
`<img>` in both surfaces — the *browser* owns the animation, so there is no rAF
and no timer competing with the frame loop the loading card exists to wait for.

`docs/qa/qa-boots-brand.mjs` is the guard, and it checks the two claims a unit
test cannot see. **That the loader is really animated** — counted as `ANMF`
chunks in the fetched bytes, because a still and an animation are the same MIME
type, the same `<img>` and the same `complete === true`; this is the check that
catches the real regression, which is someone routing the asset through
`next/image`, whose optimizer flattens animation (verified today: it is served
raw from `/_next/static/media/`). And **that the hero is above the bar** — as
geometry, `hero.bottom ≤ bar.top`, in each surface separately, since that is the
literal ask and a hero rendered below or off-screen passes everything else.

Green on the record: brand QA 16/16 with 0 page errors (veil hero 520×224 at
2.32:1 against a 2.33:1 source, 24 ANMF frames, card hero above the card bar,
rail entry 512² decoded at 20×20, badge on the panel header too), roster QA
still 0 failures, `check-types` clean, `bun test` 2331 pass / 0 fail.

Left alone on purpose: `definition.ts`'s `boots:job` keeps
`icon: { kind: 'iconify', name: 'lucide:traffic-cone' }`. The node is
`hidden: true` and that icon never reaches a screen.

## FOUR BUGS FROM PLAYING WITH A FRIEND (2026-09-01)

The first report from two real people in one lobby, verbatim: avatars should be
Pascalines told apart by colour; floors placed as ceilings go wrong, and a
transparent preview should come before every placement; **"MASSIVE problem that
others couldnt see my constructions / only some destructions"**; and the build
menu should offer doors and windows that E can then open.

Three of the four were the same kind of mistake in different clothes — a rule
that was right about the thing it was written for and silent about the thing the
player actually meant.

### The pieces lane was dead in production, and green in development

Root cause of the headline bug, and the finding worth carrying: **StrictMode was
the only thing that ever made it work.** `publishGridStamp` used to no-op when
the build lane was not attached yet. React runs a child's effect before its
parent's, and the parent (`ActiveGame`) is the one that calls
`startWorldSync()` → `attachBuildSync`, so the publish lost that race *every
time*. In development, StrictMode's double-invoke ran the effect again after the
parent had attached and the stamp landed. In a production build `world.gridStamp`
stayed 0 for the whole session — and the grid gate reads

    slotsOk = delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp

so both directions failed at once: our deltas carried 0 and every peer refused
them, every inbound stamp mismatched our 0 and we refused theirs. A total,
silent, **bidirectional** refusal of the slot-addressed lane. Damage cells are
grid-free, so they kept landing. "Only some destructions" is not an approximate
description of that failure, it is an exact one.

The fix is a change of category, not a reorder: the grid frame is a **retained
fact** about the running game, not an event. It is held in `shared-build.ts`
across attach/detach and republished by `attachBuildSync`, so mount order stops
mattering in either direction. Two counters now make the bug impossible to ship
twice: `gridStampPublishes` (0 = the frame never reached a world) and
`blindGrid` — refusals that happened while *our own* stamp was still 0, which is
this bug's signature and nothing else's. `refusedGrid` deliberately stays quiet
for frames that never spelled a slot, so a rifle shot from a peer whose ladder
has not installed cannot make the notice accuse them of being on another lot.

**A dev-only guard that hides a race is worse than no guard.** StrictMode exists
to *surface* effect bugs; here its double-invoke was load-bearing. Anything that
must happen once per session and can be published late belongs in a held fact
with a republish on attach, not in an effect that gives up when its peer is not
ready.

### A fingerprint must be coarser than the noise in its inputs

**Third road to the same complaint, and the one that survived TWO fixes.** With
the publish race fixed and the relay gate split, two clients that joined at the
same moment agreed perfectly — builds and destruction both ways, `refusedGrid 0`.
A client that joined *later* saw nothing, `blindGrid 0` and `refusedGrid`
climbing, which is the gate saying not *"I don't know my lot"* but *"we genuinely
disagree about it"*. That distinction is the whole reason the two counters are
separate, and it is what stopped the investigation from going down the same road
a third time.

`gridAudit()` exists because a hash tells you THAT two peers differ and never
WHICH input differs. It prints the stamp's entire preimage — anchor x/z/yaw, the
storey ladder, the level ys, the longest walls. First run: the anchors and ladders
were identical and only the yaw differed, at the fifth decimal. Second run, same
session: the yaw had *moved again*. That is not a disagreement between peers, it
is noise in one peer — the anchor yaw is read off a wall root's `matrixWorld`, and
the host LevelSystem lerps level groups every frame, leaving a residue that never
settles (+6.4e-6, −6.6e-5, +2.2e-5 rad across three audits).

The mistake was in the hash. `gridStamp` quantized the yaw on a 65536-step turn —
0.0055° per step, an order of magnitude *finer than the jitter*. **Quantization
does not remove disagreement, it moves it to the step boundary**, and the finer
the step, the likelier the straddle: a +ε and a −ε around zero are the same angle
and landed on step 0 versus step 65535, opposite ends of the turn. So two peers on
one lot fingerprinted differently and refused every slot-addressed piece the other
placed, in both directions, all session, while unaddressed damage kept landing —
the owner's sentence again, reached by a third road. Ironically the yaw was put in
the stamp to close a real hole (two peers agreeing on the anchor POINT while
disagreeing on its rotation build inside each other), and the precision it was
written with is what broke it.

The fix has two lines and only the first is load-bearing. `ANCHOR_YAW_SNAP` snaps
the *derived* yaw to 0.05° — 9× the observed residue, so both peers round to the
same multiple, and the lattice pays at most 0.025° of skew against the wall it
aligns to, 7 mm over a 16 m building, well under the 1 m cell it addresses. Then
`YAW_STAMP_STEPS = 360` buckets the hash to a whole degree, so a document angle
sitting exactly *on* one of those 0.05° steps still lands in one bucket. The
anchor point is quantized to the millimetre for the same reason, which is why the
anchor tests now assert positions to 3 decimals: **the anchor is a fingerprint,
not a measurement, and it may not be more precise than it is reproducible.**

### A fort has to outlive its builder

Second road to the same complaint, and the one that survived the first fix: the
authorship gate made each record's **only courier** the peer who wrote it. Leave
the room and your walls stop being re-published; the next visitor finds a lot
that has forgotten what was built on it. MULTIPLAYER.md had carried the answer as
a deferred design for weeks — **split the gate rather than remove it** — and it
is now implemented, at the seam between two speech acts. A *delta* stays strictly
authored: an increment is a claim about what the sender just did, and nobody puts
words in another peer's mouth. A *snapshot* is "here is the whole world as I know
it", which is the aggregate a joiner needs — and `snapshotOf` had **always**
emitted every author's records; the receiver simply threw the rest away. So
accepting them cost nothing on the wire and turned every peer into a replica of
the map.

It gives a hostile peer nothing new: it could always make a wall appear under its
own name, and it could always *delete* a stranger's wall, because tombstones are
unauthored by design ("a piece can always be destroyed") — editing is strictly
less destructive than the delete it already had. It still cannot resurrect a
tombstoned record (`dead` is monotone, checked on every merge) and it still
cannot get a stranger's work into anyone's document: the Save projection reads
authorship off the record id's own prefix, never off the envelope. The gate's
real job was always the Save boundary. It kept that job and lost the censorship.

### The ray picks the cell; the pitch picks the storey

"Problem placing floors as ceiling." The grid resolved the storey from where the
aim ray crossed, which is the right rule when the player has expressed no
preference — and the wrong one the moment they tilt up. Looking up past the pitch
band **is** the statement "one level up"; that intent now overrides the crossing
height (one up, one down for walls and ramps, or the slab under your own feet for
floors). Inside the band there is no intent and the crossing height stands. One
rule, three cases, and the ceiling lands where the player is looking.

### A door is a wall with its middle column knocked out

The cheapest true model available: an aperture is a plain `'wall'` whose 3×3 cell
mask — nine bits it already carried — is pocketed. `DOOR_MASK = 493`,
`WINDOW_MASK = 495`. Nothing new reaches the wire, the support graph, slot
occupancy or Keep's mask → node mapping, and yet the hole is **real** in the
mesh, in the collider and in the voxel grid, because all three already derive
from the mask (`geometryForMask`). Z steps solid → door → window inside the wall
family, the ghost previews the pocket before the click, and the leaf or sash the
mask implies registers on the same E lane as a host door.

### The E lane was quietly measuring height

Found while proving item 4, and it had been wrong for host doors too. The
point-blank fallback measured a **3-D** distance from the player to the leaf's
**centre** — and `playerRig.position` is the EYE, 1.58 m up, while a doorway
built on this 2.5 m storey is 1.67 m tall, so its centre sits ~0.7 m *below* the
eye and over half of the 1.2 m budget was spent going straight up. E stopped
answering at arm's length in front of an open doorway. "Shoulders against the
leaf" is a **horizontal** notion: the fallback now stands the player against the
doorway's own box in x/z, with a vertical band (`DOOR_FALLBACK_RISE`) whose only
job is to rule out the door one storey above or below. It also measures the
**mount** box, not the leaf: a doorway stays where its frame is however far the
leaf has swung out of it.

### THE HEADLESS CLOCK IS NOT THE GAME CLOCK — a QA finding that wrote a fake bug

Run 2 of `qa-boots-aperture.mjs` reported that the player could not walk through
a perfectly open doorway. It was the harness. Headless Chromium renders this
scene at **~3 fps**, and every frame loop clamps its delta (`dt = Math.min(rawDt,
1/30)`, the standard tunnelling guard, in eleven places). Game time therefore
runs ~10× slower than the wall clock: at the 6.5 m/s run speed each rendered
frame advances ~0.22 m, so a 1.8 s `KeyW` hold buys four frames — **0.8 m** —
which is *shorter* than the 1.15 m the harness stood back from the wall. Proven
on open ground with a throwaway probe: 1.48 m travelled in 1.8 s, ~0.21 m per
300 ms poll. The same error made the close look broken, because a passage prism
retires on the swing's **settle**, also measured in game seconds.

**Rule: never measure a game event in wall-clock milliseconds.** Both waits are
now polls on the thing itself — `walkUntil(displacement)` and
`settlePassages(count)` — which are frame-rate blind. And when the crossing
*does* fail, the harness dumps the occupancy of the **clear** volume only (inside
the pocket's width, under its lintel, pulled in by a cell), because the first
dump included the jambs and the lintel course and 70 legitimately solid cells
read as a filled doorway for an hour.

Same class of self-inflicted wound in section 6: the sash sits exactly half a
storey up, 1.25 m, which is 0.26 m *below* the eye — the harness tilted +0.18 rad
up and sailed clean over it, which looks precisely like a broken E lane. It now
derives the pitch from the sash's own centre.

### Left open, deliberately

**The storey rung on a sloped lot.** At the spawn on this lot the ghost's baseY
is 0 while the player's feet are at 1.23, so a wall placed there is half buried
and its doorway is underground — nothing to aim at, nothing to walk through. The
aperture harness walks out to flat ground and does its work there rather than
pretending otherwise. Separate bug, separate fix.

Green on the record: `qa-boots-aperture.mjs` end to end — Z cycles the wall
family with the HUD naming the selection, Q walks all six entries, the ghost
previews 493/495/511, the piece lands `mask 493`, its fitting registers among 20
operables, the crosshair finds it, E swings it, the prism's ceiling reaches the
wall top (the lintel fix), **crossed while OPEN: true / while SHUT: false**, E
re-closes it point-blank via the fixed fallback, the prism retires, and the
window sash swings while adding no prism. 0 page errors. `check-types` clean,
`bun test` 2377 pass / 0 fail.

## OTHER PEOPLE'S GUNS, AND OTHER PEOPLE'S PAINT (2026-09-01)

Two owner sentences drove this round. **"So last time I could not hear or see
other players shoot. I shoot. I see my gun and I could hear it. I want the others
to shoot the same. Everyone nearby should hear it close and everyone far should
just hear a little bit of it far. Opening on distance. And some visual too for
the shooting."** And, after the first spray fix landed: **"spray looks good, i
hope every player sees the same sprays and builds"** — a hope, which is the same
thing as a test that has not been written yet.

### A shot is a fact about the shooter, not a message about a bullet

The counter was already on the wire: presence carries a monotone rounds-fired
number per peer. So nothing new had to be published — a remote muzzle flash and
report are *derived* from a number going up, which means they cost nothing when
nobody is shooting and they cannot desync (a missed frame loses one flash, not
the state). The distance law is pure and therefore pinned by tests rather than by
ear: level on an inverse power so 2 m startles and 40 m is background, the top
end eaten by air absorption on a 20 m e-fold so the timbre **opens** from crack
to thump-and-roll exactly as asked, a propagation delay so the bang lags its own
flash (most of why a distant shot reads as *distant* rather than as *quiet*), and
a linear window to zero at 110 m so walking out of earshot fades instead of
clicking. Twelve peers on miniguns is 288 rounds a second, so a rolling
90 ms window voices at most six and silently drops the rest — a wall of
simultaneous cracks is indistinguishable from six of them.

The visual is a flash at the peer's actual muzzle plus a tracer stub, gated to
the three weapons that *have* a muzzle: a knife swing or a spray-can trigger
blooming a muzzle flash is worse than no effect at all.

### THE NAME A SURFACE TRAVELS UNDER — one definition, two lanes

"i hope every player sees the same sprays" turned out to be three defects deep,
and the first was an identity bug the damage lane had already solved months ago.

A host wall's node id comes from the document: it means the same thing in every
browser. A **player-built** wall's does not — `store.ts` numbers pieces from a
counter that restarts on every page load, so my second wall and yours are both
`__boots-piece-2`. The damage lane knew this and translated (`wireNodeId` out,
`localNodeId` in: a shared piece travels under its **record** id, which carries
its author and reads identically everywhere). The paint lane published the raw
local number. Two-client QA caught it in one line: A sprayed a wall it had built,
B folded the coat onto a wall of its own that happened to wear the same number —
or, more often, onto nothing at all. Those two functions are now exported and
shared, so there is exactly one answer to "the name a target travels under", and
a target named by NUMBER on the wire is **refused, never resolved** (`#` is
illegal in a peer id, so the two namespaces cannot be confused, and a forged
`__boots-piece-1` may not point at whatever of mine wears that number).

### The counters were the only witness

Every way a coat can fail to cross is silent from both ends: the sprayer's wall
goes blue regardless, and the peer sees a wall that was simply never painted,
which looks exactly like a quiet wire. So the lane counts — `published`,
`unnamed`, `folded`, `foldUnnamed`, `foldNoTarget` — the same lesson the grid
stamp taught with `gridStampPublishes`/`blindGrid`. The second defect was
readable *only* through them: `folded 1` on the receiver with **zero cells**
deposited. At writing range the cone is a few centimetres wide and its ball
clears every cell centre; the local spray has always coated the single nearest
cell instead, and the remote fold had no such rescue. The sprayer could read what
they wrote and nobody else could. Same rule now runs on both sides — and a ball
that misses by more than the cell's own reach still deposits nothing, exactly as
it does locally.

**And the harness itself was lying twice.** It compared node ids across clients —
but a player-built wall legitimately wears a different number on each screen, so
the only honest cross-client oracle is *cells that a client did not put there*
(`cells > 0 && remote > 0`). And it asked `identifyAim` what the crosshair was
on, which walks the three.js graph, while `sprayPaint` resolves against
colliders and voxel targets — so it reported `nodeId: null` for surfaces that
paint perfectly. Spray first, ask the ledger after.

### A record is delivered once, so anything that loses one loses it forever

The third defect is the deepest, and it is a property of the model rather than a
slip. Records are grow-only and re-delivery is idempotent, which is exactly why
nothing is ever re-sent. A **stroke** is grid-free, so a joiner accepts it
whatever lot it thinks it is standing on; a **piece** is slot-addressed, so the
same frame's walls can be refused (a stale stamp) or simply not have arrived. The
stroke was consumed either way — and the coat on a player-built wall was dropped
for the rest of the session. QA read it as `foldUnnamed 1` on the latecomer with
the wall standing right there.

So the fold now hands back what it could not place, and the build lane keeps it
(`pendingStrokes`, capped, newest-wins). Installing a piece re-offers the list —
and *that was not enough*: the install is a store write, and the wall is only
paintable once its mesh exists and has been voxelized, a frame or more later.
The next run said so precisely: `foldNoTarget`, with the wall standing. A piece
install is an **event**; "the surface became paintable" is a **state**, and
states want a heartbeat. The paint lane drains the waiting list four times a
second while it is non-empty.

### The ledger is derived; the records are the truth

Which finally explained the intermittency. The strokes were arriving, the names
were resolving, and the coat still vanished on some runs — with a bookkeeping
contradiction no coat census could explain: `foldNoTarget 1`, `folded 0`,
`pendingStrokes 0`. A record that was neither deposited nor waiting. Two new
counters answered it in one run: **`paintMounts 2`** — `PaintTool` mounts twice,
and its mount effect resets the ledger. A coat that folded before the second
mount was erased, and the record that carried it was long consumed.

The fix is the right category rather than a guard: the ledger is *derived state*
and the world keeps every live stroke forever, so a wiped ledger can be
**rebuilt** — `refoldSharedStrokes()`, asked for whenever the paint lane installs
its applier. Two consequences fell out of writing it honestly:

- **Folding is not idempotent against an already-folded ledger.** `foldCoats`
  accumulates, so re-offering a record deposits a second coat's worth of
  strength. "Folded" now means "deposited", tracked per record id — which also
  hardens the lane against a relay handing us what we already have.
- **Attribution is by AUTHOR, not by the path a record came down.** A rebuild
  re-folds our own strokes too, and the fold marks what it deposits as somebody
  else's work — that mark is what keeps a stranger's paint out of this player's
  Save. Attributing by delivery path would have quietly deleted the player's own
  paint from their own file.

Green on the record, three consecutive two-client runs: builds both ways,
destruction both ways, gunfire both ways with the counter moving on the peer,
**SPRAY SYNCED A→B true**, grid stamp healthy on both, a latecomer who gets the
whole map *and* the coat on a wall its builder never described to it, 0 page
errors on all three clients. `check-types` clean, `bun test` 2444 pass / 0 fail.

## THE MIRROR — the one thing a first-person game hides from you (2026-09-01)

Owner ask, verbatim: *"maybe somewhere in the depot with the guns you can have a
mirror so people check themselves"*. It is a small feature with one hard
requirement hiding in it: whatever it shows has to be **exactly** what the rest
of the lobby sees. A mirror that flattered you, or that ran its own rig, would be
worse than no mirror — it would be a lie about the only thing it exists to report.

So the dummy behind the glass is not a model of a Pascaline; it *is* the peer rig.
`remote-players.tsx` grew `AvatarRig` + `createRigRefs`, and the component every
remote player renders and the one standing in the cabinet are now the same
declaration, posed through the same `advanceGait`/`articulate` rules, wearing the
tint the roster deal reserved for our own id (`localPaletteIndex` — the deal is
published as it is made, so the mirror cannot invent a color the lobby doesn't
know). If it looks right in there, that *is* what they are looking at.

**It is a deliberately shallow mirror, and the math says so.** A true reflection
stands as far behind the glass as you stand in front of it — through a steel wall,
three metres into the yard. `reflectStand` keeps the part of a reflection that
carries information and compresses the part that would only lose you: depth
clamped into the 0.5 m cabinet, lateral offset geared to 0.35 and capped, so
backing off or stepping aside moves the reflection (a fixed dummy reads as a
poster) but never slides it out of its own frame. Heading is *not* compressed:
`reflectYaw` is the textbook plane mirror, π − φ, because a mirror that turned
the wrong way reads as broken instantly. 18 unit tests pin that, including a
sweep of the whole deck asserting the reflection is inside the box from every
spot a player can stand.

### What the tests could not know, and the harness caught in one run

`qa-boots-mirror.mjs` finds the pane **by name in `world.colliders`** and reads
its live `matrixWorld` — position and its own normal — so it works in the scene's
frame and re-derives nothing about the depot. Three findings, none of which a
pure test could have produced:

- **A doubled frame.** The cabinet group was translated to `MIRROR_PANE_X` while
  `reflectStand` returns absolute depot-local x, so the reflection stood 2.3 m
  sideways, through the far end wall. The harness said `lateral 2.32`. The group
  is now untranslated: one frame, the depot's.
- **A mirror under the horizon.** The sill was 16 cm off the deck plate, so the
  first screenshots were taken looking 30° *down* into a cabinet around your
  knees — and the second pair, from a camera the teleport had put above the 2.6 m
  roof, because `teleport` takes feet and the harness was passing pane-height. The
  cabinet moved up (`MIRROR_SILL_Y` 0.5, plinth riding it) so the dummy's chest
  lands on the standing eye line, with a test that says so in those words.
- **A blown-out white Pascaline.** The cabinet light at chest height on intensity
  3.5 washed the vest to paper. A mirror you cannot read your own color in is not
  a mirror; it now rakes down from the top of the box at 1.1.

Two of the three were only ever going to be found by *looking at the picture*.

**The gait check needed three attempts, and the third is the honest one.** The
question "does it freeze when you stop?" has no reliable wall-clock answer in
headless: dt is capped to 1/30 s at ~3 fps, so deceleration takes seconds, and
the depot can be seated where the deck never quite lets you stop (1.5 s caught it
coasting at 0.053 rad; 6 s off a sprint caught 0.435). But `articulate` scales the
entire gait by speed — so on any frame the game itself reports stopped, the swing
must be *exactly* zero. The harness hunts for one such frame instead of waiting
for one. Final: `stopped at 0.000 m/s with swing 0.000000 rad`, against a walking
swing spread of 0.529 rad.

Green: pane registered as `__boots-depot`/`fixture` (armored — nobody walks into
the alcove to be seen from behind, bullets spark on the glass), asleep across the
lot and awake at the pane, behind the glass and inside the box, facing you at
1.000, a +0.5 rad turn mirrored to −0.500, wearing a lot tint, 0 page errors —
and two screenshots that finally look like a mirror. `check-types` clean,
`bun test` 2462 pass / 0 fail.

## 2026-09-01 — The mirror, second cut: a real reflection

The owner's verdict on the cabinet was short, and the replacement was chosen in
one breath: *a full-size local Pascaline the main camera can't see, and the
depot rendered from a mirrored camera into a render target mapped on the glass —
a genuine planar reflection at 1:1, you, the room, the gun rack behind you,
costing one small extra pass only while someone is in front of it.* So the
0.62-scale dummy, the plinth, the 0.5 m box and every clamp in `reflectStand`
are gone. What hangs on the back wall now is a flat full-length mirror, and what
it shows is the scene.

### The optics are one sentence, and a module

A plane mirror shows at pane point Q exactly what a camera at the REFLECTED eye
sees through Q. `mirror-view.ts` is that sentence made executable: reflect the
eye across the pane, stand a camera there looking straight along the normal,
and fit an off-axis frustum whose near rectangle IS the glass. Because the
camera looks along the normal with world up, the pane is axis-aligned in camera
space and the frustum bounds are plain offsets from its centre. And because the
near plane sits *on* the glass, the container's own back wall two centimetres
behind it is clipped before it can occlude the room — the handoff notes had
left `near` unspecified, and without this the mirror is a picture of the inside
of a steel wall.

Two things the handoff had wrong, both caught before a line was written:
`playerRig.position` is the EYE, not the feet (the wire carries eye positions;
the body is planted at eye − EYE_HEIGHT exactly as remote-players plants a
peer); and the renderer's own `_updateCamera` calls `updateProjectionMatrix()`
the first time it meets a camera, which on a stock PerspectiveCamera rebuilds a
symmetric frustum over the hand-built one. `MirrorCamera` owns that method and
rebuilds the pane frustum in whatever depth convention the renderer just asked
for — the same texels on WebGL and WebGPU, reversed depth included, with a test
that flips the convention mid-flight and checks.

### What the picture taught, again

The first live run rendered a perfect reflection — and hung it upside down on
the glass. three's node renderer reads a render target with v = 0 at the TOP of
the picture on both backends (WebGPU natively; the GLSL builder flips
render-target lookups to match, and three's own post-processing QuadMesh carries
a top-down UV layout for this very reason). A plain PlaneGeometry has v = 1 at
the top. So the pane's UVs are turned in both axes: u for the mirror (the
virtual camera's right is the pane's −x), v for the renderer. The harness now
reads the SCREEN back too — decodes its own screenshot, projects the pane's
corners through the live camera pose, and checks the vest sits above the belt
and boots inside that rectangle — because the target can be right while the
glass is wrong.

The tint check needed a median: the yard's red fence posts show in the glass
as well, a few dozen texels that dragged a mean a hand's width off the vest.

### Verified where it can be

`mirror-view.test.ts` (17) projects real points through real three matrices at
five pane yaws: the four pane corners land on the four image corners from any
stand; a hair behind the glass is clipped and a hair in front is not; for
random eyes and room points the texel found through the turned UVs is exactly
where E'→R crosses the plane; your boots, chest and hat share your own x.
`qa-boots-mirror.mjs` (14 checks) on the WebGL fallback: no pass across the
lot, the pass every frame at the glass, none with your back turned, a picture
not a color, our own tint centred at chest height, a step along the wall moving
the picture the way a mirror moves it (both ways), the 1:1 body on your feet
facing the glass, striding and freezing with you, the viewmodel findable by
name — and upright on screen. Then the same on WebGPU, headless for the target
(the picture is identical) and headed for the screen (headless Chromium does
not composite a WebGPU canvas into a screenshot). `check-types` clean, `bun
test` 2472 pass / 0 fail.
