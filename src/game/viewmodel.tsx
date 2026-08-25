'use client'

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import type { Group, Mesh, Object3D } from 'three'
import type { WeaponId } from '../store'
import { useBoots } from '../store'
import { sfx } from './audio'
import { MOVE } from './movement'
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

/**
 * Classic FPS anchor: low-right of screen, barrel converging on the crosshair.
 * Tuned to the weapon-models extents at the game FOV (90-ish vertical): the
 * pistol/knife sit closer so the small models read; the rifle stays at arm's
 * length so its muzzle (model z ~ -0.6) lands right of the crosshair, with the
 * stock running off the bottom-right corner. Every part stays > 0.11 in front
 * of the camera through recoil (+0.07 z) and draw-in, clear of the near plane.
 */
/** store.ts gains 'minigun' in WeaponId this round (builder-3x3 agent); this
 * cast bridges until it lands and collapses to a no-op after. */
const MINIGUN = 'minigun' as WeaponId

// The `| 'minigun'` widening is a no-op once WeaponId includes it.
const POSES: Record<
  WeaponId | 'minigun',
  { pos: [number, number, number]; rot: [number, number, number] }
> = {
  knife: { pos: [0.3, -0.3, -0.42], rot: [0.05, -0.24, 0.12] },
  pistol: { pos: [0.3, -0.28, -0.45], rot: [0, -0.07, 0.03] },
  rifle: { pos: [0.33, -0.3, -0.5], rot: [0.01, -0.09, 0.04] },
  // The big one rides lower and closer to center — it's huge, most of the
  // drum should sit at the bottom-right edge with the barrels crossing in.
  minigun: { pos: [0.22, -0.36, -0.56], rot: [0.01, -0.05, 0.02] },
  builder: { pos: [0.32, -0.33, -0.46], rot: [0.07, -0.28, 0.14] },
}

const DRAW_TIME = 0.14
const DIP_TIME = 0.3
/** Barrel cluster speed at full spin (rad/s) and spin-down time (s). */
const BARREL_SPIN_RATE = 28
const SPIN_DOWN_TIME = 0.9
const TWO_PI = Math.PI * 2

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
  const prevFiring = useRef(false)
  const swingT = useRef(1)
  const recoilT = useRef(1)
  const flashT = useRef(0)

  const weapon = useBoots((s) => s.weapon)

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

  // Kill the whine if the session unmounts mid-spin.
  useEffect(
    () => () => {
      spinSfx.current?.stop()
      spinSfx.current = null
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
      else if (action === 'Digit5') switchWeapon(MINIGUN)
      else if (action === 'WheelUp' || action === 'WheelDown') {
        const list = [...state.owned, 'builder' as const]
        const at = list.indexOf(state.weapon)
        const next = list[(at + (action === 'WheelDown' ? 1 : list.length - 1)) % list.length]!
        switchWeapon(next)
      } else if (action === 'KeyQ' && state.weapon === 'builder') {
        const order = ['wall', 'floor', 'roof'] as const
        state.setBuildPiece(order[(order.indexOf(state.buildPiece) + 1) % order.length]!)
      }
    }

    cooldown.current -= dt
    swingT.current = Math.min(1, swingT.current + dt * 5.2)
    recoilT.current = Math.min(1, recoilT.current + dt * 9)
    flashT.current -= dt
    if (flashRef.current) flashRef.current.visible = flashT.current > 0

    const firing = session.input.state.firing
    const current = useBoots.getState().weapon
    const staggered = useBoots.getState().staggered
    // Weapon droop while staggered — slow lerp both ways so the arm sags
    // and recovers smoothly instead of snapping.
    droop.current += ((staggered ? 1 : 0) - droop.current) * Math.min(1, dt * 6)
    // Get-up re-ready: when the stagger ends, re-raise the weapon from below
    // (negative drawT = a short fully-lowered hold before the 0.14s rise, so
    // the re-grip lands inside the camera's get-up beat).
    if (prevStaggered.current && !staggered) drawT.current = -0.4
    prevStaggered.current = staggered

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
    const heldDef = current !== 'builder' ? WEAPONS[current] : undefined
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

    if (current !== 'builder' && !staggered) {
      const def = WEAPONS[current]
      const spunUp = def.spinUp === undefined || spinT.current >= 1
      const wantsShot = (def.auto ? firing : firing && !prevFiring.current) && spunUp
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
    prevFiring.current = firing

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

    const p = poseRef.current
    if (p) {
      const sag = droop.current
      p.position.set(
        pose.pos[0] + bobX + breatheX + lagYaw.current * 0.35 + rumX,
        pose.pos[1] + bobY + breatheY - dip - draw * 0.24 - swing * 0.1 + lagPitch.current * 0.3 - sag * 0.06 + rumY,
        pose.pos[2] + recoil * 0.07,
      )
      p.rotation.set(
        pose.rot[0] - draw * 0.55 - dip * 1.4 - swing * 1.7 + recoil * 0.14 + lagPitch.current - sag * 0.12,
        pose.rot[1] + lagYaw.current + swing * 0.5,
        pose.rot[2] + bobRoll + swing * 0.3 + sag * 0.07,
      )
    }
  })

  const showKnife = weapon === 'knife'
  const showPistol = weapon === 'pistol'
  const showRifle = weapon === 'rifle'
  const showMinigun = weapon === MINIGUN
  const showBuilder = weapon === 'builder'

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
        <group visible={showBuilder}>
          <HammerModel />
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

function switchWeapon(target: WeaponId): void {
  const state = useBoots.getState()
  if (target !== 'builder' && !state.owned.includes(target)) return
  if (state.weapon === target) return
  state.setWeapon(target)
  sfx.weaponSwitch()
}
