'use client'

import { useFrame } from '@react-three/fiber'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
} from 'three'
import { EYE_HEIGHT } from './collision'
import { localUserId } from './net'
import { SprayerModel } from './paint'
import {
  createSampledPose,
  INTERP_DELAY_MS,
  sampleAt,
  type SampledPose,
} from './presence-interp'
import {
  getRemotes,
  getRosterVersion,
  participantName,
  type RemotePlayer,
} from './presence'
import { getSession } from './session'
import { isPeerTalking } from './voice'
import {
  HammerModel,
  KnifeModel,
  MinigunModel,
  PistolModel,
  RifleModel,
  WarhammerModel,
} from './weapon-models'

/**
 * Remote-player avatars — the render side of co-presence. <RemotePlayers/>
 * maps the live remote registry (presence.ts) onto <RemoteAvatar> rigs,
 * articulated purely from the sampled wire pose (body yaw, head/weapon-arm
 * pitch, gait-sine leg swing driven by normalized speed, airborne tuck when
 * !g, slump when st), the held weapon silhouette reusing the viewmodel's
 * weapon-models components (swapped on `w`, change-gated), and a name-tag
 * billboard CanvasTexture (the guntable TableSign idiom — disposed on
 * despawn, solid to 24 m then faded out to nothing by 40 m). Avatars scale
 * in over 200 ms on join.
 *
 * EVERY PEER IS PASCALINE (owner ask, 2026-09-01: "our avatars should look
 * like pascalines, only slightly customized"). The rig is the mascot as the
 * official render pack draws her — white hard hat with the Pascal logotype,
 * long dark hair to the shoulders, black jacket, charcoal cargo pants, the
 * leather tool belt with its pouch and yellow tape, tan work boots (the
 * reason this plugin's name fits) — built from cached primitives, not a
 * loaded mesh: an avatar has to cost nothing, and there are up to twelve.
 *
 * THE ONE THING THAT VARIES IS THE COLOR: a site vest over the jacket (front
 * and back, so it reads from any angle) plus the hard-hat band, in one of 8
 * tints. `assignPalette` hands out DISTINCT tints across the people actually
 * in the lot, local player included, so "I'm the blue one" is true rather
 * than probable. Everything else is on-model, identical for everyone.
 *
 * DETAIL FALLS AWAY WITH DISTANCE (detailVisible): past 14 m the pouch,
 * tape, logotype, eyes and side locks stop drawing, because at that range
 * silhouette and vest color are the whole message. Near, an avatar is ~26
 * primitives; far, ~14 — a full lobby stays a bounded draw cost.
 *
 * The roster this renders is HARD-CAPPED upstream at
 * presence.MAX_REMOTE_AVATARS, so the mounted rig count is bounded no matter
 * how busy the lobby gets.
 *
 * ANTI-GOAL (deliberate, do not "fix"): avatars NEVER join the world's
 * colliders and are NEVER shootable. They are pure visuals — never pushed
 * into world.colliders, never registered as a voxel/segment/bot target
 * (shooting.ts raycasts its own registries, not the scene graph), and the
 * root is tagged userData.__boots so identifyAim attributes them. Peers
 * cannot block doorways, eat bullets, or brace a collapsing build; each
 * client's game stays exactly as solo, plus ghosts.
 *
 * Zero per-frame allocations: one module-level SampledPose + quaternions
 * are reused across every avatar; geometries/materials are module caches.
 */

// ── Palette (pure, tested) ───────────────────────────────────────────────────

/** 8 avatar tints — assigned by userId hash, so a player keeps their color
 * across sessions and every client agrees on it without coordination. */
export const AVATAR_PALETTE = [
  '#d95d4e', // clay red
  '#4d8fd1', // work blue
  '#58b368', // site green
  '#d8a13a', // hi-vis amber
  '#9a6dd7', // violet
  '#45b8ac', // teal
  '#d16fa8', // pink
  '#8a9a5b', // moss
] as const

