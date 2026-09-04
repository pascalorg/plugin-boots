import { hordeAuthorityId } from './horde-sync'
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

/** Tree destruction shares the horde's elected simulator. Gun hits are
 * cumulative commands (safe under host coalescing); the simulator publishes
 * the resulting grove at 5 Hz and answers late joiners. */
export const TREE_KIND = 'boots/trees' as const
export const TREE_COMMAND_KIND = 'boots/tree-command' as const
export const TREE_SYNC_CAP = 128
const TREE_PUBLISH_HZ = 5

export type TreeStateWire = 0 | 1 | 2 | 3
export type TreeWire = [
  id: number,
  state: TreeStateWire,
  hp: number,
  canopyDamage: number,
  burnT: number,
  charHits: number,
]
export type TreeFrame = { v: 1; t: TreeWire[] }
export type TreeCommandFrame = {
  v: 1
  /** [id, trunk hit count/damage, canopy hit count/damage]. */
  h: Array<[number, number, number, number, number]>
}

type TreeSyncAdapter = {
  snapshot: () => TreeFrame
  applySnapshot: (frame: TreeFrame) => void
  applyDamage: (treeId: number, part: 'trunk' | 'canopy', damage: number) => void
  pristine: () => boolean
}

type DamageTotals = {
  trunkHits: number
  trunkDamage: number
  canopyHits: number
  canopyDamage: number
}

const outgoing = new Map<number, DamageTotals>()
const seen = new Map<string, DamageTotals>()
let adapter: TreeSyncAdapter | null = null
let publishClock = 0
let commandClock = 0
let handoffAccepted = false
let offState: (() => void) | null = null
let offCommand: (() => void) | null = null
let offRequest: (() => void) | null = null
let offSnapshot: (() => void) | null = null
let receiveOnly = false

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function readTreeFrame(data: unknown): TreeFrame | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (raw.v !== 1 || !Array.isArray(raw.t) || raw.t.length > TREE_SYNC_CAP) return null
  const trees: TreeWire[] = []
  for (const entry of raw.t) {
    if (!Array.isArray(entry) || entry.length !== 6) return null
    const [id, state, hp, canopyDamage, burnT, charHits] = entry
    if (
      !Number.isInteger(id) || id < 0 || id >= TREE_SYNC_CAP ||
      (state !== 0 && state !== 1 && state !== 2 && state !== 3) ||
      !finite(hp) || hp < -10_000 || hp > 10_000 ||
      !finite(canopyDamage) || canopyDamage < 0 || canopyDamage > 10_000 ||
      !finite(burnT) || burnT < 0 || burnT > 60 ||
      !Number.isInteger(charHits) || charHits < 0 || charHits > 16
    ) return null
    trees.push([id, state, hp, canopyDamage, burnT, charHits])
  }
  return { v: 1, t: trees }
}

export function readTreeCommand(data: unknown): TreeCommandFrame | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  if (raw.v !== 1 || !Array.isArray(raw.h) || raw.h.length > TREE_SYNC_CAP) return null
  const hits: TreeCommandFrame['h'] = []
  for (const entry of raw.h) {
    if (!Array.isArray(entry) || entry.length !== 5) return null
    const [id, trunkHits, trunkDamage, canopyHits, canopyDamage] = entry
    if (
      !Number.isInteger(id) || id < 0 || id >= TREE_SYNC_CAP ||
      !Number.isInteger(trunkHits) || trunkHits < 0 || trunkHits > 1_000_000 ||
      !finite(trunkDamage) || trunkDamage < 0 || trunkDamage > 10_000_000 ||
      !Number.isInteger(canopyHits) || canopyHits < 0 || canopyHits > 1_000_000 ||
      !finite(canopyDamage) || canopyDamage < 0 || canopyDamage > 10_000_000
    ) return null
    hits.push([id, trunkHits, trunkDamage, canopyHits, canopyDamage])
  }
  return { v: 1, h: hits }
}

function publishCommands(): void {
  if (!adapter) return
  const h: TreeCommandFrame['h'] = []
  for (const [id, total] of outgoing) {
    h.push([id, total.trunkHits, total.trunkDamage, total.canopyHits, total.canopyDamage])
  }
  publishFrame(TREE_COMMAND_KIND, { v: 1, h } satisfies TreeCommandFrame)
}

function publishSnapshot(): void {
  if (adapter) publishFrame(TREE_KIND, adapter.snapshot())
}

