'use client'

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { type Group, Quaternion } from 'three'
import { useBoots } from '../store'
import {
  gripQuaternion,
  HAND_GRIPS,
  type HandGrip,
  heelPoint,
  READY_TIME,
  readyBob,
  RECOIL_TIME,
  recoilCurve,
  SUPPORT_LAG,
  TRIGGER_ADS_TIGHTEN,
  TRIGGER_TIME,
  triggerCurve,
} from './hand-grips'
import { TRIGGER_CURL, TRIGGER_REST } from './hand-pose'
import { ArticulatedHand, Forearm, HandMesh, type TriggerRefs } from './hand-rig'
import { playerRig } from './player'
import type { ToolId } from './viewmodel'

/**
 * FIRST-PERSON HANDS — the arms holding the viewmodel weapon.
 *
 * The guns render grip-at-origin with the barrel down −Z (weapon-models.tsx).
 * This mounts, per weapon, the shared procedural hand (hand-rig.tsx: palm,
 * four fingers, thumb, wrist — one merged geometry) at the grip the table in
 * hand-grips.ts describes, plus a jacket sleeve leaving each wrist toward the
 * off-screen shoulder. The right hand of every gun carries a LIVE index
 * finger: it rests on the trigger, tightens at ADS, and squeezes on each shot;
 * the support hand lags the recoil and settles after a draw. Same skin as the
 * avatar teammates see in the mirror.
 *
 * All weapon-model space under the viewmodel's pose group. The hands are
 * children of the per-weapon visibility group, so switching weapons shows the
 * matching hold for free. Zero per-frame allocation: refs and state live in
 * module tables keyed by weapon (only ONE Viewmodel ever mounts — the depot
 * mirror hides it by name rather than mounting a second).
 *
 * MOTION SIGNALS. Until the viewmodel feeds `handSignals` (round 2: it owns
 * recoilT/aim/draw and can write exact values), the hands derive their own
 * from playerRig: a shot is `playerRig.shots` ticking (the monotone round
 * counter the trigger loop bumps for every round that leaves a barrel — the
 * same one the wire carries), aim is `playerRig.ads`, a draw is the parent
 * group turning visible. Set `handSignals.external = true` and write the
 * fields each frame BEFORE this useFrame to take over.
 */

export type HandsRefs = {
  right: { current: Group | null }
  left: { current: Group | null }
  trigger: TriggerRefs
}

const TOOL_IDS: readonly ToolId[] = ['knife', 'pistol', 'rifle', 'minigun', 'hammer', 'builder', 'paint']

function makeRefs(): HandsRefs {
  return {
    right: { current: null },
    left: { current: null },
    trigger: [{ current: null }, { current: null }, { current: null }],
  }
}

/** Live handles per weapon: the right/left hand groups (weapon space) and the
 * three index joints (write rotation.y only). Built once. */
export const HAND_REFS: Record<ToolId, HandsRefs> = Object.fromEntries(TOOL_IDS.map((w) => [w, makeRefs()])) as Record<
  ToolId,
  HandsRefs
>

/** Per-frame inputs the hands animate from. `external: false` → derived here. */
export const handSignals = {
  external: false,
  /** Set true for one frame when a round leaves the barrel. */
  shot: false,
  /** 0..1 aim-down-sights blend. */
  aim: 0,
  /** Set true for one frame when the shown weapon changes. */
  drawn: false,
}

export type HandMotionState = {
  triggerT: number
  recoilT: number
  readyT: number
  prevShots: number
  prevShown: boolean
  /** Last applied values, for QA. */
  squeeze: number
  recoil: number
  ready: number
  aim: number
  /** Highest recoil/squeeze since the last shot — QA reads these because a
   * 3 fps headless poll misses the 0.1 s peak. */
  peakRecoil: number
  peakSqueeze: number
}
function makeMotion(): HandMotionState {
  return {
    triggerT: 1,
    recoilT: 1,
    readyT: 1,
    prevShots: 0,
    prevShown: false,
    squeeze: 0,
    recoil: 0,
    ready: 0,
    aim: 0,
    peakRecoil: 0,
    peakSqueeze: 0,
  }
}
const MOTION: Record<ToolId, HandMotionState> = Object.fromEntries(TOOL_IDS.map((w) => [w, makeMotion()])) as Record<
  ToolId,
  HandMotionState
>

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * Advance one hand's motion clocks. Pure over `st`; returns nothing, writes
 * st.squeeze / st.recoil / st.ready / st.aim for the appliers. `shot` and
 * `drawn` restart the trigger+recoil and the ready dip.
 */
export function stepHandMotion(st: HandMotionState, dt: number, shot: boolean, drawn: boolean, aim: number): void {
  if (shot) {
    st.triggerT = 0
    st.recoilT = 0
    st.peakRecoil = 0
    st.peakSqueeze = 0
  }
  if (drawn) st.readyT = 0
  st.triggerT = Math.min(1, st.triggerT + dt / TRIGGER_TIME)
  st.recoilT = Math.min(1, st.recoilT + dt / RECOIL_TIME)
  st.readyT = Math.min(1, st.readyT + dt / READY_TIME)
  st.aim = clamp01(aim)
  st.squeeze = st.triggerT >= 1 ? 0 : triggerCurve(st.triggerT)
  st.recoil = st.recoilT >= 1 ? 0 : recoilCurve(st.recoilT)
  st.ready = st.readyT >= 1 ? 0 : readyBob(st.readyT)
  if (st.recoil > st.peakRecoil) st.peakRecoil = st.recoil
  if (st.squeeze > st.peakSqueeze) st.peakSqueeze = st.squeeze
}

