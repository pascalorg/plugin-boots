import {
  ALERT_SECONDS,
  type Bot,
  type BotKind,
  bots,
  damageBot,
  disarmWaves,
  armWaves,
  spawnBot,
  waveState,
} from './enemies-state'
import {
  localSessionId,
  type NetMessage,
  onFrame,
  onStateRequest,
  onStateSnapshot,
  publishFrame,
  registerFrameKind,
  requestState,
  sendStateSnapshot,
} from './net'

/**
 * Shared horde authority.
 *
 * Bots used to be simulated independently in every browser. Their random
 * spawns and per-client target made the same "wave" become different enemies
 * in different places. The lowest live game-session id now runs the director
 * and AI; everyone else follows its 10 Hz snapshots. Damage commands are
 * cumulative, so host coalescing cannot lose minigun rounds.
 */
export const HORDE_KIND = 'boots/horde' as const
export const HORDE_COMMAND_KIND = 'boots/horde-command' as const
export const HORDE_PUBLISH_HZ = 10
export const HORDE_MAX_BOTS = 64
const FOLLOW_RATE = 18

type BotWire = [
  id: number,
  kind: 0 | 1 | 2,
  x: number,
  y: number,
  z: number,
  yaw: number,
  health: number,
  dying: 0 | 1,
  deadT: number,
  phase: number,
  windupT: number,
  strikeT: number,
  seed: number,
]

export type HordeFrame = {
  v: 1
  w: number
  i: number
  a: boolean
  l: boolean
  c: number
  ca: boolean
  b: BotWire[]
}

type HordeCommandFrame = {
  v: 1
  /** Latest switch choice by this sender: [monotone revision, armed]. */
  a?: [number, boolean]
  /** Cumulative damage this sender dealt, keyed by stable bot id. */
  h?: Record<string, number>
}

type FollowTarget = {
  x: number
  y: number
  z: number
  yaw: number
}

const targets = new Map<number, FollowTarget>()
const outgoingDamage = new Map<number, number>()
const seenDamage = new Map<string, number>()
const seenToggle = new Map<string, number>()
/** Peers that actually speak the horde protocol. Older plugin pins still send
 * poses, but must never win authority and freeze a newer lobby. */
const capablePeers = new Map<string, number>()
let active = false
let publishClock = 0
let commandClock = 0
let handoffAccepted = false
let toggleRevision = 0
let toggleValue: boolean | null = null
let offFrame: (() => void) | null = null
let offCommand: (() => void) | null = null
let offRequest: (() => void) | null = null
let offSnapshot: (() => void) | null = null

const KIND_TO_WIRE: Record<BotKind, 0 | 1 | 2> = { droid: 0, dog: 1, drone: 2 }
const WIRE_TO_KIND: readonly BotKind[] = ['droid', 'dog', 'drone']
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const round2 = (v: number): number => Math.round(v * 100) / 100
const round3 = (v: number): number => Math.round(v * 1000) / 1000

export function validateHordeFrame(data: unknown): HordeFrame | null {
  if (!data || typeof data !== 'object') return null
  const f = data as Record<string, unknown>
  if (
    f.v !== 1 ||
    !Number.isInteger(f.w) ||
    !finite(f.i) ||
    typeof f.a !== 'boolean' ||
    typeof f.l !== 'boolean' ||
    !finite(f.c) ||
    typeof f.ca !== 'boolean' ||
    !Array.isArray(f.b) ||
    f.b.length > HORDE_MAX_BOTS
  ) return null
  const out: BotWire[] = []
  for (const raw of f.b) {
    if (!Array.isArray(raw) || raw.length !== 13) return null
    const [id, kind, x, y, z, yaw, health, dying, deadT, phase, windupT, strikeT, seed] = raw
    if (
      !Number.isInteger(id) || id < 1 || id > 1_000_000 ||
      (kind !== 0 && kind !== 1 && kind !== 2) ||
      !finite(x) || !finite(y) || !finite(z) ||
      Math.abs(x) > 100_000 || Math.abs(y) > 100_000 || Math.abs(z) > 100_000 ||
      !finite(yaw) || !finite(health) || health < 0 || health > 10_000 ||
      (dying !== 0 && dying !== 1) ||
      !finite(deadT) || !finite(phase) || !finite(windupT) || !finite(strikeT) || !finite(seed)
    ) return null
    out.push([id, kind, x, y, z, yaw, health, dying, deadT, phase, windupT, strikeT, seed])
  }
  return {
    v: 1,
    w: Math.max(0, Math.trunc(f.w as number)),
    i: Math.max(0, Math.min(60, f.i)),
    a: f.a,
    l: f.l,
    c: Math.max(0, Math.min(ALERT_SECONDS, f.c)),
    ca: f.ca,
    b: out,
  }
}