/** FNV-1a over the userId — stable, fast, good spread on short ids. */
export function hashUserId(userId: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function paletteIndexFor(userId: string): number {
  return hashUserId(userId) % AVATAR_PALETTE.length
}

/**
 * Hand out DISTINCT tints to the people in this lot.
 *
 * The hash alone is stable but not unique: with 8 slots, two of five players
 * share a color about half the time, and "the blue one" stops being a way to
 * name a teammate. So the hash becomes a PREFERENCE and collisions walk
 * forward to the first free slot.
 *
 * It has to agree on every screen without a single byte of coordination,
 * which is why it is a pure function of the SORTED id set: same roster in,
 * same assignment out, on every client. Past 8 players the palette is
 * genuinely exhausted and ids fall back to their preferred slot — a duplicate
 * beyond the eighth peer, not an error. Duplicate ids collapse (one person on
 * two devices is one color, in both windows).
 */
export function assignPalette(userIds: readonly string[]): Map<string, number> {
  const out = new Map<string, number>()
  const taken = new Set<number>()
  for (const userId of [...new Set(userIds)].sort()) {
    const preferred = paletteIndexFor(userId)
    let slot = preferred
    if (taken.size < AVATAR_PALETTE.length) {
      for (let step = 0; step < AVATAR_PALETTE.length; step++) {
        const candidate = (preferred + step) % AVATAR_PALETTE.length
        if (!taken.has(candidate)) {
          slot = candidate
          break
        }
      }
    }
    taken.add(slot)
    out.set(userId, slot)
  }
  return out
}

// ── Articulation (pure, tested) ──────────────────────────────────────────────

/** Gait phase advance per second at full speed (rad/s of the swing sine). */
export const GAIT_RATE = 7
/** Peak leg swing (rad) at full normalized speed. */
export const LEG_SWING_MAX = 0.55
/** Counter-swing of the free (left) arm, fraction of the leg swing. */
export const ARM_SWING_RATIO = 0.7
/** Fixed airborne pose: legs split, free arm thrown back. */
export const AIR_LEG_SPLIT = 0.45
export const AIR_ARM_SWING = -0.5
/** Slump lean while staggered (rad) + the hanging weapon arm. */
export const SLUMP_TORSO = 0.4
export const SLUMP_ARM_AIM = 0.35
/** Weapon arm at rest points forward (π/2 from hanging) and follows pitch. */
const ARM_AIM_BASE = Math.PI / 2
const HEAD_PITCH_MAX = 0.6

export type AvatarArticulation = {
  /** rotation.x of the LEFT leg pivot (right leg mirrors with -legSwing). */
  legSwing: number
  /** rotation.x of the LEFT (free) arm pivot — counter-swings the gait. */
  armSwing: number
  /** rotation.x of the RIGHT (weapon) arm pivot — π/2 = level aim. */
  armAim: number
  /** rotation.x of the torso pivot (slump lean). */
  torsoPitch: number
  /** rotation.x of the head pivot (tracks the remote view pitch). */
  headPitch: number
  /** Root bob (m) riding the stride. */
  bobY: number
}

export function createArticulation(): AvatarArticulation {
  return { legSwing: 0, armSwing: 0, armAim: ARM_AIM_BASE, torsoPitch: 0, headPitch: 0, bobY: 0 }
}

/** Advance the walk-cycle phase: stride cadence scales with normalized
 * speed (a stopped or airborne player's legs settle, never treadmill). */
export function advanceGait(phase: number, s: number, dt: number): number {
  return phase + dt * GAIT_RATE * (s < 0 ? 0 : s)
}

/**
 * Pose the rig from the sampled wire fields — the ONE articulation rule
 * set, pure so tests pin every stance:
 * - grounded gait: leg swing sine scaled by s, arm counter-swing, stride bob
 * - airborne (!g): fixed leg split + thrown-back arm, no bob
 * - staggered (st): torso slump, hung weapon arm, halved shuffle
 * - head and weapon arm track the remote pitch (clamped)
 */
export function articulate(
  out: AvatarArticulation,
  phase: number,
  s: number,
  pitch: number,
  grounded: boolean,
  staggered: boolean,
): AvatarArticulation {
  const clampedPitch = pitch < -1.2 ? -1.2 : pitch > 1.2 ? 1.2 : pitch
  if (grounded) {
    const swing = Math.sin(phase) * LEG_SWING_MAX * s
    out.legSwing = staggered ? swing * 0.5 : swing
    out.armSwing = -Math.sin(phase) * LEG_SWING_MAX * ARM_SWING_RATIO * s
    out.bobY = Math.abs(Math.cos(phase)) * 0.04 * s
  } else {
    out.legSwing = AIR_LEG_SPLIT
    out.armSwing = AIR_ARM_SWING
    out.bobY = 0
  }
  if (staggered) {
    out.torsoPitch = SLUMP_TORSO
    out.armAim = SLUMP_ARM_AIM
    out.headPitch = -0.35
  } else {
    out.torsoPitch = 0
    out.armAim = ARM_AIM_BASE + clampedPitch
    out.headPitch =
      clampedPitch < -HEAD_PITCH_MAX
        ? -HEAD_PITCH_MAX
        : clampedPitch > HEAD_PITCH_MAX
          ? HEAD_PITCH_MAX
          : clampedPitch
  }
  return out
}

// ── Join scale-in + name-tag gate (pure, tested) ─────────────────────────────

export const SPAWN_SCALE_MS = 200
/** Name tags hide past this distance (m). */
export const TAG_MAX_DIST = 40
/** Tags are fully solid within this distance (m), then ramp out to the cutoff. */
export const TAG_FADE_START = 24

/** 200 ms ease-out scale-in on join; floored so the matrix never hits 0. */
export function spawnScale(ageMs: number): number {
  const t = ageMs <= 0 ? 0 : ageMs >= SPAWN_SCALE_MS ? 1 : ageMs / SPAWN_SCALE_MS
  const eased = t * (2 - t)
  return eased < 0.001 ? 0.001 : eased
}

export function tagVisible(distSq: number): boolean {
  return distSq <= TAG_MAX_DIST * TAG_MAX_DIST
}

/** Past this distance (m) the fine Pascaline detail stops drawing. */
export const DETAIL_MAX_DIST = 14

/**
 * The LOD gate: is this avatar close enough for the small stuff (belt pouch,
 * tape measure, hat logotype, eyes, side locks)? Beyond 14 m those are
 * sub-pixel decoration, while the hat, hair mass, vest color and boots carry
 * the whole read. Toggling one group's `visible` costs a boolean and takes
 * ~12 primitives off each far avatar.
 */
export function detailVisible(distSq: number): boolean {
  return distSq <= DETAIL_MAX_DIST * DETAIL_MAX_DIST
}

/**
 * Name-tag opacity ramp: solid nearby, linear fade to nothing at
 * TAG_MAX_DIST. A lobby crowd stays readable at conversation range without
 * a picket fence of labels along the horizon (and the far ones stop
 * competing with the world for attention).
 */
export function tagOpacity(distSq: number): number {
  const near = TAG_FADE_START * TAG_FADE_START
  if (distSq <= near) return 1
  const far = TAG_MAX_DIST * TAG_MAX_DIST
  if (distSq >= far) return 0
  return (TAG_MAX_DIST - Math.sqrt(distSq)) / (TAG_MAX_DIST - TAG_FADE_START)
}

// ── Cached geometries + materials (module-lifetime, bounded) ─────────────────

const TORSO_GEO = new BoxGeometry(0.42, 0.55, 0.24)
const HEAD_GEO = new BoxGeometry(0.26, 0.26, 0.26)
const LIMB_GEO = new BoxGeometry(0.12, 0.8, 0.12) // legs; arms reuse it scaled
const FOOT_GEO = new BoxGeometry(0.14, 0.09, 0.24)

// ── Pascaline, in primitives ─────────────────────────────────────────────────
// Every measurement here is read off the official render pack (docs/brand):
// white hat with the logotype, hair to the shoulders, black jacket, charcoal
// cargo pants, leather belt with a pouch and the yellow tape, tan boots.

/** Hard hat: a half-sphere crown over a flat brim, plus the band that carries
 * the player's color. Low segment counts — this is a 26 cm prop. */
const HAT_CROWN_GEO = new SphereGeometry(0.155, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2)
const HAT_BRIM_GEO = new CylinderGeometry(0.205, 0.205, 0.022, 14)
const HAT_BAND_GEO = new CylinderGeometry(0.162, 0.162, 0.04, 14)
/** The logotype patch on the crown — a stripe at this size, which is exactly
 * what the wordmark reads as on a hard hat from two metres away. */
const HAT_MARK_GEO = new BoxGeometry(0.1, 0.028, 0.008)
/** Hair: one mass behind the head falling to the shoulders + two side locks. */
const HAIR_BACK_GEO = new BoxGeometry(0.28, 0.4, 0.15)
const HAIR_LOCK_GEO = new BoxGeometry(0.055, 0.3, 0.13)
/** Eyes — the facing cue that used to be a visor. */
const EYE_GEO = new BoxGeometry(0.035, 0.03, 0.01)
/** The site vest over the jacket: one plate on the chest, one on the back. */
const VEST_GEO = new BoxGeometry(0.3, 0.4, 0.02)
/** Tool belt, its pouch, and the tape measure clipped on the other hip. */
const BELT_GEO = new BoxGeometry(0.44, 0.075, 0.26)
const POUCH_GEO = new BoxGeometry(0.1, 0.13, 0.07)
const TAPE_GEO = new BoxGeometry(0.06, 0.07, 0.05)
/** Boots: a tan leather upper on a dark sole. */
const SOLE_GEO = new BoxGeometry(0.15, 0.035, 0.25)
/** Hands, so a sleeve does not end in nothing. */
const HAND_GEO = new BoxGeometry(0.09, 0.09, 0.09)

const HAT_MATERIAL = new MeshStandardMaterial({ color: '#f4f4f2', roughness: 0.45 })
const HAT_MARK_MATERIAL = new MeshStandardMaterial({ color: '#1a1a1c', roughness: 0.5 })
const JACKET_MATERIAL = new MeshStandardMaterial({ color: '#22242a', roughness: 0.7 })
const PANTS_MATERIAL = new MeshStandardMaterial({ color: '#2f3238', roughness: 0.85 })
const HAIR_MATERIAL = new MeshStandardMaterial({ color: '#3b2419', roughness: 0.8 })
const SKIN_MATERIAL = new MeshStandardMaterial({ color: '#e8b48f', roughness: 0.65 })
const EYE_MATERIAL = new MeshStandardMaterial({ color: '#241a14', roughness: 0.4 })
const LEATHER_MATERIAL = new MeshStandardMaterial({ color: '#8a5a33', roughness: 0.8 })
const TAPE_MATERIAL = new MeshStandardMaterial({ color: '#e8c229', roughness: 0.5 })

/**
 * The speaking dot — a small unlit disc over the name tag, shown while that peer
 * is transmitting (voice.ts's talk gate, carried on their own frames).
 *
 * Which mouth a voice belongs to is the one thing a call in a game needs and a
 * call on a phone does not: six people in one building, and without this the
 * answer to "who said that" is to ask. It rides INSIDE the tag group so it
 * billboards with the name and disappears at the same distance for free.
 *
 * Geometry AND material are shared across avatars, which is why the dot does not
 * fade with the tag the way the name does — a shared material has one opacity, so
 * fading it for the far avatar would fade it for the near one too. It blinks out
 * with the group at the tag cutoff instead, which is the honest version of the
 * same idea and costs one program for a whole lobby.
 */
const SPEAK_GEO = new CircleGeometry(0.045, 12)
const SPEAK_MATERIAL = new MeshBasicMaterial({
  color: '#7ee081',
  depthWrite: false,
  transparent: true,
})
/** Tan work boots, dark sole — the pack's are caramel leather, well worn. */
const BOOT_MATERIAL = new MeshStandardMaterial({ color: '#9c6b3f', roughness: 0.85 })
const SOLE_MATERIAL = new MeshStandardMaterial({ color: '#26221e', roughness: 0.95 })

const _tint = new Color()
const tintedMaterials = new Map<number, { vest: MeshStandardMaterial; band: MeshStandardMaterial }>()

/**
 * The two tinted materials — the ONLY per-player color on the rig: the vest
 * plates (full tint) and the hard-hat band (a darker cut of the same, so the
 * hat still reads as white with a colored band rather than as a colored hat).
 *
 * Created lazily and cached for the module's life (8 slots × 2 = bounded;
 * sharing across avatars keeps a crowd at a handful of programs).
 */
export function materialsFor(paletteIndex: number): {
  vest: MeshStandardMaterial
  band: MeshStandardMaterial
} {
  let entry = tintedMaterials.get(paletteIndex)
  if (!entry) {
    const hex = AVATAR_PALETTE[paletteIndex % AVATAR_PALETTE.length]!
    _tint.set(hex)
    entry = {
      vest: new MeshStandardMaterial({ color: hex, roughness: 0.75 }),
      band: new MeshStandardMaterial({
        color: _tint.clone().multiplyScalar(0.55),
        roughness: 0.8,
      }),
    }
    tintedMaterials.set(paletteIndex, entry)
  }
  return entry
}

// ── Name-tag texture (TableSign idiom — external texture, disposed) ─────────

function makeNameTexture(name: string, tint: string): CanvasTexture | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 64
  const g = canvas.getContext('2d')
  if (!g) return null
  g.fillStyle = 'rgba(12,14,16,0.72)'
  g.beginPath()
  g.roundRect(4, 8, 248, 48, 12)
  g.fill()
  // The vest color, again, around the name: the tag is where a player LEARNS
  // which color is which, so it has to carry both halves of the pairing.
  g.strokeStyle = tint
  g.lineWidth = 4
  g.stroke()
  g.fillStyle = 'rgba(255,255,255,0.92)'
  g.font = 'bold 28px system-ui, sans-serif'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(name.slice(0, 16), 128, 33)
  return new CanvasTexture(canvas)
}

