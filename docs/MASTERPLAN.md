# Boots — master plan

**The pitch:** press *Jump in* and the whole editor becomes a game. First person,
fluid movement, a knife in your hand, guns on a table. Shoot the walls and they
crumble piece by piece — voxel-style — revealing the framing inside. Glass cracks
around bullet holes, then shatters. Build new walls battle-builder style. Press `Esc`
and you're back in your editor **as if nothing happened** — unless you choose to
*keep* what you built.

Two audiences, one plugin: people who edit buildings and want to feel them from
the ground, and people who just want to play in the thing they modeled.

---

## Principles

1. **Non-destructive by default.** The game NEVER writes to the scene store
   while playing. Destruction, paint, debris — all of it lives in game-side
   overlays (host meshes get `visible = false`, we render replacements).
   `Esc` restores everything. The only path that touches the real scene is the
   explicit **Keep** action after a session, which converts built pieces into
   real nodes in one undoable batch.
2. **WebGPU-safe.** The host renders through `WebGPURenderer` + TSL pipeline.
   Everything we add is CPU math + standard materials + `InstancedMesh`.
   No custom shaders, no WebGL calls, no depth tricks (see Bones' scars).
3. **60fps floor, 120 target.** Instancing everywhere, BVHs built once per
   damaged mesh, debris ring-buffered and capped, grass in one draw call,
   zero per-frame allocations in the hot loop.
4. **Editor stays sovereign.** While the game runs, capture-phase listeners
   swallow every input the host would otherwise interpret (tool hotkeys,
   selection clicks, camera controls). On exit, the camera pose is restored.

## Architecture

```
Panel (DOM)                     Canvas (R3F, mounted via def.system)
┌─────────────┐   zustand   ┌──────────────────────────────────────┐
│ Jump in     │◄──────────►│ GameRoot (phase === 'game')           │
│ Keep/Discard│  useBoots  │ ├─ Player (fps movement + BVH collide) │
└─────────────┘             │ ├─ Viewmodel (knife/pistol/rifle)     │
     HUD (DOM overlay,      │ ├─ Destruction (voxel walls, glass,   │
     appended next to       │ │   debris, stud reveal)              │
     canvas for fullscreen) │ ├─ GunTable, Builder ghosts           │
                            │ ├─ Nature (grass field, flora)        │
                            │ └─ Bots (steering AI)                 │
                            └──────────────────────────────────────┘
```

- **Mount point:** `jobDefinition.system` — the host mounts a kind's system
  component inside the canvas whenever the plugin is installed in the scene,
  independent of node count. GameRoot renders `null` until `phase === 'game'`.
- **Store:** module-level zustand (`useBoots`) — panel, HUD, and canvas
  systems all read it; survives panel unmounts.
- **World snapshot on enter:** walk `sceneRegistry` (node id → Object3D),
  collect collidable meshes, build the building AABB, find spawn, hide grid
  noise. BVHs (three-mesh-bvh, already shipped by the host via drei) are
  computed lazily per geometry.

## Game systems

### Movement (the tactical-shooter feel)
Classic arena-shooter kinematics, hand-rolled (~150 pure-math lines, unit-tested):
ground accelerate + friction, capped air-accelerate (real air-strafing),
gravity, jump buffering, step-offset. Capsule vs world via BVH `shapecast`
(the three-mesh-bvh `characterMovement` pattern), slide on planes, ground
snap. Eye 1.62 m, run 5.2 m/s, walk-shift 2.6, gravity 15.5, jump 5.0.
Subtle view-bob + land-dip. FOV 90 during game, restored on exit.

### Weapons (SHIPPED, phases 1–3)
Start with the **knife**. A **gun table** spawns near the player: walk up,
`E` to take. Arsenal (generic names, original everything):
- Knife — 2 swings/s, chips one voxel, range 1.8 m
- Pistol — semi-auto, 12+∞, precise, small holes
- Rifle — full-auto 600 rpm, 30+∞, spread grows, bigger holes
- **Rotary gun ("THE BIG ONE", slot `5`)** — lives on its OWN second table
  a bit behind spawn. Multi-barrel viewmodel with visible barrel spin;
  hold-to-fire spins up before rounds land, then fires near-continuously —
  sweep the building and it levels (QA: 120-shot sweep, 463 voxels → 0,
  dust at caps, fps held).
Hitscan via BVH raycast. Muzzle flash = 2-frame emissive quad. Tracer = fading
line. Recoil = camera kick + viewmodel spring. `1/2/3/5` + wheel to switch,
`R` reloads.

### Destruction (the reason to live) — SHIPPED through the multilevel pass
Walls are a real **sandwich**, torn down layer by layer:
- **Pre-voxelized cladding:** walls swap to their voxel replica ON JUMP-IN
  (not on first hit) — the building already reads as voxels at spawn, with
  tile joints and per-instance color jitter. Yaw-local grids keep diagonal
  walls clean. Bullets zero voxels in a radius; knife chips one.
- **Drywall sheets:** behind the cladding sits a drywall skin built from
  flat SHEETS — hits tear ragged flat plates off (paper-tear read, shards
  flutter in the dust); enough damage flings whole sheets. Both faces of
  the sandwich have skins, so a through-hole shows daylight.
- **Charcoal-stick framing:** OBB studs at real lumber cross-section
  (skinnier than a voxel), hp-tracked, snap like charcoal sticks — break a
  wall, see its bones. Bones-plugin overlay roots (CMU/framing renderers)
  are hidden for the whole session via `bones:*` prefix sweep +
  `isOverlayName` predicate; `__boots.countCoplanarSuspects()` is the
  tripwire (must stay 0).
- **Island collapse:** disconnected voxel islands (flood-fill, throttled,
  volume-aware) crumble same-frame — line-cut a wall or sever a shower/
  table legs and the top drops. Nothing floats.
- **Glass:** transparent panes under window nodes take crack decals per hit;
  3rd hit (or two overlapping cracks) shatters the pane — instanced shards
  fall, spin, fade. Radial-crack texture drawn on a canvas at runtime.
- **Debris + dust:** instanced ring buffers (debris 768, dust 256 puffs +
  24 haze) — gravity, one bounce, shrink-out; big hits read like a
  slow-lobby shootout, dust and pieces everywhere. No physics engine.
  WebGPU gotcha: prime `instanceColor` on every slot BEFORE first draw or
  the pipeline compiles without it and instances render white forever.

### Sounds
All procedural WebAudio (no assets, no copyright): noise-burst gunshots with
low thump + delay tail, filtered-noise footsteps cadenced by speed, knife
swish (bandpass sweep), voxel crunch, glass shatter (inharmonic partials),
pickup clack, build thunk. One AudioContext, master limiter.

### Builder mode (battle-builder grammar) — SHIPPED, 3x3 editing
Slot `4` (or `B`): build tool with three pieces — **wall / floor / roof**
(everything vertical is a wall, everything inclined is a ROOF — never
"ramp") — `Q` cycles. Ghost preview slot-locked to the occupancy lattice
(grammar v2), `R` rotates, stacking + hold-to-place runs, `Z` undoes
(`G` is the grenade); LMB places a solid, collidable,
immediately-destructible panel.
**3x3 masks:** each wall piece is a 3x3 cell grid (9-bit mask). Shoot out
the center cell = window pocket; kill a side column = shorter wall; any
pocket reads as an opening — and the mask drives the COLLIDER too (shots
and players pass through pockets).
Placements accumulate in the store (never in the scene). After `Esc`, the
panel shows **Keep** / **Discard**: Keep converts pieces into real nodes in
one undoable batch — walls become `wall` nodes, a center pocket maps to a
real WINDOW node on that wall, roof pieces map best-effort onto shed
`roof-segment` nodes (see keep.ts doc block), fully-dead pieces are
skipped. Paint tool (roadmap): spray-tint a wall's game copy; Keep patches
the node's material.

### You don't die (the death dynamic)
No respawn, no teleport-to-spawn — dying breaks the flow and the fiction.
Instead, a pressure curve:
- **Hits shove you.** Damage applies a directional knockback impulse (you
  get pushed around by the horde) + a directional red edge-flash.
- **Low health** (< 35): pulsing red vignette, heartbeat, and the world's
  audio dips through a low-pass — concussion, not UI.
- **Zero health → STAGGERED**, not dead: ~2.5 s of heavy red pulse, halved
  speed, lowered weapon (can't fire), bots ease off and circle instead of
  piling on. Then you shake it off: health snaps to 40 and regen resumes.
- **Regen:** 4 s without damage → +12 hp/s back to 100. Classic, readable,
  keeps the run going forever. The game is about the chaos, not the fail
  state.

### Session pacing (grace, then the countdown)
Jumping in starts **peaceful** — walk the build, break a wall, place
pieces, no threats. The horde only wakes when you arm yourself: the moment
you gear up at the table, a small line appears top-center — a slow 5-count
("They heard you — 5…") — then wave 1 rolls in. Building/knife-only
sessions stay peaceful by design: the gun is the opt-in.

### Builder-first (the generation after ours)
The first touch is "oh, it's a game" — but the retention loop is **they
build**. This plugin is the editor's on-ramp for players raised on
build-battle and block games, not on home-design software:
- Build mode is a first-class weapon slot, not a menu.
- Pieces snap to each other (adjacency grid like build-battle games), hold
  to place runs of wall, G undoes, everything you place is immediately
  solid, walkable, and destructible like the rest of the world.
- After Esc, **Keep** turns the session's pieces into real, editable scene
  nodes — play becomes authorship. That bridge is the whole thesis.

### Bots — SHIPPED (waves)
Gear up at the table → siren countdown → robot waves (droid/dog/drone)
spawn at the lot edge and steer toward the player (seek + obstacle
ray-probe, WALL RULE: path around, never through, until breached), melee
for knockback + vignette damage. Hitscan-damageable, fall-and-fade death,
mercy ring while staggered. No navmesh yet (Yuka later if hordes grow).

### Nature (the lot) — SHIPPED, combat trees
Replace the flat gray void: a big grass-green ground disc (canvas-noise
texture), ~25k instanced grass blade clusters in a density-falloff ring
OUTSIDE the building AABB, low-poly instanced trees farther out. One draw
call per species, no shadows on flora, static (no wind in v1). Grass and
trees are rejected off Streetscape road footprints and flat ground pads
(`collectRoadFootprints` + `pointOnRoad`).
**Trees are combatants** (trees-destruct.tsx): shoot a trunk and the tree
voxelizes in its own colors and fells straight down to a stump; canopy
hits IGNITE it — flame wisps + smoke, charring crown — then it chars into
charcoal sticks that snap into voxel bursts down to a stump. Voxel bursts
and char debris render in material colors (instanceColor primed at mount).

### Sky — SHIPPED
Procedural overcast dome (sky.tsx, CanvasTexture — no shaders): mostly
warm gray, a touch lighter than pure overcast, with a few subtle brighter
breaks and softer dark patches. NEVER blue — QA asserts the blue channel
sits at/below the gray channels (blueness ≤ 0) and the luminance spread
stays subtle.

## HUD
DOM overlay inside the fullscreen element (the canvas' parent): crosshair,
weapon + ammo, health, pickup/build prompts, hitmarker ticks, damage
vignette, and the pill: **Esc to exit**.

## Delivery ladder

- **T1 — SHIPPED:** game mode infra, movement+collide, knife+pistol+rifle,
  gun table, HUD, audio, nature, voxel wall destruction + debris + stud
  reveal, glass shatter, clean exit/restore.
- **T2 — SHIPPED:** builder mode + Keep/Discard into real nodes; doors on
  `E`, material audio, no-death stagger + regen, waves + mercy ring.
- **T3 (phase 3) — SHIPPED (commit 55eeb3c):** wall sandwich anatomy
  (pre-voxelized cladding, drywall sheet tearing, charcoal-stick studs),
  rotary gun + rear table, combat trees (fell/burn/char to stump), dust
  storm, 3x3 wall masks + window Keep, overcast never-blue sky, volume
  island collapse, Bones overlay hide. QA r3/r4 full pass, 60 fps in-game.
- **T4 (phase 4) — SHIPPED:** warhammer (slot 6), infinite mega-grenade
  on `G` (stick model, wind-up, tumbling flight, staggered blast rings +
  ground craters), ADS on right-click (rifle semi-auto, −75% spread),
  siren-beacon countdown theatre, material-keyed dust (drywall max /
  concrete small / wood splinters-only), boots + placards on the tables,
  bots path AROUND walls until breached, structural 30%-support collapse
  + hanging-stick rule, resurrection sweep, pipeline pre-warm. P4R3
  hardening: window interaction hitboxes never become solid colliders,
  hosted door/window children survive their wall's voxelization
  (mask-hide via `solidRoots` fence — doors render, open, and clear).
- **T5 (phase 5) — SHIPPED:** BUILD GRAMMAR V2 integrated — slot-locked
  ghost (grid.ts targeting), piece-slots.ts as the single occupancy
  authority (grounding, collapse rings, turbo lockout), `Z` undoes,
  E-interact on doors/windows/cabinets, turbo clad FIFO budget.
- **Multilevel (MULTILEVEL-PLAN A–B3) — SHIPPED:** whole-building
  presence (all storeys stacked + collidable, spawn on lowest ground,
  stairs walkable), quaternion voxel grids (full orthonormal basis, so
  pitched roofs voxelize along their own plane and still read as roofs),
  slab sandwich (floors/ceilings get the wall anatomy on its side:
  sheathing/ceiling skins, joists, both-face sheets, tear-lane routing,
  under-column support probe, sampled crumble debris), support cascade
  (cross-target probe + staggered whole-wall crumbles).
- **T6 (next):** shape-preserving item destruction (glass-like sub-meshes
  through the glass system, fine-cell silhouette voxelize), pyramid
  grammar (roof 2x2 corner heights, floor quadrant masks), paint tool,
  real Bones members as framing when Bones is installed, bots opening
  doors, co-op.

## Risks & mitigations
- Host camera controls fighting the game camera → write pose in a late
  `useFrame` (last write wins) + swallow inputs at capture phase.
- Voxelization cost on huge walls → adaptive cell size, cap ~1.5k voxels per
  wall. (Phase 3 moved voxelization to jump-in — pre-voxelized cladding —
  so the cost is paid once at session start, not mid-fight.)
- `bun install` file-dep symlinks (private repo) → rsync real copies into
  both hosts after every install (see project memory); pin `github:#sha`
  once the repo goes public.
- Scene-draft autosave — the game never writes the store, so autosave can't
  persist accidents.
