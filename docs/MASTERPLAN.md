# Boots — master plan

**The pitch:** press *Jump in* and the whole editor becomes a game. First person,
fluid movement, a knife in your hand, guns on a table. Shoot the walls and they
crumble piece by piece — voxel-style — revealing the framing inside. Glass cracks
around bullet holes, then shatters. Build new walls Fortnite-style. Press `Esc`
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
│ Keep/Discard│  useBoots  │ ├─ Player (CS movement + BVH collide) │
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

### Movement (the CS feel)
Quake-family kinematics, hand-rolled (~150 pure-math lines, unit-tested):
ground accelerate + friction, capped air-accelerate (real air-strafing),
gravity, jump buffering, step-offset. Capsule vs world via BVH `shapecast`
(the three-mesh-bvh `characterMovement` pattern), slide on planes, ground
snap. Eye 1.62 m, run 5.2 m/s, walk-shift 2.6, gravity 15.5, jump 5.0.
Subtle view-bob + land-dip. FOV 90 during game, restored on exit.

### Weapons
Start with the **knife**. A **gun table** spawns near the player: walk up,
`E` to take. v1 arsenal (generic names, original everything):
- Knife — 2 swings/s, chips one voxel, range 1.8 m
- Pistol — semi-auto, 12+∞, precise, small holes
- Rifle — full-auto 600 rpm, 30+∞, spread grows, bigger holes
Hitscan via BVH raycast. Muzzle flash = 2-frame emissive quad. Tracer = fading
line. Recoil = camera kick + viewmodel spring. `1/2/3` + wheel to switch, `R`
reloads.

### Destruction (the reason to live)
- **Voxel walls:** first bullet on a wall hides the host wall object and
  swaps in a voxel replica: the wall's meshes are voxelized (~0.15 m cells,
  BVH containment test — door/window cutouts come free), rendered as ONE
  `InstancedMesh` with per-instance color jitter (that Minecraft shade).
  Bullets zero out voxels in a radius; knife chips one; every removal spawns
  debris. Disconnected islands (flood-fill, throttled) crumble and fall.
- **Stud reveal (the Bones handshake):** walls thicker than 9 cm get interior
  framing — studs at 16" o.c. along the wall axis, plates top/bottom —
  generated from the wall node's `start/end/height/thickness`. Invisible
  until the shell voxels in front of them are gone. Break a wall, see its
  bones. (Later: read real members from plugin-bones when it's installed.)
- **Glass:** transparent panes under window nodes take crack decals per hit;
  3rd hit (or two overlapping cracks) shatters the pane — instanced shards
  fall, spin, fade. Radial-crack texture drawn on a canvas at runtime.
- **Debris:** one global instanced ring buffer (512). Gravity, one ground
  bounce, shrink-out. No physics engine.

### Sounds
All procedural WebAudio (no assets, no copyright): noise-burst gunshots with
low thump + delay tail, filtered-noise footsteps cadenced by speed, knife
swish (bandpass sweep), voxel crunch, glass shatter (inharmonic partials),
pickup clack, build thunk. One AudioContext, master limiter.

### Builder mode (Fortnite grammar)
Slot `4` (or `B`): build tool with three pieces — **wall / floor / ramp** —
`Q` cycles. Ghost preview snapped to a 0.5 m grid + 90° yaw in front of the
player; LMB places a solid, collidable, immediately-destructible panel.
Placements accumulate in the store (never in the scene). After `Esc`, the
panel shows **Keep** / **Discard**: Keep converts wall panels into real
`wall` nodes (`start/end/height/thickness`) in one batch (undoable); floors
become `slab` nodes if the schema cooperates, else stay game-only (labeled).
Paint tool (slot `5`, roadmap): spray-tint a wall's game copy; Keep patches
the node's material.

### Bots (roadmap, v1-simple)
"Intruders" toggle: 3–5 capsule bots spawn at the lot edge, steer toward the
player (seek + obstacle ray-probe), melee for vignette damage. 100 hp,
hitscan-damageable, fall-and-fade death. No navmesh in v1 (Yuka later).

### Nature (the lot)
Replace the flat gray void: a big grass-green ground disc (canvas-noise
texture), ~25k instanced grass blades in a density-falloff ring OUTSIDE the
building AABB, low-poly instanced trees/bushes/rocks farther out. One draw
call per species, no shadows on flora, static (no wind in v1).

## HUD
DOM overlay inside the fullscreen element (the canvas' parent): crosshair,
weapon + ammo, health, pickup/build prompts, hitmarker ticks, damage
vignette, and the pill: **Esc to exit**.

## Delivery ladder

- **T1 (tonight):** game mode infra, movement+collide, knife+pistol+rifle,
  gun table, HUD, audio, nature, voxel wall destruction + debris + stud
  reveal, glass shatter, clean exit/restore.
- **T2 (tonight if it holds):** builder mode + Keep/Discard into real nodes.
- **T3:** bots, paint tool, real Bones members, rounds/objectives, co-op.

## Risks & mitigations
- Host camera controls fighting the game camera → write pose in a late
  `useFrame` (last write wins) + swallow inputs at capture phase.
- Voxelization cost on huge walls → adaptive cell size, cap ~1.5k voxels per
  wall, voxelize lazily on first damage only.
- `bun install` file-dep symlinks (private repo) → rsync real copies into
  both hosts after every install (see project memory); pin `github:#sha`
  once the repo goes public.
- Scene-draft autosave — the game never writes the store, so autosave can't
  persist accidents.