// ── Held weapon silhouette ───────────────────────────────────────────────────

/** Weapon id → viewmodel component (weapon-models contract: grip at the
 * origin, barrel down -Z). Unknown ids from newer peers render bare hands. */
const WEAPON_COMPONENT: Record<string, () => ReactElement> = {
  knife: KnifeModel,
  pistol: PistolModel,
  rifle: RifleModel,
  minigun: MinigunModel,
  hammer: WarhammerModel,
  builder: HammerModel,
  paint: SprayerModel,
}

/** Feature-detected HUD surface (structural — same defensive idiom as the
 * pinned-typings casts elsewhere: an older Hud without the chip is a no-op). */
type PresenceHud = { presenceChip?: (count: number) => void }

function driveChip(count: number): void {
  const hud = getSession()?.hud as unknown as PresenceHud | undefined
  hud?.presenceChip?.(count)
}

// ── Reused frame temps (zero per-frame allocations) ──────────────────────────

const _pose: SampledPose = createSampledPose()
const _artic: AvatarArticulation = createArticulation()
const _worldQuat = new Quaternion()

function RemoteAvatar({ paletteIndex, remote }: { paletteIndex: number; remote: RemotePlayer }) {
  const rootRef = useRef<Group>(null)
  const torsoRef = useRef<Group>(null)
  const headRef = useRef<Group>(null)
  const armLRef = useRef<Group>(null)
  const armRRef = useRef<Group>(null)
  const legLRef = useRef<Group>(null)
  const legRRef = useRef<Group>(null)
  const tagRef = useRef<Group>(null)
  const tagMatRef = useRef<MeshBasicMaterial>(null)
  const speakRef = useRef<Mesh>(null)
  // The two LOD groups (head detail lives under the head pivot, body detail
  // under the torso pivot, so the gate needs a handle on each).
  const headDetailRef = useRef<Group>(null)
  const bodyDetailRef = useRef<Group>(null)
  const lastDetail = useRef(true)
  const gaitPhase = useRef(0)
  const lastScale = useRef(-1)
  const frame = useRef(0)
  // Change-gated React state: weapon swaps and late-resolving names are
  // EVENTS (a handful per session), so a state write from useFrame is fine.
  const [weapon, setWeapon] = useState(remote.w)
  const [name, setName] = useState(() => participantName(remote.userId))

  const { vest, band } = materialsFor(paletteIndex)
  const tint = AVATAR_PALETTE[paletteIndex % AVATAR_PALETTE.length]!

  const tagTexture = useMemo(() => makeNameTexture(name, tint), [name, tint])
  // R3F disposes JSX-owned materials, never this externally created texture —
  // release it on unmount and on every name flip (TableSign contract).
  useEffect(() => () => tagTexture?.dispose(), [tagTexture])

  useFrame((rootState, rawDt) => {
    const root = rootRef.current
    if (!root) return
    const now = Date.now()
    const offset = Number.isFinite(remote.clockOffset) ? remote.clockOffset : 0
    if (!sampleAt(remote.ring, now - offset - INTERP_DELAY_MS, _pose)) return

    // Capped dt like every game loop here (a hitch never teleports a limb).
    const dt = Math.min(rawDt, 1 / 30)
    gaitPhase.current = advanceGait(gaitPhase.current, _pose.g ? _pose.s : 0, dt)
    articulate(_artic, gaitPhase.current, _pose.s, _pose.pitch, _pose.g, _pose.st)

    // Wire positions are EYE positions — plant the feet.
    root.position.set(_pose.x, _pose.y - EYE_HEIGHT + _artic.bobY, _pose.z)
    root.rotation.y = _pose.yaw
    const scale = spawnScale(now - remote.joinedAt)
    if (scale !== lastScale.current) {
      lastScale.current = scale
      root.scale.setScalar(scale)
    }
    if (legLRef.current) legLRef.current.rotation.x = _artic.legSwing
    if (legRRef.current) legRRef.current.rotation.x = -_artic.legSwing
    if (armLRef.current) armLRef.current.rotation.x = _artic.armSwing
    if (armRRef.current) armRRef.current.rotation.x = _artic.armAim
    if (torsoRef.current) torsoRef.current.rotation.x = _artic.torsoPitch
    if (headRef.current) headRef.current.rotation.x = _artic.headPitch

    // Weapon swap — change-gated, so per-frame calls are free while held.
    if (_pose.w !== weapon) setWeapon(_pose.w)

    // ONE distance, spent twice: the tag fade and the detail LOD.
    const camera = rootState.camera
    const dx = camera.position.x - _pose.x
    const dy = camera.position.y - _pose.y
    const dz = camera.position.z - _pose.z
    const distSq = dx * dx + dy * dy + dz * dz

    // Pascaline's small parts, dropped past 14 m — change-gated, so this is a
    // comparison per frame and two boolean writes per crossing.
    const detail = detailVisible(distSq)
    if (detail !== lastDetail.current) {
      lastDetail.current = detail
      if (headDetailRef.current) headDetailRef.current.visible = detail
      if (bodyDetailRef.current) bodyDetailRef.current.visible = detail
    }

    // Name tag: distance fade + billboard (parent-compensated camera copy).
    const tag = tagRef.current
    if (tag) {
      const opacity = tagOpacity(distSq)
      const visible = opacity > 0
      if (tag.visible !== visible) tag.visible = visible
      if (visible) {
        // Change-gated (per-avatar JSX-owned material — never shared).
        const material = tagMatRef.current
        if (material && Math.abs(material.opacity - opacity) > 0.01) {
          material.opacity = opacity
        }
        root.getWorldQuaternion(_worldQuat).invert()
        tag.quaternion.copy(_worldQuat.multiply(camera.quaternion))
        // Speaking dot: one map lookup (isPeerTalking, not talkingPeers() —
        // that one allocates an array per call, and a dozen avatars asking it
        // every frame is hundreds of throwaway arrays a second for one boolean
        // each). `now` is passed explicitly so a peer whose last voice frame
        // stopped arriving goes quiet on WALL time; the voice module's own clock
        // only advances while its tick is running.
        const speak = speakRef.current
        if (speak) {
          const talking = isPeerTalking(remote.sessionId, now)
          if (speak.visible !== talking) speak.visible = talking
        }
      }
    }

    // Late-resolving roster names: re-check ~every 2 s until it lands.
    if (++frame.current % 120 === 0 && name === 'builder') {
      const fresh = participantName(remote.userId)
      if (fresh !== name) setName(fresh)
    }
  })

  const Weapon = WEAPON_COMPONENT[weapon]

  return (
    // Non-solid, non-shootable by construction (see the anti-goal above);
    // __boots tags every surface for identifyAim attribution.
    <group
      name={`boots-remote-${remote.sessionId}`}
      ref={rootRef}
      scale={0.001}
      userData={{ __boots: true, __bootsRemote: remote.sessionId }}
    >
      {/* Legs: pivots at the hip so the gait swings them. Charcoal cargo
          pants into tan boots on dark soles — the pack's exact stack. */}
      <group ref={legLRef} position={[-0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={PANTS_MATERIAL} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.81, -0.04]} />
        <mesh geometry={SOLE_GEO} material={SOLE_MATERIAL} position={[0, -0.867, -0.04]} />
      </group>
      <group ref={legRRef} position={[0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={PANTS_MATERIAL} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.81, -0.04]} />
        <mesh geometry={SOLE_GEO} material={SOLE_MATERIAL} position={[0, -0.867, -0.04]} />
      </group>
      {/* Torso pivot at the hip — slumps forward while staggered. */}
      <group ref={torsoRef} position={[0, 0.85, 0]}>
        {/* Black jacket, with the site vest over it: one plate front, one
            back, so a teammate's color reads whichever way they are facing. */}
        <mesh geometry={TORSO_GEO} material={JACKET_MATERIAL} position={[0, 0.3, 0]} />
        <mesh geometry={VEST_GEO} material={vest} position={[0, 0.3, -0.125]} />
        <mesh geometry={VEST_GEO} material={vest} position={[0, 0.3, 0.125]} />
        {/* Tool belt at the waist; pouch and tape are LOD detail. */}
        <mesh geometry={BELT_GEO} material={LEATHER_MATERIAL} position={[0, 0.07, 0]} />
        <group ref={bodyDetailRef}>
          <mesh geometry={POUCH_GEO} material={LEATHER_MATERIAL} position={[0.2, 0.0, 0.02]} />
          <mesh geometry={TAPE_GEO} material={TAPE_MATERIAL} position={[-0.21, 0.03, 0.04]} />
        </group>
        {/* Head pivot at the neck. Hair falls behind to the shoulders, the
            hard hat sits on top, the eyes mark the facing (-Z). */}
        <group ref={headRef} position={[0, 0.6, 0]}>
          <mesh geometry={HEAD_GEO} material={SKIN_MATERIAL} position={[0, 0.15, 0]} />
          <mesh geometry={HAIR_BACK_GEO} material={HAIR_MATERIAL} position={[0, 0.06, 0.075]} />
          {/* Hard hat: white crown, flat brim, colored band, logotype. */}
          <mesh geometry={HAT_CROWN_GEO} material={HAT_MATERIAL} position={[0, 0.27, 0]} />
          <mesh geometry={HAT_BRIM_GEO} material={HAT_MATERIAL} position={[0, 0.275, -0.01]} />
          <mesh geometry={HAT_BAND_GEO} material={band} position={[0, 0.295, 0]} />
          <group ref={headDetailRef}>
            <mesh geometry={HAT_MARK_GEO} material={HAT_MARK_MATERIAL} position={[0, 0.35, -0.12]} />
            <mesh geometry={HAIR_LOCK_GEO} material={HAIR_MATERIAL} position={[-0.145, 0.06, 0.02]} />
            <mesh geometry={HAIR_LOCK_GEO} material={HAIR_MATERIAL} position={[0.145, 0.06, 0.02]} />
            <mesh geometry={EYE_GEO} material={EYE_MATERIAL} position={[-0.06, 0.16, -0.132]} />
            <mesh geometry={EYE_GEO} material={EYE_MATERIAL} position={[0.06, 0.16, -0.132]} />
          </group>
        </group>
        {/* Free (left) arm counter-swings the gait — jacket sleeve, bare hand. */}
        <group ref={armLRef} position={[-0.28, 0.5, 0]}>
          <mesh
            geometry={LIMB_GEO}
            material={JACKET_MATERIAL}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
          <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} position={[0, -0.5, 0]} />
        </group>
        {/* Weapon (right) arm aims with the remote pitch; the held model
            hangs off the hand, barrel aligned down the arm. */}
        <group ref={armRRef} position={[0.28, 0.5, 0]}>
          <mesh
            geometry={LIMB_GEO}
            material={JACKET_MATERIAL}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
          <mesh geometry={HAND_GEO} material={SKIN_MATERIAL} position={[0, -0.5, 0]} />
          {Weapon ? (
            <group position={[0, -0.52, 0.02]} rotation={[-Math.PI / 2, 0, 0]}>
              <Weapon />
            </group>
          ) : null}
        </group>
      </group>
      {/* Name-tag billboard — hidden past 40 m, texture disposed on despawn. */}
      <group ref={tagRef} position={[0, 2.05, 0]}>
        {tagTexture ? (
          <mesh>
            <planeGeometry args={[0.72, 0.18]} />
            <meshBasicMaterial ref={tagMatRef} map={tagTexture} transparent depthWrite={false} />
          </mesh>
        ) : null}
        {/* Speaking dot — above the name, hidden until this peer transmits.
            Mounted always (not conditionally rendered) so turning it on is a
            boolean on an existing object rather than a mid-firefight remount. */}
        <mesh
          geometry={SPEAK_GEO}
          material={SPEAK_MATERIAL}
          position={[0, 0.16, 0]}
          ref={speakRef}
          visible={false}
        />
      </group>
    </group>
  )
}

