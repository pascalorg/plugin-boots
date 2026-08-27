'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { Group, Mesh, Object3D } from 'three'
import type { WeaponId } from '../store'
import { useBoots } from '../store'
import { sfx } from './audio'
import { builderDebug } from './builder'
import { throwGrenade } from './grenade'
import { MOVE } from './movement'
import { cyclePaintColor, SprayerModel } from './paint'
import { playerRig } from './player'
import { getSession } from './session'
import { fire } from './shooting'
import {
  HammerModel,
  KnifeModel,
  MinigunModel,
  MUZZLE_OFFSETS,
  PistolModel,
  RifleModel,
  WarhammerModel,
} from './weapon-models'
import { WEAPONS } from './weapons'
import type { GameWorld } from './world'

/**
 * First-person viewmodel: weapon meshes parented to a group that copies the
 * camera every frame (the host camera isn't guaranteed to be in the scene
 * graph, so children can't ride it directly). Also owns the trigger loop —
 * rate gating, semi vs auto, recoil, muzzle flash — plus the procedural
 * animation stack: draw-in, breathing, look-lag, run bob, landing dip.
 */

/** Everything the hand can hold: the arsenal plus the two tools. 'paint'
 * joins store.ts's WeaponId with the manager's one-liner — until then the
 * union lives here and one cast at the setWeapon boundary bridges it (the
 * fleet feature-detect idiom; the cast is a no-op after the one-liner). */
type ToolId = WeaponId | 'paint'

/**
 * Classic FPS anchor: low-right of screen, barrel converging on the crosshair.
 * Tuned to the weapon-models extents at the game FOV (90-ish vertical): the
 * pistol/knife sit closer so the small models read; the rifle stays at arm's
 * length so its muzzle (model z ~ -0.6) lands right of the crosshair, with the
 * stock running off the bottom-right corner. Every part stays > 0.11 in front
 * of the camera through recoil (+0.07 z) and draw-in, clear of the near plane.
 */
const POSES: Record<
  ToolId,
  { pos: [number, number, number]; rot: [number, number, number] }
> = {
  knife: { pos: [0.3, -0.3, -0.42], rot: [0.05, -0.24, 0.12] },
  pistol: { pos: [0.3, -0.28, -0.45], rot: [0, -0.07, 0.03] },
  rifle: { pos: [0.33, -0.3, -0.5], rot: [0.01, -0.09, 0.04] },
  // The big one rides lower and closer to center — it's huge, most of the
  // drum should sit at the bottom-right edge with the barrels crossing in.
  minigun: { pos: [0.22, -0.36, -0.56], rot: [0.01, -0.05, 0.02] },
  // Warhammer at carry: grip low-right, the model's +Y haft pitched hard
  // forward (rot.x ≈ -1.25) so the huge head rides ahead at chest height
  // like a lance — the swing offsets below rotate the whole pose group.
  hammer: { pos: [0.3, -0.42, -0.42], rot: [-1.25, -0.16, 0.1] },
  builder: { pos: [0.32, -0.33, -0.46], rot: [0.07, -0.28, 0.14] },
  // Sprayer at carry: the little can rides close and slightly rolled in,
  // nozzle converging on the crosshair like the guns.
  paint: { pos: [0.28, -0.3, -0.4], rot: [0.12, -0.3, 0.1] },
}

/**
 * ADS (right-mouse aim) poses: pistol/rifle only. Centered x=0 so the
 * sights converge on the crosshair, raised just under the eye line, level
 * rotation. viewmodel blends POSES→ADS_POSES with playerRig.ads (0..1,
 * written here at ±12/s); player-feel consumes the same scalar for the
 * FOV 92→60 interp and the look-sensitivity scale, and shooting-side
 * spread scaling hangs off it too (grenade agent's routing edit).
 */
const ADS_POSES: Partial<
  Record<ToolId, { pos: [number, number, number]; rot: [number, number, number] }>
> = {
  pistol: { pos: [0, -0.21, -0.38], rot: [0, 0, 0] },
  rifle: { pos: [0, -0.235, -0.44], rot: [0, 0, 0] },
}
/** playerRig.ads ramp speed (1/s) — full transition in ~0.08s each way. */
const ADS_RATE = 12
/** How much of the bob/breath/look-lag survives at full ADS. */
const ADS_STEADY = 0.25