function applySnapshot(frame: TreeFrame, sender: string | null): void {
  if (!adapter || (sender && sender === localSessionId())) return
  // An editor observer is deliberately absent from horde election, so its
  // own collaboration id must never masquerade as the simulator. Active
  // players already admit frames from only the elected authority; accepting
  // their receive stream directly keeps the overview current at 5 Hz.
  if (receiveOnly) {
    adapter.applySnapshot(frame)
    return
  }
  const authority = hordeAuthorityId()
  if (sender && authority && sender !== authority) {
    if (authority !== localSessionId() || handoffAccepted || !adapter.pristine()) return
    handoffAccepted = true
  }
  adapter.applySnapshot(frame)
}

function applyCommand(msg: NetMessage<TreeCommandFrame>): void {
  if (!adapter) return
  const authority = hordeAuthorityId() === localSessionId()
  for (const [id, trunkHits, trunkDamage, canopyHits, canopyDamage] of msg.data.h) {
    const key = `${msg.sessionId}:${id}`
    const prior = seen.get(key) ?? { trunkHits: 0, trunkDamage: 0, canopyHits: 0, canopyDamage: 0 }
    const next = {
      trunkHits: Math.max(prior.trunkHits, trunkHits),
      trunkDamage: Math.max(prior.trunkDamage, trunkDamage),
      canopyHits: Math.max(prior.canopyHits, canopyHits),
      canopyDamage: Math.max(prior.canopyDamage, canopyDamage),
    }
    seen.set(key, next)
    if (!authority) continue
    const applyPart = (
      part: 'trunk' | 'canopy',
      hitDelta: number,
      damageDelta: number,
    ) => {
      if (hitDelta <= 0 || damageDelta < 0) return
      // Three calls finish the charred-tree state machine; larger coalesced
      // bursts retain their full damage without an effects storm.
      const calls = Math.min(3, hitDelta)
      const each = damageDelta / calls
      for (let i = 0; i < calls; i++) adapter?.applyDamage(id, part, each)
    }
    applyPart('trunk', next.trunkHits - prior.trunkHits, next.trunkDamage - prior.trunkDamage)
    applyPart('canopy', next.canopyHits - prior.canopyHits, next.canopyDamage - prior.canopyDamage)
  }
}

export function recordTreeDamage(treeId: number, part: 'trunk' | 'canopy', damage: number): void {
  if (
    !adapter ||
    hordeAuthorityId() === localSessionId() ||
    !(damage > 0) ||
    !Number.isInteger(treeId) ||
    treeId < 0 ||
    treeId >= TREE_SYNC_CAP
  ) return
  const total = outgoing.get(treeId) ?? {
    trunkHits: 0,
    trunkDamage: 0,
    canopyHits: 0,
    canopyDamage: 0,
  }
  if (part === 'trunk') {
    total.trunkHits++
    total.trunkDamage += damage
  } else {
    total.canopyHits++
    total.canopyDamage += damage
  }
  outgoing.set(treeId, total)
  publishCommands()
}

export function startTreeSync(
  next: TreeSyncAdapter,
  options: { receiveOnly?: boolean } = {},
): void {
  adapter = next
  receiveOnly = options.receiveOnly === true
  registerFrameKind(TREE_KIND, readTreeFrame)
  registerFrameKind(TREE_COMMAND_KIND, readTreeCommand, { ordered: false })
  offState ??= onFrame<TreeFrame>(TREE_KIND, (msg) => applySnapshot(msg.data, msg.sessionId))
  if (!receiveOnly) offCommand ??= onFrame<TreeCommandFrame>(TREE_COMMAND_KIND, applyCommand)
  offSnapshot ??= onStateSnapshot(TREE_KIND, ({ state, msg }) => {
    const frame = readTreeFrame(state)
    if (frame) applySnapshot(frame, msg.sessionId)
  })
  if (!receiveOnly) {
    offRequest ??= onStateRequest(({ of, from }) => {
      if (of === TREE_KIND && adapter) sendStateSnapshot(TREE_KIND, from, adapter.snapshot())
    })
  }
  requestState(TREE_KIND)
}

export function stopTreeSync(): void {
  adapter = null
  offState?.()
  offCommand?.()
  offRequest?.()
  offSnapshot?.()
  offState = offCommand = offRequest = offSnapshot = null
  outgoing.clear()
  seen.clear()
  publishClock = 0
  commandClock = 0
  handoffAccepted = false
  receiveOnly = false
}

export function stepTreeSync(dt: number): void {
  if (!adapter || receiveOnly) return
  publishClock += Math.max(0, dt)
  commandClock += Math.max(0, dt)
  if (hordeAuthorityId() === localSessionId()) {
    if (publishClock >= 1 / TREE_PUBLISH_HZ) {
      publishClock = 0
      publishSnapshot()
    }
  } else if (commandClock >= 0.5) {
    commandClock = 0
    if (outgoing.size > 0) publishCommands()
  }
}