/**
 * Mounts one <RemoteAvatar> per live in-game remote. Re-renders only when
 * the roster version bumps (join/leave); per-frame work is the version
 * poll + the change-gated HUD chip drive ("N builders here").
 */
export function RemotePlayers() {
  const versionSeen = useRef(-1)
  const chipCount = useRef(-1)
  const [roster, setRoster] = useState<RemotePlayer[]>([])
  const [colors, setColors] = useState<Map<string, number>>(() => new Map())

  useFrame(() => {
    const version = getRosterVersion()
    if (version !== versionSeen.current) {
      versionSeen.current = version
      const list: RemotePlayer[] = []
      for (const remote of getRemotes().values()) {
        if (remote.ph === 'game') list.push(remote)
      }
      setRoster(list)
      // Colors are re-dealt on the roster edge only. OUR OWN id goes into the
      // deal even though we never render ourselves: it reserves our tint, so
      // nobody else in the lot wears it and "I'm the amber one" holds.
      const ids = list.map((remote) => remote.userId)
      const mine = localUserId()
      if (mine) ids.push(mine)
      setColors(assignPalette(ids))
      // Chip rides the same edge (roster changes are the only count moves);
      // feature-detected like every cross-module hud call.
      if (list.length !== chipCount.current) {
        chipCount.current = list.length
        driveChip(list.length)
      }
    }
  })

  useEffect(
    () => () => {
      // Session over (or remount): blank the chip; a live session's next
      // roster poll re-drives it.
      driveChip(0)
    },
    [],
  )

  return (
    <>
      {roster.map((remote) => (
        <RemoteAvatar
          key={remote.sessionId}
          paletteIndex={colors.get(remote.userId) ?? paletteIndexFor(remote.userId)}
          remote={remote}
        />
      ))}
    </>
  )
}