/** playerRig gains ads + shake(power) this round (player-feel agent) —
 * typed as optional so writes/calls stay green before AND after. */
type RigFeel = typeof playerRig & { ads?: number; shake?: (power: number) => void }
const rigFeel = playerRig as RigFeel

const DRAW_TIME = 0.14
const DIP_TIME = 0.3
/** Barrel cluster speed at full spin (rad/s) and spin-down time (s). */
const BARREL_SPIN_RATE = 28
const SPIN_DOWN_TIME = 0.9
/** Spin drag: hauling live barrels slows you — playerRig.speedScale lerps
 * 1 → (1 - SPIN_DRAG) with spin level, recovering over the spin-down. */
const SPIN_DRAG = 0.45
const TWO_PI = Math.PI * 2

/**
 * Warhammer swing — a two-phase strike, NOT the knife's instant poke:
 * click starts a 0.25s wind-up (head raises over the shoulder), then a
 * 0.12s accelerating slam drives it down-and-forward; the hit resolves at
 * the END of the slam — the moment the head lands — never on click. A
 * 0.28s recover eases back to carry. Switching weapons or getting
 * staggered mid-swing cancels the hit.
 */
const HAMMER_WINDUP = 0.25
const HAMMER_SLAM = 0.12
const HAMMER_RECOVER = 0.28
/** Pose offsets at wind-up peak / slam impact (pitch rad, y, z). */
const HAMMER_RAISE = { pitch: 0.9, y: 0.06, z: 0.05 }
const HAMMER_STRIKE = { pitch: -0.65, y: -0.2, z: -0.12 }

type HammerPhase = 'idle' | 'windup' | 'slam' | 'recover'

/** audio.ts gains sfx.hammerSmash() this round (feedback agent) — guarded. */
function playHammerSmash(): void {
  ;(sfx as unknown as { hammerSmash?: () => void }).hammerSmash?.()
}

/** audio.ts gains sfx.minigun() this round (audio agent) — feature-detect so
 * the trigger works either way; shots fall back to rifle cracks until then. */
