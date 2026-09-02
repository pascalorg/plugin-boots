'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { CanvasTexture, type Group, Matrix4, type Mesh } from 'three'
import { useBoots } from '../store'
import { DEPOT_NODE_ID, DEPOT_NODE_TYPE, depotWorldYaw, worldToDepotLocal } from './guntable'
import { MOVE } from './movement'
import { playerRig } from './player'
import {
  advanceGait,
  articulate,
  type AvatarArticulation,
  AvatarRig,
  createArticulation,
  createRigRefs,
  localPaletteIndex,
  subscribeLocalPalette,
} from './remote-players'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'

/**
 * THE DEPOT MIRROR (owner ask, 2026-08-31: "maybe somewhere in the depot with
 * the guns you can have a mirror so people check themselves").
 *
 * A first-person game hides the one thing every player in a lobby wants to see:
 * themselves. Your teammates know you as the amber one; you have never seen it.
 * So the depot gets a wall cabinet with a glazed front, at the empty end of the
 * back wall past the gun rack, and standing in it is a Pascaline who copies you.
 *
 * IT IS THE SAME RIG AS EVERY PEER, on purpose. The dummy is <AvatarRig/> — the
 * exact body remote-players.tsx mounts for the people around you — posed through
 * the exact same advanceGait/articulate rules, wearing the tint the lot's roster
 * deal reserved for our own id (localPaletteIndex) and holding whatever the store
 * says is in our hands. There is one definition of how a Pascaline looks and
 * moves, so the mirror cannot drift from the truth other players see: if it looks
 * right in here, that IS what they are looking at.
 *
 * IT IS A SHALLOW MIRROR, AND THE MATH SAYS SO. A real reflection stands as far
 * behind the glass as you stand in front of it — three metres back, through a
 * steel wall. This one is a 0.5 m cabinet, so `reflectStand` keeps the part of a
 * reflection that carries information (which way you face, that you lean and
 * stride and lower your gun) and COMPRESSES the parts that would only lose you:
 * depth is clamped to the cabinet, and lateral offset is geared down so backing
 * off or stepping aside never slides you out of your own frame. Heading is the
 * honest reflection — `reflectYaw` is the real plane mirror (bearing kept, depth
 * reversed), because a mirror that turned the wrong way would read as broken
 * instantly, and pitch passes through untouched for the same reason.
 *
 * ARMORED AND SEALED like the rest of the depot: the cabinet shell and the glass
 * register as '__boots-depot' / 'fixture' colliders, so nobody walks into the
 * alcove to be seen from behind, bullets spark on the pane, and grenades wash
 * over it. The dummy itself is pure decoration — never a collider, never a
 * target, and `visible` is false unless someone is close enough and in front,
 * so a lot nobody is preening in costs one boolean per frame.
 *
 * One always-mounted point light sits inside the cabinet at CONSTANT intensity
 * (the depot's WebGPU rule: never add or remove a light mid-session — the siren
 * animates intensity only). Without it the alcove is a black hole, and a mirror
 * you cannot see your vest color in is not a mirror.
 */

// ── Cabinet geometry, depot-local (pure, tested) ─────────────────────────────
// The depot's frame: +x toward the breaker end wall, +z out the opening, y up
// from the ground the container is seated on. Its interior deck plate tops out
// at 0.12 and the back wall's inner face is at z = -1.15; the gun rack's rails
// span x ∈ [-1.65, 1.65] and the far end wall's inner face is x = -2.9, which
// leaves exactly one clear panel of back wall — and that is where the mirror
// goes, at the build-bench end, in the ~1.2 m nobody else was using.

/** Pane center, depot-local x. */
export const MIRROR_PANE_X = -2.3
/** The pane plane, depot-local z: the front face of the cabinet. */
export const MIRROR_PANE_Z = -0.65
/** Pane opening [width, height] (m). */
export const MIRROR_PANE_SIZE: readonly [number, number] = [0.92, 1.34]
/** Bottom of the pane opening (depot-local y). The deck plate you stand on tops
 * out at 0.12 and your eyes are 1.58 above that (EYE_HEIGHT), so a sill near the
 * deck makes a mirror you have to look 30° DOWN into — QA's first screenshots
 * were of a cabinet under the horizon. Set high enough that the dummy's chest
 * lands on your eye line (see the ergonomics test) and the top still clears the
 * container roof. */