export function validateHordeCommand(data: unknown): HordeCommandFrame | null {
  if (!data || typeof data !== 'object') return null
  const f = data as Record<string, unknown>
  if (f.v !== 1) return null
  let a: [number, boolean] | undefined
  if (Array.isArray(f.a) && f.a.length === 2 && Number.isInteger(f.a[0]) && (f.a[0] as number) >= 0 && typeof f.a[1] === 'boolean') {
    a = [f.a[0] as number, f.a[1]]
  }
  let h: Record<string, number> | undefined
  if (f.h && typeof f.h === 'object') {
    h = {}
    let count = 0
    for (const [id, damage] of Object.entries(f.h as Record<string, unknown>)) {
      if (++count > HORDE_MAX_BOTS) break
      if (!/^\d{1,7}$/.test(id) || !finite(damage) || damage < 0 || damage > 1_000_000) continue
      h[id] = damage
    }
  }
  return { v: 1, ...(a ? { a } : {}), ...(h ? { h } : {}) }
}

/** Lowest live in-game session owns the dynamic simulation. Solo/no-bus is local. */
export function hordeAuthorityId(): string | null {
  const mine = localSessionId()
  if (!mine) return null
  let lowest = mine
  const now = Date.now()
  for (const [sessionId, heardAt] of capablePeers) {
    if (now - heardAt <= 3_000 && sessionId < lowest) lowest = sessionId
  }
  return lowest
}

export function isHordeAuthority(): boolean {
  if (!active) return true
  const mine = localSessionId()
  return mine === null || hordeAuthorityId() === mine
}

function makeSnapshot(): HordeFrame {
  const packed: BotWire[] = []
  for (let index = 0; index < bots.length && packed.length < HORDE_MAX_BOTS; index++) {
    const bot = bots[index]!
    packed.push([
      bot.id,
      KIND_TO_WIRE[bot.kind],
      round2(bot.position.x),
      round2(bot.position.y),
      round2(bot.position.z),
      round3(bot.yaw),
      round2(bot.health),
      bot.state === 'dying' ? 1 : 0,
      round2(bot.deadT),
      round2(bot.phase),
      round2(bot.windupT),
      round2(bot.strikeT),
      round2(bot.seed),
    ])
  }
  return {
    v: 1,
    w: waveState.wave,
    i: round2(waveState.intermission),
    a: waveState.armed,
    l: waveState.alerted,
    c: round2(waveState.countdown),
    ca: waveState.countdownActive,
    b: packed,
  }
}

/** A newly elected client starts with this exact local state. It may adopt
 * one incumbent snapshot before simulating. A client that already owns a
 * live wave must never be reset by a higher-id newcomer racing its first
 * empty frame onto the bus. */
function localHordeIsPristine(): boolean {
  return (
    bots.length === 0 &&
    waveState.wave === 0 &&
    waveState.intermission === 4 &&
    !waveState.armed &&
    !waveState.alerted &&
    !waveState.countdownActive
  )
}

function acceptSnapshot(frame: HordeFrame, sender: string | null): boolean {
  if (sender) capablePeers.set(sender, Date.now())
  const expected = hordeAuthorityId()
  if (sender && expected && sender !== expected) {
    // A newly joined lower-id peer is about to become authority. Let it adopt
    // one snapshot from the incumbent before it starts publishing, otherwise
    // an election handoff would reset a live wave to an empty local session.
    if (expected !== localSessionId() || handoffAccepted || !localHordeIsPristine()) return false
    handoffAccepted = true
  }
  if (sender && sender === localSessionId()) return false
  waveState.wave = frame.w
  waveState.intermission = frame.i
  waveState.armed = frame.a
  waveState.alerted = frame.l
  waveState.countdown = frame.c
  waveState.countdownActive = frame.ca

  const byId = new Map<number, Bot>()
  for (const bot of bots) byId.set(bot.id, bot)
  const keep = new Set<number>()
  for (const wire of frame.b) {
    const [id, kindCode, x, y, z, yaw, health, dying, deadT, phase, windupT, strikeT, seed] = wire
    keep.add(id)
    const kind = WIRE_TO_KIND[kindCode]!
    let bot = byId.get(id)
    if (!bot || bot.kind !== kind) {
      if (bot) bots.splice(bots.indexOf(bot), 1)
      bot = spawnBot(kind, x, z, y, id)
      bot.position.set(x, y, z)
    }
    bot.health = health
    bot.state = dying ? 'dying' : 'alive'
    bot.deadT = deadT
    bot.phase = phase
    bot.windupT = windupT
    bot.strikeT = strikeT
    bot.seed = seed
    targets.set(id, { x, y, z, yaw })
  }
  for (let i = bots.length - 1; i >= 0; i--) {
    if (!keep.has(bots[i]!.id)) {
      targets.delete(bots[i]!.id)
      bots.splice(i, 1)
    }
  }
  return true
}