type MinigunSfxHandle = { setSpin: (v: number) => void; shot: () => void; stop: () => void }
function makeMinigunSfx(): MinigunSfxHandle | null {
  const factory = (sfx as unknown as { minigun?: () => MinigunSfxHandle | null }).minigun
  return factory ? factory.call(sfx) : null
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

export function Viewmodel({ world }: { world: GameWorld }) {
  const camera = useThree((s) => s.camera)
  const rigRef = useRef<Group>(null!)
  const poseRef = useRef<Group>(null!)
  const flashRef = useRef<Mesh>(null!)
  const cooldown = useRef(0)
  const grenadeAnimT = useRef<number | null>(null)
  const grenadeThrown = useRef(false)
  const grenadeHandRef = useRef<Group>(null)
  const prevFiring = useRef(false)
  const swingT = useRef(1)
  const recoilT = useRef(1)
  const flashT = useRef(0)

  const weapon = useBoots((s) => s.weapon) as ToolId

  // Animation state.
  const prevWeapon = useRef(weapon)
  const drawT = useRef(0)
  const breathT = useRef(0)
  const bobPhase = useRef(0)
  const bobAmp = useRef(0)
  const lagYaw = useRef(0)
  const lagPitch = useRef(0)
  const prevGrounded = useRef(true)
  const prevCamY = useRef(0)
  const fallVel = useRef(0)
  const dipT = useRef(1)
  const dipDepth = useRef(0)
  /** 0→1 while staggered: weapon droops (down + muzzle-down), firing blocked. */
  const droop = useRef(0)
  const prevStaggered = useRef(false)

  // Rotary spin state (minigun): 0..1 spin level, accumulated barrel angle,
  // the tagged barrel-cluster node, and the live whine handle.
  const spinT = useRef(0)
  const spinAngle = useRef(0)
  const barrelsRef = useRef<Object3D | null>(null)
  const spinSfx = useRef<MinigunSfxHandle | null>(null)
  /** True while WE own playerRig.speedScale (spin drag active) — lets the
   * restore-to-1 write happen exactly once when the barrels rest. */
  const spinDragging = useRef(false)

  // Warhammer two-phase swing state (constants above own the timings).
  const hammerPhase = useRef<HammerPhase>('idle')
  const hammerT = useRef(0)

  // Kill the whine if the session unmounts mid-spin, and hand the player
  // their legs back (speedScale contract: writers restore exactly 1).
  useEffect(
    () => () => {
      spinSfx.current?.stop()
      spinSfx.current = null
      if (spinDragging.current) {
        playerRig.speedScale = 1
        spinDragging.current = false
      }
    },
    [],
  )

  useFrame((_, rawDt) => {
    const session = getSession()
    const rig = rigRef.current
    if (!session || !rig) return
    const dt = Math.min(rawDt, 1 / 30)

    rig.position.copy(camera.position)
    rig.quaternion.copy(camera.quaternion)

    // Discrete actions: weapon slots, wheel cycling, build controls.
    const state = useBoots.getState()
    for (const action of session.input.consumeActions()) {
      if (action === 'Digit1') switchWeapon('knife')
      else if (action === 'Digit2') switchWeapon('pistol')
      else if (action === 'Digit3') switchWeapon('rifle')
      else if (action === 'Digit4' || action === 'KeyB') switchWeapon('builder')
      else if (action === 'Digit5') switchWeapon('minigun')
      else if (action === 'Digit6') switchWeapon('hammer')
      else if (action === 'Digit7') switchWeapon('paint')
      else if (action === 'KeyR' && (state.weapon as ToolId) === 'paint') {
        // R is the builder's ROTATE (held state) everywhere else — with the
        // sprayer up the tap cycles the palette instead; PaintTool's
        // change-gated HUD line picks the new color up next frame.
        cyclePaintColor()
      } else if (action === 'KeyG') {
        // G is the grenade EVERYWHERE (group contract). The throw itself
        // fires at the RELEASE keyframe of the wind-up below — the stick
        // grenade rises in the hand, whips forward, and lets go.
        if (grenadeAnimT.current === null) grenadeAnimT.current = 0
      } else if (action === 'WheelUp' || action === 'WheelDown') {
        const list: ToolId[] = [...state.owned, 'builder', 'paint']
        const at = list.indexOf(state.weapon)
        const next = list[(at + (action === 'WheelDown' ? 1 : list.length - 1)) % list.length]!
        switchWeapon(next)
      } else if (action === 'KeyQ' && state.weapon === 'builder') {
        // 3x3 edit mode owns Q while editing a placed wall (pocket cycling) —
        // feature-detected so this compiles before builder's edit mode lands.
        // Supports isEditing as a getter fn or plain flag; absent = never editing.
        const editFlag = (builderDebug as { isEditing?: boolean | (() => boolean) }).isEditing
        const editing = typeof editFlag === 'function' ? editFlag() : editFlag === true
        if (!editing) {
          const order = ['wall', 'floor', 'roof'] as const
          state.setBuildPiece(order[(order.indexOf(state.buildPiece) + 1) % order.length]!)
        }
      }
    }

    cooldown.current -= dt

    // Stick-grenade wind-up: raise (0→0.12s), whip + RELEASE at 0.16s,
    // follow-through to 0.3s. The hand model only shows during the arc.
    if (grenadeAnimT.current !== null) {
      const t = (grenadeAnimT.current += dt)
      if (!grenadeThrown.current && t >= 0.16) {
        grenadeThrown.current = true
        throwGrenade(world)
      }
      if (t >= 0.3) {
        grenadeAnimT.current = null
        grenadeThrown.current = false
      }
    }
    const hand = grenadeHandRef.current
    if (hand) {
      const t = grenadeAnimT.current
      if (t === null) {
        hand.visible = false
      } else {
        hand.visible = true
        // Two-keyframe arc: low-right pocket → raised behind the shoulder →
        // whipped forward past the camera edge.
        const raise = Math.min(1, t / 0.12)
        const whip = Math.max(0, Math.min(1, (t - 0.12) / 0.1))
        hand.position.set(
          0.34 - whip * 0.1,
          -0.4 + raise * 0.42 - whip * 0.28,
          -0.35 - whip * 0.3,
        )
        hand.rotation.set(-raise * 1.2 + whip * 2.1, -0.25, 0.2 - whip * 0.3)
      }
    }
    swingT.current = Math.min(1, swingT.current + dt * 5.2)
    recoilT.current = Math.min(1, recoilT.current + dt * 9)
    flashT.current -= dt
    if (flashRef.current) flashRef.current.visible = flashT.current > 0

    const firing = session.input.state.firing
    const current = useBoots.getState().weapon as ToolId
    const staggered = useBoots.getState().staggered
    // Weapon droop while staggered — slow lerp both ways so the arm sags
    // and recovers smoothly instead of snapping.
    droop.current += ((staggered ? 1 : 0) - droop.current) * Math.min(1, dt * 6)
    // Get-up re-ready: when the stagger ends, re-raise the weapon from below
    // (negative drawT = a short fully-lowered hold before the 0.14s rise, so
    // the re-grip lands inside the camera's get-up beat).
    if (prevStaggered.current && !staggered) drawT.current = -0.4
    prevStaggered.current = staggered

    // --- ADS (right-mouse aim), pistol/rifle only ---------------------------
    // playerRig.ads is the shared 0..1 aim scalar (we own the writes):
    // player-feel interps FOV 92→60 and scales look sensitivity off it,
    // shooting-side spread scaling reads it too; the pose blend below
    // consumes it locally. Linear ramp ±12/s ≈ 80 ms each way. No ADS for
    // knife/minigun/hammer/builder.
    const adsTarget =
      (current === 'pistol' || current === 'rifle') && session.input.state.altFiring && !staggered
        ? 1
        : 0
    const adsPrev = rigFeel.ads ?? 0
    const ads = adsPrev + clamp(adsTarget - adsPrev, -ADS_RATE * dt, ADS_RATE * dt)
    rigFeel.ads = ads
    // HUD crosshair morph (ticks fade out, center dot fades in) — the HUD
    // change-gates the write, so the per-frame call is free once settled.
    session.hud.setAds?.(ads)

    // Any switch (slots, wheel, gear-table pickup) restarts the draw-in.
    if (current !== prevWeapon.current) {
      prevWeapon.current = current
      drawT.current = 0
    }
    drawT.current = Math.min(1, drawT.current + dt / DRAW_TIME)

    // --- Rotary spin-up ----------------------------------------------------
    // Holding fire on a spinUp weapon first accelerates the barrels (no
    // shots); at full spin the trigger block below runs the 24/s stream.
    // Release (or switch/stagger) winds it back down — the whine follows.
    const heldDef = current !== 'builder' && current !== 'paint' ? WEAPONS[current] : undefined
    const wantsSpin = heldDef?.spinUp !== undefined && firing && !staggered
    spinT.current = wantsSpin
      ? Math.min(1, spinT.current + dt / (heldDef?.spinUp ?? 1))
      : Math.max(0, spinT.current - dt / SPIN_DOWN_TIME)
    spinAngle.current = (spinAngle.current + spinT.current * BARREL_SPIN_RATE * dt) % TWO_PI
    if (barrelsRef.current) barrelsRef.current.rotation.z = spinAngle.current
    if (spinT.current > 0) {
      if (!spinSfx.current) spinSfx.current = makeMinigunSfx()
      spinSfx.current?.setSpin(spinT.current)
    } else if (spinSfx.current) {
      spinSfx.current.stop()
      spinSfx.current = null
    }
    // Spin drag on the legs: written every frame while spin > 0 (release or
    // weapon switch just lets spinT decay, so speed recovers with the whine),
    // then restored to exactly 1 once — never fighting other writers at rest.
    if (spinT.current > 0) {
      playerRig.speedScale = 1 - SPIN_DRAG * spinT.current
      spinDragging.current = true
    } else if (spinDragging.current) {
      playerRig.speedScale = 1
      spinDragging.current = false
    }

    // The sprayer's trigger loop lives in PaintTool (paint.tsx) — it reads
    // the non-consuming `firing` state, so the input queue stays ours alone.
    if (current !== 'builder' && current !== 'paint' && !staggered) {
      const def = WEAPONS[current]
      if (def.id === 'hammer') {
        // Two-phase strike: the click only STARTS the wind-up — the hit
        // resolves when the slam lands (swing machine below). Cooldown is
        // paid up front so rate 0.9 gates swing STARTS.
        const wantsSwing = def.auto ? firing : firing && !prevFiring.current
        if (wantsSwing && cooldown.current <= 0 && hammerPhase.current === 'idle') {
          cooldown.current = Math.max(cooldown.current, -1 / def.rate) + 1 / def.rate
          hammerPhase.current = 'windup'
          hammerT.current = 0
        }
      } else {
        const spunUp = def.spinUp === undefined || spinT.current >= 1
        // Aiming turns the rifle into a precision semi-auto: shot per click
        // (owner call 2026-08-25) — the ADS spread cut in shooting.ts does
        // the accuracy half.
        const semiForced = def.id === 'rifle' && (rigFeel.ads ?? 0) > 0.5
        const wantsShot =
          (def.auto && !semiForced ? firing : firing && !prevFiring.current) && spunUp
        if (wantsShot && cooldown.current <= 0) {
          // Carry the frame-grid remainder (capped at one interval) so fast
          // rates average true — at 60fps a plain reset turns 24/s into 20/s.
          cooldown.current = Math.max(cooldown.current, -1 / def.rate) + 1 / def.rate
          if (def.melee) {
            swingT.current = 0
            sfx.knifeSwing()
          } else {
            recoilT.current = 0
            flashT.current = def.id === 'minigun' ? 0.03 : 0.045
            playerRig.recoil += def.kick
            const muzzle = def.id === 'knife' ? MUZZLE_OFFSETS.rifle : MUZZLE_OFFSETS[def.id]
            const flash = flashRef.current
            if (flash) {
              flash.position.set(muzzle[0], muzzle[1], muzzle[2])
              if (def.id === 'minigun') {
                // Rapid flicker: random roll + size per shot so the near-
                // continuous stream shimmers instead of freezing into a card.
                flash.rotation.z = Math.random() * TWO_PI
                const fs = 1.4 + Math.random()
                flash.scale.set(fs, fs, 1)
              } else {
                flash.rotation.z = 0
                flash.scale.set(1, 1, 1)
              }
            }
            if (def.id === 'pistol') sfx.pistolShot()
            else if (def.id === 'minigun') {
              if (spinSfx.current) spinSfx.current.shot()
              else sfx.rifleShot() // fallback until audio.ts ships sfx.minigun()
            } else sfx.rifleShot()
          }
          const outcome = fire(world, def)
          if (outcome === 'bot') {
            session.hud.hitmarker()
            sfx.hitmarker()
          }
        }
      }
    }
    prevFiring.current = firing

    // --- Warhammer swing machine -------------------------------------------
    // Runs outside the trigger block so an in-flight swing keeps animating,
    // but switching away or getting staggered mid-swing CANCELS the hit.
    if (hammerPhase.current !== 'idle') {
      if (current !== 'hammer' || staggered) {
        hammerPhase.current = 'idle'
      } else {
        hammerT.current += dt
        if (hammerPhase.current === 'windup' && hammerT.current >= HAMMER_WINDUP) {
          hammerPhase.current = 'slam'
          hammerT.current = 0
          sfx.knifeSwing() // the down-arc whoosh; the smash voices at impact
        } else if (hammerPhase.current === 'slam' && hammerT.current >= HAMMER_SLAM) {
          hammerPhase.current = 'recover'
          hammerT.current = 0
          // IMPACT — the moment the head lands. Route through the shared
          // smash path: fire() with the hammer def (smashRadius mirrored
          // into hole/tear radii until shooting routes it explicitly).
          const outcome = fire(world, WEAPONS.hammer)
          rigFeel.shake?.(1.0)
          playHammerSmash()
          if (outcome === 'bot') {
            session.hud.hitmarker()
            sfx.hitmarker()
          }
        } else if (hammerPhase.current === 'recover' && hammerT.current >= HAMMER_RECOVER) {
          hammerPhase.current = 'idle'
        }
      }
    }

    // --- Procedural weapon pose ------------------------------------------
    const pose = POSES[current]
    const invDt = dt > 1e-5 ? 1 / dt : 0

    // Draw-in: rise from below with a muzzle-down tilt, ease-out cubic.
    // (clamp keeps the cubic sane for the get-up hold's negative drawT)
    const drawEase = 1 - (1 - clamp(drawT.current, 0, 1)) ** 3
    const draw = 1 - drawEase

    // Idle breathing: slow sine, tiny.
    breathT.current += dt
    const breatheY = Math.sin(breathT.current * 1.6) * 0.0028
    const breatheX = Math.sin(breathT.current * 0.9) * 0.0014

    // Run cadence bob: accumulated phase driven by actual travel speed.
    const speedN = clamp(playerRig.speed / MOVE.runSpeed, 0, 1)
    const bobTarget = playerRig.grounded && playerRig.speed > 0.5 ? speedN : 0
    if (bobTarget > 0) bobPhase.current += playerRig.speed * dt * 1.9
    bobAmp.current += (bobTarget - bobAmp.current) * Math.min(1, dt * 8)
    const bobY = -Math.abs(Math.sin(bobPhase.current)) * 0.016 * bobAmp.current
    const bobX = Math.sin(bobPhase.current) * 0.012 * bobAmp.current
    const bobRoll = Math.sin(bobPhase.current) * 0.01 * bobAmp.current

    // Look-lag: the weapon trails mouse motion through a spring. Reads the
    // rig's look velocities (rad/s, mouse-driven so teleports don't spike,
    // pre-smoothed ~10 Hz in player.tsx) — gain and spring rate are hotter
    // than the old raw-delta tune to offset that upstream smoothing.
    const lagK = Math.min(1, dt * 18)
    lagYaw.current +=
      (clamp(-playerRig.yawVelocity * 0.018, -0.055, 0.055) - lagYaw.current) * lagK
    lagPitch.current +=
      (clamp(-playerRig.pitchVelocity * 0.018, -0.055, 0.055) - lagPitch.current) * lagK

    // Landing dip: track fall speed from camera height, dip on touchdown.
    const velY = (camera.position.y - prevCamY.current) * invDt
    prevCamY.current = camera.position.y
    if (!playerRig.grounded) fallVel.current = Math.min(fallVel.current, velY)
    if (playerRig.grounded && !prevGrounded.current) {
      if (fallVel.current < -3) {
        dipT.current = 0
        dipDepth.current = clamp(-fallVel.current * 0.008, 0.02, 0.06)
      }
      fallVel.current = 0
    }
    prevGrounded.current = playerRig.grounded
    dipT.current = Math.min(1, dipT.current + dt / DIP_TIME)
    const dip = Math.sin(Math.PI * dipT.current) * dipDepth.current

    // Swing / recoil springs.
    const swing = 1 - swingT.current
    const recoil = 1 - recoilT.current

    // Rotary rumble: tiny high-frequency shake scaling with barrel spin,
    // hotter while the trigger is held. Exactly zero when the barrels rest.
    const rumble = spinT.current * (firing ? 1 : 0.35)
    const rumX = rumble > 0 ? Math.sin(breathT.current * 71) * 0.0035 * rumble : 0
    const rumY = rumble > 0 ? Math.sin(breathT.current * 57 + 1.3) * 0.003 * rumble : 0

    // ADS pose blend: lerp the carry pose toward the centered aim pose and
    // steady the procedural motion (bob/breath/look-lag) toward ADS_STEADY
    // at full aim — planted sights, not a bouncing scope.
    const adsPose = ADS_POSES[current]
    const aim = adsPose ? ads : 0
    const steady = 1 - (1 - ADS_STEADY) * aim
    const baseX = adsPose ? pose.pos[0] + (adsPose.pos[0] - pose.pos[0]) * aim : pose.pos[0]
    const baseY = adsPose ? pose.pos[1] + (adsPose.pos[1] - pose.pos[1]) * aim : pose.pos[1]
    const baseZ = adsPose ? pose.pos[2] + (adsPose.pos[2] - pose.pos[2]) * aim : pose.pos[2]
    const baseRX = adsPose ? pose.rot[0] + (adsPose.rot[0] - pose.rot[0]) * aim : pose.rot[0]
    const baseRY = adsPose ? pose.rot[1] + (adsPose.rot[1] - pose.rot[1]) * aim : pose.rot[1]
    const baseRZ = adsPose ? pose.rot[2] + (adsPose.rot[2] - pose.rot[2]) * aim : pose.rot[2]

    // Warhammer swing offsets — zero for every other weapon and at rest.
    // Wind-up eases OUT (heave the mass up), the slam eases IN (t² — gravity
    // takes it), recover releases through a smoothstep back to carry.
    let hamPitch = 0
    let hamY = 0
    let hamZ = 0
    if (current === 'hammer' && hammerPhase.current !== 'idle') {
      if (hammerPhase.current === 'windup') {
        const k = 1 - (1 - Math.min(1, hammerT.current / HAMMER_WINDUP)) ** 2
        hamPitch = HAMMER_RAISE.pitch * k
        hamY = HAMMER_RAISE.y * k
        hamZ = HAMMER_RAISE.z * k
      } else if (hammerPhase.current === 'slam') {
        const a = Math.min(1, hammerT.current / HAMMER_SLAM)
        const k = a * a
        hamPitch = HAMMER_RAISE.pitch + (HAMMER_STRIKE.pitch - HAMMER_RAISE.pitch) * k
        hamY = HAMMER_RAISE.y + (HAMMER_STRIKE.y - HAMMER_RAISE.y) * k
        hamZ = HAMMER_RAISE.z + (HAMMER_STRIKE.z - HAMMER_RAISE.z) * k
      } else {
        const r = Math.min(1, hammerT.current / HAMMER_RECOVER)
        const k = 1 - r * r * (3 - 2 * r)
        hamPitch = HAMMER_STRIKE.pitch * k
        hamY = HAMMER_STRIKE.y * k
        hamZ = HAMMER_STRIKE.z * k
      }
    }

    const p = poseRef.current
    if (p) {
      const sag = droop.current
      p.position.set(
        baseX + (bobX + breatheX + lagYaw.current * 0.35) * steady + rumX,
        baseY + (bobY + breatheY + lagPitch.current * 0.3) * steady - dip - draw * 0.24 - swing * 0.1 - sag * 0.06 + rumY + hamY,
        baseZ + recoil * 0.07 + hamZ,
      )
      p.rotation.set(
        baseRX + hamPitch - draw * 0.55 - dip * 1.4 - swing * 1.7 + recoil * 0.14 + lagPitch.current * steady - sag * 0.12,
        baseRY + lagYaw.current * steady + swing * 0.5,
        baseRZ + bobRoll * steady + swing * 0.3 + sag * 0.07,
      )
    }
  })

  const showKnife = weapon === 'knife'
  const showPistol = weapon === 'pistol'
  const showRifle = weapon === 'rifle'
  const showMinigun = weapon === 'minigun'
  const showHammer = weapon === 'hammer'
  const showBuilder = weapon === 'builder'
  const showPaint = weapon === 'paint'

  return (
    <group ref={rigRef} userData={{ __boots: true }}>
      {/* Initial position matches the knife pose (spawn weapon); the frame loop owns it after. */}
      <group ref={poseRef} position={[0.3, -0.3, -0.42]}>
        <group visible={showKnife}>
          <KnifeModel />
        </group>
        <group visible={showPistol}>
          <PistolModel />
        </group>
        <group visible={showRifle}>
          <RifleModel />
        </group>
        <group
          visible={showMinigun}
          ref={(g: Group | null) => {
            // Find the tagged barrel cluster once on mount; the frame loop
            // spins it (idle 0 → ~28 rad/s at full spin).
            if (!g) {
              barrelsRef.current = null
              return
            }
            g.traverse((o) => {
              if (o.userData.role === 'barrels') barrelsRef.current = o
            })
          }}
        >
          <MinigunModel />
        </group>
        <group visible={showHammer}>
          <WarhammerModel />
        </group>
        {/* Builder tool keeps the small claw hammer — the warhammer above is
            the slot-6 weapon. */}
        <group visible={showBuilder}>
          <HammerModel />
        </group>
        {/* Slot-7 paint sprayer — the can's label band tracks the palette. */}
        <group visible={showPaint}>
          <SprayerModel />
        </group>
        {/* Muzzle flash: repositioned to the active gun's muzzle at fire time. */}
        <mesh position={[0, 0, -0.4]} ref={flashRef} visible={false}>
          <planeGeometry args={[0.16, 0.16]} />
          <meshBasicMaterial color="#ffd27a" depthWrite={false} transparent opacity={0.9} />
        </mesh>
      </group>
    </group>
  )
}

function switchWeapon(target: ToolId): void {
  const state = useBoots.getState()
  // Both tools are always available; guns must be picked up first. The
  // setWeapon cast is the ToolId bridge (see the type's doc above).
  if (target !== 'builder' && target !== 'paint' && !state.owned.includes(target)) return
  if ((state.weapon as ToolId) === target) return
  state.setWeapon(target as WeaponId)
  sfx.weaponSwitch()
}