export const MIRROR_SILL_Y = 0.5
/** How far the cabinet recedes behind the pane (m). */
export const MIRROR_DEPTH = 0.5
/** The plinth's top — where the dummy's feet stand (depot-local y). Rides the
 * sill by a fixed 0.14, so raising the cabinet lifts the reflection with it. */
export const MIRROR_PLINTH_TOP = MIRROR_SILL_Y + 0.14
/** The rig's sole sits ~3.5 cm BELOW its own origin (a peer's root is planted
 * on the ground, not on their feet), which at dummy scale is ~2 cm of boot
 * buried in the plinth. Lift by exactly that, so she stands ON it. */
export const MIRROR_FOOT_LIFT = 0.022
/** Dummy scale: a 1.85 m Pascaline reads ~1.15 m tall, which is what a
 * reflection of someone a stride away subtends — and it fits the opening. */
export const MIRROR_DUMMY_SCALE = 0.62
/** Nothing animates unless the player is within this distance of the pane (m). */
export const MIRROR_RANGE = 4.5
/** Closest the dummy's center comes to the glass (m) — its own body is ~0.2 m
 * deep at this scale, so 0 would push a nose through the pane. */
export const MIRROR_MIN_STANDOFF = 0.1
/** Deepest the dummy's center goes (m) — the cabinet's back panel, minus body. */
export const MIRROR_MAX_STANDOFF = 0.36
/** Lateral parallax: a fraction of how far off-center you actually stand, so
 * stepping aside slides the reflection A LITTLE (it has to move, or it reads as
 * a poster) but never out of the frame. */
export const MIRROR_LATERAL_GAIN = 0.35
/** Hard cap on that slide (m) — inside the pane's half-width. */
export const MIRROR_LATERAL_MAX = 0.22

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Wrap to (-π, π] so a mirrored heading stays canonical. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2
  let out = a % twoPi
  if (out > Math.PI) out -= twoPi
  if (out <= -Math.PI) out += twoPi
  return out
}

/**
 * The reflected heading, in the depot's own frame.
 *
 * The pane's normal is the depot's z axis, so this is the textbook plane
 * mirror: the facing direction's lateral component survives and its depth
 * component flips. With the rig's convention (a Pascaline at local yaw φ faces
 * (-sin φ, -cos φ)) that comes out as π - φ — turn to look at the glass and the
 * reflection turns to look back at you; step sideways along the wall and it
 * keeps the same bearing, exactly like the real thing.
 */
export function reflectYaw(localYaw: number): number {
  return wrapAngle(Math.PI - localYaw)
}

/**
 * Where the reflection stands, depot-local [x, z] — the compressed mirror (see
 * the header). Standing anywhere in the container gives a point inside the
 * cabinet: depth clamped into [MIN, MAX] standoff behind the glass, lateral
 * offset geared down and capped.
 */
export function reflectStand(lx: number, lz: number): [number, number] {
  const lateral = clamp(
    (lx - MIRROR_PANE_X) * MIRROR_LATERAL_GAIN,
    -MIRROR_LATERAL_MAX,
    MIRROR_LATERAL_MAX,
  )
  const standoff = clamp(lz - MIRROR_PANE_Z, MIRROR_MIN_STANDOFF, MIRROR_MAX_STANDOFF)
  return [MIRROR_PANE_X + lateral, MIRROR_PANE_Z - standoff]
}

/**
 * Is anyone actually looking? Within MIRROR_RANGE of the pane AND in front of
 * it (a player behind the back wall — outside the container — is looking at
 * corrugated steel, and there is nothing to animate for them).
 */
export function mirrorEngaged(lx: number, lz: number): boolean {
  if (lz <= MIRROR_PANE_Z) return false
  return Math.hypot(lx - MIRROR_PANE_X, lz - MIRROR_PANE_Z) <= MIRROR_RANGE
}