/** The three LOCAL index joint angles for a squeeze/aim/idle state. */
export function triggerAngles(squeeze: number, aim: number, idle: number, out: [number, number, number]): [number, number, number] {
  for (let i = 0; i < 3; i++) {
    const rest = TRIGGER_REST[i] as number
    out[i] = rest + aim * TRIGGER_ADS_TIGHTEN + idle + ((TRIGGER_CURL[i] as number) - rest) * squeeze
  }
  return out
}

/** Support-hand offset from its table position: the ready dip (down, fading
 * with aim) and the recoil lag (the gun slides back through a soft hand). */
export function supportOffset(recoil: number, ready: number, aim: number, out: [number, number, number]): [number, number, number] {
  out[0] = 0
  out[1] = -ready * (1 - aim)
  out[2] = -recoil * SUPPORT_LAG
  return out
}

const _angles: [number, number, number] = [0, 0, 0]
const _off: [number, number, number] = [0, 0, 0]

/** Idle finger drift (rad): a slow breath on the trigger finger, steadied at ADS. */
export function idleDrift(t: number, aim: number): number {
  return 0.04 * Math.sin(t * 1.6 + 1) * (1 - 0.75 * aim)
}

// ── QA handle ────────────────────────────────────────────────────────────────
let mounted = 0
function installQa(): void {
  if (mounted++ > 0) return
  ;(globalThis as Record<string, unknown>).__bootsHands = () => {
    const shown = useBoots.getState().weapon as ToolId
    const st = MOTION[shown] ?? MOTION.knife
    const h = HAND_REFS[shown] ?? HAND_REFS.knife
    const l = h.left.current
    return {
      shown,
      recoil: st.recoil,
      trigger: st.squeeze,
      ready: st.ready,
      aim: st.aim,
      triggerT: st.triggerT,
      peakRecoil: st.peakRecoil,
      peakTrigger: st.peakSqueeze,
      external: handSignals.external,
      triggerAngles: h.trigger.map((r) => r.current?.rotation.y ?? null),
      leftPos: l ? [l.position.x, l.position.y, l.position.z] : null,
      rightMounted: !!h.right.current,
    }
  }
}
function uninstallQa(): void {
  if (--mounted > 0) return
  delete (globalThis as Record<string, unknown>).__bootsHands
}

// ── The component ────────────────────────────────────────────────────────────

function OneHand({ g, side, refs }: { g: HandGrip; side: 'R' | 'L'; refs: HandsRefs }) {
  const q = useMemo(() => gripQuaternion(g, side, new Quaternion()), [g, side])
  const heel = useMemo(() => heelPoint(g, side, [0, 0, 0]), [g, side])
  const ref = side === 'R' ? refs.right : refs.left
  return (
    <group ref={ref} position={[g.position[0], g.position[1], g.position[2]]}>
      <group quaternion={q}>
        {side === 'R' && g.pose === 'trigger' ? (
          <ArticulatedHand pose={g.pose} side="R" triggerRefs={refs.trigger} />
        ) : (
          <HandMesh pose={g.pose} side={side} wrist />
        )}
      </group>
      {/* The sleeve is a SIBLING of the rotated hand: it hangs from the heel
          point and heads for the shoulder whatever the hand's roll. */}
      <Forearm arm={g.arm} position={[heel[0] - g.position[0], heel[1] - g.position[1], heel[2] - g.position[2]]} />
    </group>
  )
}

/**
 * The hands for one viewmodel weapon. Mounted once per weapon group in the
 * viewmodel (its parent's `visible` gates it).
 */
export function WeaponHands({ weapon }: { weapon: ToolId }) {
  const hold = HAND_GRIPS[weapon] ?? HAND_GRIPS.knife
  const refs = HAND_REFS[weapon] ?? HAND_REFS.knife
  const st = MOTION[weapon] ?? MOTION.knife

  useEffect(() => {
    installQa()
    return uninstallQa
  }, [])

  useFrame((state, dt) => {
    const right = refs.right.current
    if (!right) return
    const shown = right.parent ? right.parent.visible : true
    let shot: boolean
    let drawn: boolean
    let aim: number
    if (handSignals.external) {
      shot = handSignals.shot
      drawn = handSignals.drawn
      aim = handSignals.aim
    } else {
      const n = (playerRig as { shots?: number }).shots ?? 0
      shot = shown && n !== st.prevShots
      st.prevShots = n
      drawn = shown && !st.prevShown
      st.prevShown = shown
      const a = (playerRig as { ads?: number }).ads
      aim = typeof a === 'number' ? a : 0
    }
    if (!shown) {
      // Hidden hands keep their clocks parked so the next draw starts clean.
      st.triggerT = 1
      st.recoilT = 1
      return
    }
    stepHandMotion(st, Math.min(dt, 1 / 30), shot, drawn, aim)
    const left = refs.left.current
    if (left && hold.left) {
      supportOffset(st.recoil, st.ready, st.aim, _off)
      const p = hold.left.position
      left.position.set(p[0] + _off[0], p[1] + _off[1], p[2] + _off[2])
    }
    if (hold.trigger) {
      triggerAngles(st.squeeze, st.aim, idleDrift(state.clock.elapsedTime, st.aim), _angles)
      for (let i = 0; i < 3; i++) {
        const seg = refs.trigger[i]?.current
        if (seg) seg.rotation.y = _angles[i] as number
      }
    }
  })

  return (
    <>
      <OneHand g={hold.right} side="R" refs={refs} />
      {hold.left ? <OneHand g={hold.left} side="L" refs={refs} /> : null}
    </>
  )
}
