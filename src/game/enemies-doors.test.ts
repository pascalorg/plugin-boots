import { describe, expect, test } from 'bun:test'
import { Box3, Vector3 } from 'three'
import {
  accrueDoorStuck,
  type Bot,
  type BotKind,
  botVisualParams,
  DOOR_APPROACH_OFFSET,
  DOOR_SCAN_PERIOD,
  DOOR_SCAN_RANGE,
  DOOR_STUCK_TIME,
  type DoorScanWorld,
  doorIsClosed,
  doorScanDue,
  pickDoorCandidate,
  setDoorApproach,
} from './enemies-state'

/**
 * BOTS LEARN DOORWAYS — the pure halves (enemies-state.ts): the stuck clock
 * that arms the hunt, the budgeted scan gate (≤1 check per bot per 0.5 s,
 * stuck bots only), and the door-candidate pick over a stubbed world.doors
 * list (closed doors only — open/voxelized leaves and pure openings never
 * count). The walk/pause/toggle state machine lives in enemies.tsx and is
 * exercised live; everything it decides on is pinned here.
 */

function makeBot(kind: BotKind, x: number, z: number): Bot {
  return {
    id: 1,
    kind,
    position: new Vector3(x, 0, z),
    yaw: 0,
    health: 65,
    state: 'alive',
    deadT: 0,
    attackCooldown: 1,
    phase: 0,
    seed: 0,
    blockedT: 0,
    followT: 0,
    followSign: 1,
    climb: 0,
    groundY: 0,
    groundX: x,
    groundZ: z,
    groundT: 0,
    stuckT: 0,
    doorScanT: 0,
    doorId: null,
    doorX: 0,
    doorZ: 0,
    doorFumbleT: 0,
    doorT: 0,
    visual: botVisualParams(1, kind, 0),
  }
}

/** A door-leaf world box: 0.9 m wide, 2 m tall, 0.12 m thick at (cx, cz). */
function leafBox(cx: number, cz: number): Box3 {
  return new Box3(new Vector3(cx - 0.45, 0, cz - 0.06), new Vector3(cx + 0.45, 2, cz + 0.06))
}

type DoorStub = {
  nodeId: string
  cx: number
  cz: number
  /** All of this door's colliders read as disabled (open / voxelized). */
  disabled?: boolean
  openingKind?: string
}

/** Stub the DoorScanWorld slice: one collider per door, indices line up. */
function makeDoorWorld(stubs: DoorStub[]): DoorScanWorld {
  return {
    doors: stubs.map((stub, index) => ({
      nodeId: stub.nodeId,
      colliderIndices: [index],
      node: stub.openingKind ? { openingKind: stub.openingKind } : { doorType: 'hinged' },
    })),
    colliders: stubs.map((stub) => ({
      worldBox: leafBox(stub.cx, stub.cz),
      disabled: stub.disabled,
    })),
  }
}

describe('doorway-hunt stuck clock (accrueDoorStuck)', () => {
  test('accrues while hindered, survives across frames, resets when free', () => {
    const bot = makeBot('droid', 0, 0)
    for (let i = 0; i < 30; i++) accrueDoorStuck(bot, true, 1 / 60)
    expect(bot.stuckT).toBeCloseTo(0.5, 5)
    accrueDoorStuck(bot, true, 1 / 60)
    expect(bot.stuckT).toBeGreaterThan(0.5)
    accrueDoorStuck(bot, false, 1 / 60) // real progress — the hunt re-arms
    expect(bot.stuckT).toBe(0)
  })
})

describe('door-scan budget gate (doorScanDue)', () => {
  test('never due before DOOR_STUCK_TIME of hindrance', () => {
    const bot = makeBot('dog', 0, 0)
    bot.stuckT = DOOR_STUCK_TIME - 0.01
    expect(doorScanDue(bot, 1 / 60)).toBe(false)
  })

  test('never due while a door mission is already armed', () => {
    const bot = makeBot('droid', 0, 0)
    bot.stuckT = DOOR_STUCK_TIME + 1
    bot.doorId = 'door-1'
    expect(doorScanDue(bot, 1 / 60)).toBe(false)
    // And the gate did not consume budget for the armed bot.
    expect(bot.doorScanT).toBe(0)
  })

  test('fires at most once per DOOR_SCAN_PERIOD while stuck (60 Hz, 2 s → 4 scans)', () => {
    const bot = makeBot('droid', 0, 0)
    bot.stuckT = DOOR_STUCK_TIME // stuck the whole window
    let fires = 0
    for (let i = 0; i < 120; i++) {
      if (doorScanDue(bot, 1 / 60)) fires++
    }
    // First scan immediate (doorScanT seeds at 0), then every 0.5 s: frames
    // 1, 31, 61, 91 of 120 — exactly 4, never more.
    expect(fires).toBe(4)
    expect(bot.doorScanT).toBeGreaterThan(0)
  })
})