// ── Paint (matches the depot's palette) ──────────────────────────────────────
const CABINET = '#464f57'
const CABINET_DARK = '#333a41'
const FRAME = '#6d7076'

/** Reused across frames — the mirror allocates nothing per frame. */
const _artic: AvatarArticulation = createArticulation()

/**
 * The cabinet, the glass, and the dummy inside. Rendered as a CHILD of the
 * depot's root group, so every number above is in the depot's own frame and the
 * whole thing rides the container's placement and yaw for free.
 */
export function DepotMirror({ world }: { world: GameWorld }) {
  const dummyRef = useRef<Group>(null)
  const shellRefs = useRef<(Mesh | null)[]>([])
  const solid = (i: number) => (mesh: Mesh | null) => {
    shellRefs.current[i] = mesh
  }
  // One stable handle object for the rig's pivots (createRigRefs, not eight
  // useRef calls — the rig's shape is the rig's business).
  const refs = useRef(createRigRefs()).current
  const gaitPhase = useRef(0)
  const shown = useRef(false)
  // The dummy holds what we hold. A store subscription, so a weapon swap
  // re-renders the rig exactly once, like a peer's does off the wire.
  const weapon = useBoots((s) => s.weapon)
  // And it wears what we wear. Our slot in the deal can MOVE when the roster
  // changes (assignPalette walks collisions forward through the sorted id set),
  // so this has to be a subscription: read once at mount and the glass would
  // keep showing the color the lobby had already reassigned.
  const paletteIndex = useSyncExternalStore(
    subscribeLocalPalette,
    localPaletteIndex,
    localPaletteIndex,
  )
  // The depot's yaw is fixed once the lot loads: the player's heading has to
  // come into this frame before it can be reflected in it.
  const yawOffset = useMemo(() => depotWorldYaw(world), [world])

  useArmoredColliders(world, shellRefs)

  useFrame((_, rawDt) => {
    const dummy = dummyRef.current
    if (!dummy) return
    const [lx, lz] = worldToDepotLocal(world, playerRig.position.x, playerRig.position.z)
    const engaged = mirrorEngaged(lx, lz)
    if (engaged !== shown.current) {
      shown.current = engaged
      dummy.visible = engaged
    }
    // Nobody near the glass: one hypot and out. An empty depot costs nothing.
    if (!engaged) return

    const dt = Math.min(rawDt, 1 / 30)
    const s = Math.min(1, playerRig.speed / MOVE.runSpeed)
    const staggered = useBoots.getState().staggered
    gaitPhase.current = advanceGait(gaitPhase.current, playerRig.grounded ? s : 0, dt)
    articulate(_artic, gaitPhase.current, s, playerRig.pitch, playerRig.grounded, staggered)

    const [dx, dz] = reflectStand(lx, lz)
    // The bob is in rig units; the dummy is scaled, so its stride is too.
    dummy.position.set(
      dx,
      MIRROR_PLINTH_TOP + MIRROR_FOOT_LIFT + _artic.bobY * MIRROR_DUMMY_SCALE,
      dz,
    )
    dummy.rotation.y = reflectYaw(playerRig.yaw - yawOffset)
    if (refs.legL.current) refs.legL.current.rotation.x = _artic.legSwing
    if (refs.legR.current) refs.legR.current.rotation.x = -_artic.legSwing
    if (refs.armL.current) refs.armL.current.rotation.x = _artic.armSwing
    if (refs.armR.current) refs.armR.current.rotation.x = _artic.armAim
    if (refs.torso.current) refs.torso.current.rotation.x = _artic.torsoPitch
    if (refs.head.current) refs.head.current.rotation.x = _artic.headPitch
  })

  const [paneW, paneH] = MIRROR_PANE_SIZE
  const paneCenterY = MIRROR_SILL_Y + paneH / 2
  const backZ = MIRROR_PANE_Z - MIRROR_DEPTH
  const midZ = (MIRROR_PANE_Z + backZ) / 2
  const halfW = paneW / 2
  const jamb = 0.06

  // ONE FRAME, THE DEPOT'S. This group is deliberately untranslated, so every
  // number below (and every constant above, and everything reflectStand
  // returns) is a depot-local coordinate. An earlier cut offset the group to
  // MIRROR_PANE_X and left the dummy's own x absolute, which put the reflection
  // 2.3 m sideways — through the far end wall (QA caught it as `lateral 2.32`).
  return (
    <group>
      {/* ── the cabinet shell: sealed except for the pane ──────────────── */}
      {/* side jambs */}
      {[-(halfW + jamb / 2), halfW + jamb / 2].map((dx, i) => (
        <mesh
          castShadow
          key={dx}
          position={[MIRROR_PANE_X + dx, paneCenterY, midZ]}
          ref={solid(i)}
        >
          <boxGeometry args={[jamb, paneH + jamb * 2, MIRROR_DEPTH]} />
          <meshStandardMaterial color={CABINET} metalness={0.3} roughness={0.65} />
        </mesh>
      ))}
      {/* head and sill */}
      <mesh
        castShadow
        position={[MIRROR_PANE_X, MIRROR_SILL_Y + paneH + jamb / 2, midZ]}
        ref={solid(2)}
      >
        <boxGeometry args={[paneW + jamb * 2, jamb, MIRROR_DEPTH]} />
        <meshStandardMaterial color={CABINET_DARK} metalness={0.3} roughness={0.65} />
      </mesh>
      <mesh
        castShadow
        position={[MIRROR_PANE_X, MIRROR_SILL_Y - jamb / 2, midZ]}
        ref={solid(3)}
      >
        <boxGeometry args={[paneW + jamb * 2, jamb, MIRROR_DEPTH]} />
        <meshStandardMaterial color={CABINET_DARK} metalness={0.3} roughness={0.65} />
      </mesh>
      {/* the plinth the dummy stands on (also the cabinet's inner floor) */}
      <mesh position={[MIRROR_PANE_X, (MIRROR_SILL_Y + MIRROR_PLINTH_TOP) / 2, midZ]}>
        <boxGeometry
          args={[paneW, MIRROR_PLINTH_TOP - MIRROR_SILL_Y, MIRROR_DEPTH - 0.02]}
        />
        <meshStandardMaterial color={CABINET_DARK} metalness={0.25} roughness={0.8} />
      </mesh>
      {/* back panel — a shade lighter than the shell so a dark vest still
          reads as a silhouette against it */}
      <mesh position={[MIRROR_PANE_X, paneCenterY, backZ + 0.015]}>
        <boxGeometry args={[paneW, paneH, 0.03]} />
        <meshStandardMaterial color="#5a656f" roughness={0.9} />
      </mesh>

      {/* ── the glazing ────────────────────────────────────────────────── */}
      {/* The pane is a COLLIDER (see useArmoredColliders): it seals the alcove,
          so the dummy can only ever be seen through the glass, from inside the
          container — never from behind, and never by walking into the box. */}
      {/* Named for QA: the harness finds the pane in world.colliders, reads its
          real transform, and stands the player in front of it — so the live
          check uses the SCENE's placement instead of re-deriving the depot's. */}
      <mesh
        name="boots-mirror-pane"
        position={[MIRROR_PANE_X, paneCenterY, MIRROR_PANE_Z]}
        ref={solid(4)}
      >
        <boxGeometry args={[paneW, paneH, 0.02]} />
        <meshStandardMaterial
          color="#cfe3ea"
          metalness={0.6}
          opacity={0.22}
          roughness={0.05}
          transparent
        />
      </mesh>
      {/* steel frame over the glass edges */}
      {[-(halfW - 0.02), halfW - 0.02].map((dx) => (
        <mesh key={dx} position={[MIRROR_PANE_X + dx, paneCenterY, MIRROR_PANE_Z + 0.015]}>
          <boxGeometry args={[0.04, paneH, 0.02]} />
          <meshStandardMaterial color={FRAME} metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {[MIRROR_SILL_Y + 0.02, MIRROR_SILL_Y + paneH - 0.02].map((y) => (
        <mesh key={y} position={[MIRROR_PANE_X, y, MIRROR_PANE_Z + 0.015]}>
          <boxGeometry args={[paneW, 0.04, 0.02]} />
          <meshStandardMaterial color={FRAME} metalness={0.6} roughness={0.4} />
        </mesh>
      ))}
      {/* Stencil on the WALL above the cabinet (not floating off its head). */}
      <MirrorPlaque position={[MIRROR_PANE_X, MIRROR_SILL_Y + paneH + 0.24, -1.13]} />

      {/* ── the reflection ─────────────────────────────────────────────── */}
      {/* Pure decoration: never a collider, never a target. Hidden until
          someone stands in front of the glass. */}
      <group
        name="boots-mirror-dummy"
        ref={dummyRef}
        scale={MIRROR_DUMMY_SCALE}
        userData={{ __boots: true }}
        visible={false}
      >
        <AvatarRig paletteIndex={paletteIndex} refs={refs} weapon={weapon} />
      </group>
      {/* Always mounted, CONSTANT intensity — the depot's WebGPU rule. Hung at
          the top front of the cabinet so it rakes DOWN the body like display
          lighting, and kept dim: the first cut sat it at chest height on 3.5 and
          QA's screenshot came back with a blown-out white Pascaline, which
          defeats the whole point of a mirror you check your own color in. */}
      <pointLight
        color="#ffe9c8"
        distance={2.2}
        intensity={1.1}
        position={[MIRROR_PANE_X, MIRROR_SILL_Y + paneH - 0.08, MIRROR_PANE_Z - 0.1]}
      />
    </group>
  )
}

/**
 * The cabinet's shell and glass, registered as the depot's own armored
 * colliders ('__boots-depot' / 'fixture' — the guntable contract: the RENDERED
 * meshes ARE the colliders, they block movement and bullets, they never
 * voxelize). The depot's own hook lives with the depot's meshes; this is the
 * same body over the mirror's refs, because the mirror is a child component and
 * cannot reach into the shell's ref array.
 */
function useArmoredColliders(world: GameWorld, refs: { current: (Mesh | null)[] }) {
  useEffect(() => {
    const entries: ColliderEntry[] = []
    for (const mesh of refs.current) {
      if (!mesh) continue
      mesh.updateWorldMatrix(true, false)
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox()
      const entry: ColliderEntry = {
        mesh,
        get bvh() {
          return bvhFor(this.mesh)
        },
        inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
        worldBox: mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld),
        root: mesh,
        nodeId: DEPOT_NODE_ID,
        nodeType: DEPOT_NODE_TYPE,
      }
      world.colliders.push(entry)
      entries.push(entry)
    }
    return () => {
      for (const entry of entries) entry.disabled = true
    }
  }, [world, refs])
}

/**
 * The little stencil over the glass. Its own tiny canvas rather than the
 * depot's StencilSign, because that one is a 768 px olive plate sized for
 * marquee text and this is a 9 cm strip.
 */
function MirrorPlaque({ position }: { position: [number, number, number] }) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const g = canvas.getContext('2d')
    if (!g) return null
    g.fillStyle = '#39413a'
    g.fillRect(0, 0, 256, 64)
    g.strokeStyle = '#242a24'
    g.lineWidth = 6
    g.strokeRect(4, 4, 248, 56)
    g.fillStyle = '#dfc95e'
    g.font = 'bold 34px "Courier New", monospace'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText('LOOK SHARP', 128, 34)
    return new CanvasTexture(canvas)
  }, [])
  // R3F disposes the JSX material, never an externally created texture.
  useEffect(() => () => texture?.dispose(), [texture])
  return (
    <mesh position={position}>
      <boxGeometry args={[0.6, 0.15, 0.02]} />
      {texture ? (
        <meshStandardMaterial map={texture} roughness={0.8} />
      ) : (
        <meshStandardMaterial color="#39413a" roughness={0.8} />
      )}
    </mesh>
  )
}
