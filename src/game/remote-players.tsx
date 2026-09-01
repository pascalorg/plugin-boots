'use client'

import { useFrame } from '@react-three/fiber'
import { type ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  type Group,
  type Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
} from 'three'
import { EYE_HEIGHT } from './collision'
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
 * maps the live remote registry (presence.ts) onto <RemoteAvatar> rigs:
 * ~10 primitives over 5 CACHED geometries, tinted per player from an
 * 8-color palette keyed by a userId hash, articulated purely from the
 * sampled wire pose (body yaw, head/weapon-arm pitch, gait-sine leg swing
 * driven by normalized speed, airborne tuck when !g, slump when st), the
 * held weapon silhouette reusing the viewmodel's weapon-models components
 * (swapped on `w`, change-gated), and a name-tag billboard CanvasTexture
 * (the guntable TableSign idiom — disposed on despawn, solid to 24 m then
 * faded out to nothing by 40 m). Avatars scale in over 200 ms on join.
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
const VISOR_GEO = new BoxGeometry(0.2, 0.07, 0.03)

const VISOR_MATERIAL = new MeshStandardMaterial({
  color: '#17191c',
  metalness: 0.4,
  roughness: 0.35,
})

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
const BOOT_MATERIAL = new MeshStandardMaterial({ color: '#332a22', roughness: 0.9 })

const _tint = new Color()
const tintedMaterials = new Map<number, { body: MeshStandardMaterial; trim: MeshStandardMaterial }>()

/** Per-palette-slot materials, created lazily and cached for the module's
 * life (8 slots × 2 = bounded; sharing across avatars keeps a crowd at a
 * handful of programs). */
export function materialsFor(paletteIndex: number): {
  body: MeshStandardMaterial
  trim: MeshStandardMaterial
} {
  let entry = tintedMaterials.get(paletteIndex)
  if (!entry) {
    const hex = AVATAR_PALETTE[paletteIndex % AVATAR_PALETTE.length]!
    _tint.set(hex)
    entry = {
      body: new MeshStandardMaterial({ color: hex, roughness: 0.75 }),
      trim: new MeshStandardMaterial({
        color: _tint.clone().multiplyScalar(0.55),
        roughness: 0.8,
      }),
    }
    tintedMaterials.set(paletteIndex, entry)
  }
  return entry
}

// ── Name-tag texture (TableSign idiom — external texture, disposed) ─────────

function makeNameTexture(name: string): CanvasTexture | null {
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

function RemoteAvatar({ remote }: { remote: RemotePlayer }) {
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
  const gaitPhase = useRef(0)
  const lastScale = useRef(-1)
  const frame = useRef(0)
  // Change-gated React state: weapon swaps and late-resolving names are
  // EVENTS (a handful per session), so a state write from useFrame is fine.
  const [weapon, setWeapon] = useState(remote.w)
  const [name, setName] = useState(() => participantName(remote.userId))

  const { body, trim } = materialsFor(paletteIndexFor(remote.userId))

  const tagTexture = useMemo(() => makeNameTexture(name), [name])
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

    // Name tag: distance fade + billboard (parent-compensated camera copy).
    const tag = tagRef.current
    if (tag) {
      const camera = rootState.camera
      const dx = camera.position.x - _pose.x
      const dy = camera.position.y - _pose.y
      const dz = camera.position.z - _pose.z
      const distSq = dx * dx + dy * dy + dz * dz
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
      {/* Legs: pivots at the hip so the gait swings them; boots ride along. */}
      <group ref={legLRef} position={[-0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={trim} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.83, -0.04]} />
      </group>
      <group ref={legRRef} position={[0.11, 0.85, 0]}>
        <mesh geometry={LIMB_GEO} material={trim} position={[0, -0.4, 0]} />
        <mesh geometry={FOOT_GEO} material={BOOT_MATERIAL} position={[0, -0.83, -0.04]} />
      </group>
      {/* Torso pivot at the hip — slumps forward while staggered. */}
      <group ref={torsoRef} position={[0, 0.85, 0]}>
        <mesh geometry={TORSO_GEO} material={body} position={[0, 0.3, 0]} />
        {/* Head pivot at the neck; visor marks the facing (-Z). */}
        <group ref={headRef} position={[0, 0.6, 0]}>
          <mesh geometry={HEAD_GEO} material={body} position={[0, 0.15, 0]} />
          <mesh geometry={VISOR_GEO} material={VISOR_MATERIAL} position={[0, 0.17, -0.14]} />
        </group>
        {/* Free (left) arm counter-swings the gait. */}
        <group ref={armLRef} position={[-0.28, 0.5, 0]}>
          <mesh
            geometry={LIMB_GEO}
            material={trim}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
        </group>
        {/* Weapon (right) arm aims with the remote pitch; the held model
            hangs off the hand, barrel aligned down the arm. */}
        <group ref={armRRef} position={[0.28, 0.5, 0]}>
          <mesh
            geometry={LIMB_GEO}
            material={trim}
            position={[0, -0.26, 0]}
            scale={[0.85, 0.7, 0.85]}
          />
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

  useFrame(() => {
    const version = getRosterVersion()
    if (version !== versionSeen.current) {
      versionSeen.current = version
      const list: RemotePlayer[] = []
      for (const remote of getRemotes().values()) {
        if (remote.ph === 'game') list.push(remote)
      }
      setRoster(list)
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
        <RemoteAvatar key={remote.sessionId} remote={remote} />
      ))}
    </>
  )
}