function publishCommand(): void {
  const h: Record<string, number> = {}
  for (const [id, damage] of outgoingDamage) h[String(id)] = damage
  publishFrame(HORDE_COMMAND_KIND, {
    v: 1,
    ...(toggleValue === null ? {} : { a: [toggleRevision, toggleValue] as [number, boolean] }),
    ...(outgoingDamage.size === 0 ? {} : { h }),
  } satisfies HordeCommandFrame)
}

function acceptCommand(msg: NetMessage<HordeCommandFrame>): void {
  capablePeers.set(msg.sessionId, Date.now())
  const command = msg.data
  if (command.a) {
    const last = seenToggle.get(msg.sessionId) ?? -1
    if (command.a[0] > last) {
      seenToggle.set(msg.sessionId, command.a[0])
      if (command.a[1]) armWaves()
      else disarmWaves()
    }
  }
  if (!isHordeAuthority() || !command.h) return
  for (const [idText, total] of Object.entries(command.h)) {
    const key = `${msg.sessionId}:${idText}`
    const prior = seenDamage.get(key) ?? 0
    if (total <= prior) continue
    seenDamage.set(key, total)
    const bot = bots.find((candidate) => candidate.id === Number(idText))
    if (bot?.state === 'alive') damageBot(bot, Math.min(10_000, total - prior))
  }
}

/** Local E toggle: immediate feedback plus a cumulative shared command. */
export function setSharedWaves(armed: boolean): void {
  if (armed) armWaves()
  else disarmWaves()
  if (!active) return
  toggleRevision++
  toggleValue = armed
  publishCommand()
}

/** Apply damage optimistically and route it to the elected simulator. */
export function damageSharedBot(bot: Bot, damage: number): void {
  damageBot(bot, damage)
  if (!active || isHordeAuthority()) return
  outgoingDamage.set(bot.id, (outgoingDamage.get(bot.id) ?? 0) + Math.max(0, damage))
  publishCommand()
}

/** Called by the horde frame loop. False means this client follows snapshots. */
export function stepHordeSync(dt: number): boolean {
  commandClock += Math.max(0, dt)
  if (active && commandClock >= 0.5) {
    commandClock = 0
    // Capability heartbeat plus cumulative commands: old clients never enter
    // the election, and a coalesced single hit repairs itself on this tick.
    publishCommand()
  }
  if (isHordeAuthority()) {
    publishClock += dt
    if (active && publishClock >= 1 / HORDE_PUBLISH_HZ) {
      publishClock = 0
      publishFrame(HORDE_KIND, makeSnapshot())
    }
    return true
  }
  const k = 1 - Math.exp(-FOLLOW_RATE * Math.max(0, dt))
  for (const bot of bots) {
    const target = targets.get(bot.id)
    if (!target) continue
    bot.position.x += (target.x - bot.position.x) * k
    bot.position.y += (target.y - bot.position.y) * k
    bot.position.z += (target.z - bot.position.z) * k
    let dyaw = (target.yaw - bot.yaw) % (Math.PI * 2)
    if (dyaw > Math.PI) dyaw -= Math.PI * 2
    else if (dyaw < -Math.PI) dyaw += Math.PI * 2
    bot.yaw += dyaw * k
  }
  return false
}

export function startHordeSync(): void {
  if (active) return
  active = true
  registerFrameKind(HORDE_KIND, validateHordeFrame)
  registerFrameKind(HORDE_COMMAND_KIND, validateHordeCommand, { ordered: false })
  offFrame = onFrame<HordeFrame>(HORDE_KIND, (msg) => acceptSnapshot(msg.data, msg.sessionId))
  offCommand = onFrame<HordeCommandFrame>(HORDE_COMMAND_KIND, acceptCommand)
  offSnapshot = onStateSnapshot(HORDE_KIND, ({ state, msg }) => {
    const frame = validateHordeFrame(state)
    if (frame) acceptSnapshot(frame, msg.sessionId)
  })
  offRequest = onStateRequest(({ of, from }) => {
    // Every capable existing peer may answer. This is essential during an
    // election: the lower-id joiner becomes authority as soon as its
    // heartbeat lands, so the incumbent is technically a follower before it
    // sees the request. The joiner accepts only one handoff snapshot.
    if (of === HORDE_KIND) sendStateSnapshot(HORDE_KIND, from, makeSnapshot())
  })
  requestState(HORDE_KIND)
  publishCommand()
}

export function stopHordeSync(): void {
  if (!active) return
  active = false
  offFrame?.()
  offCommand?.()
  offRequest?.()
  offSnapshot?.()
  offFrame = offCommand = offRequest = offSnapshot = null
  targets.clear()
  outgoingDamage.clear()
  seenDamage.clear()
  seenToggle.clear()
  capablePeers.clear()
  publishClock = 0
  commandClock = 0
  handoffAccepted = false
  toggleRevision = 0
  toggleValue = null
}

export function hordeSyncDebug(): { active: boolean; authority: string | null; following: number } {
  return { active, authority: hordeAuthorityId(), following: targets.size }
}