describe('door-candidate selection (pickDoorCandidate)', () => {
  test('nearest closed door within range wins and reports its center', () => {
    const world = makeDoorWorld([
      { nodeId: 'door-far', cx: 2.5, cz: 0 },
      { nodeId: 'door-near', cx: 1.2, cz: 0.5 },
    ])
    const out = new Vector3()
    expect(pickDoorCandidate(world, 0, 0, DOOR_SCAN_RANGE, out)).toBe('door-near')
    expect(out.x).toBeCloseTo(1.2, 5)
    expect(out.z).toBeCloseTo(0.5, 5)
  })

  test('doors beyond DOOR_SCAN_RANGE are ignored', () => {
    const world = makeDoorWorld([{ nodeId: 'door-1', cx: DOOR_SCAN_RANGE + 0.5, cz: 0 }])
    expect(pickDoorCandidate(world, 0, 0, DOOR_SCAN_RANGE, new Vector3())).toBeNull()
  })

  test('an already-open door (all colliders disabled) never counts — the farther closed one wins', () => {
    const world = makeDoorWorld([
      { nodeId: 'door-open', cx: 1, cz: 0, disabled: true }, // open OR voxelized
      { nodeId: 'door-closed', cx: 2.5, cz: 0 },
    ])
    const out = new Vector3()
    expect(pickDoorCandidate(world, 0, 0, DOOR_SCAN_RANGE, out)).toBe('door-closed')
    expect(out.x).toBeCloseTo(2.5, 5)
  })

  test('pure openings (openingKind "opening") have no leaf to fumble', () => {
    const world = makeDoorWorld([{ nodeId: 'door-hole', cx: 1, cz: 0, openingKind: 'opening' }])
    expect(pickDoorCandidate(world, 0, 0, DOOR_SCAN_RANGE, new Vector3())).toBeNull()
  })

  test('dangling collider indices are tolerated (hand-built worlds)', () => {
    const world: DoorScanWorld = {
      doors: [{ nodeId: 'door-ghost', colliderIndices: [7], node: { doorType: 'hinged' } }],
      colliders: [],
    }
    expect(pickDoorCandidate(world, 0, 0, DOOR_SCAN_RANGE, new Vector3())).toBeNull()
  })
})

describe('doorIsClosed (the pre-toggle re-check)', () => {
  test('true while any collider still blocks; false once opened; false for unknown ids', () => {
    const world = makeDoorWorld([
      { nodeId: 'door-shut', cx: 1, cz: 0 },
      { nodeId: 'door-ajar', cx: 3, cz: 0, disabled: true },
    ])
    expect(doorIsClosed(world, 'door-shut')).toBe(true)
    expect(doorIsClosed(world, 'door-ajar')).toBe(false)
    expect(doorIsClosed(world, 'door-nope')).toBe(false)
  })
})

describe('setDoorApproach (mission arming)', () => {
  test('approach point sits DOOR_APPROACH_OFFSET from the center, on the bot side', () => {
    const bot = makeBot('droid', 3, 0)
    bot.doorT = 2
    bot.doorFumbleT = 0.3
    setDoorApproach(bot, 'door-1', 1, 0)
    expect(bot.doorId).toBe('door-1')
    expect(bot.doorX).toBeCloseTo(1 + DOOR_APPROACH_OFFSET, 5) // toward +x — the bot side
    expect(bot.doorZ).toBeCloseTo(0, 5)
    expect(bot.doorT).toBe(0) // clocks re-armed
    expect(bot.doorFumbleT).toBe(0)
  })

  test('a bot standing exactly on the center degrades to the center itself', () => {
    const bot = makeBot('dog', 1, 2)
    setDoorApproach(bot, 'door-1', 1, 2)
    expect(bot.doorX).toBeCloseTo(1, 5)
    expect(bot.doorZ).toBeCloseTo(2, 5)
  })
})

// Cross-constant sanity: the scan cadence honors the assignment's budget and
// the hunt only starts past the blocked threshold it promises.
test('budget constants: scan ≥ 0.5 s apart, hunt arms only past 1.2 s stuck, 3 m range', () => {
  expect(DOOR_SCAN_PERIOD).toBeGreaterThanOrEqual(0.5)
  expect(DOOR_STUCK_TIME).toBeGreaterThanOrEqual(1.2)
  expect(DOOR_SCAN_RANGE).toBe(3)
})
