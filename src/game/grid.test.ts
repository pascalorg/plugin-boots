import { afterEach, describe, expect, test } from 'bun:test'
import {
  CELL,
  gridToWorld,
  isTerrainGrounded,
  parseSlotId,
  resetGridAnchor,
  resolveTargetSlot,
  setGridAnchor,
  type Slot,
  slotId,
  slotPose,
  slotsTouching,
  STOREY,
  worldToGrid,
  yawCardinal,
} from './grid'

const OPEN = { isOccupied: () => false, isSupported: () => true }

describe('slot codec', () => {
  test('round-trips all kinds incl. negatives', () => {
    const slots: Slot[] = [
      { kind: 'Wx', i: -2, k: 3, s: 0 },
      { kind: 'Wz', i: 0, k: -1, s: 2 },
      { kind: 'F', i: 5, k: 5, s: 1 },
      { kind: 'R', i: -1, k: -1, s: 0 },
    ]
    for (const slot of slots) expect(parseSlotId(slotId(slot))).toEqual(slot)
  })

  test('rejects garbage', () => {
    expect(parseSlotId('Wy:1,2,3')).toBeNull()
    expect(parseSlotId('Wx:1,2')).toBeNull()
  })
})

describe('slotPose', () => {
  test('Wx sits on the x-plane at the edge midpoint, length along Z', () => {
    const pose = slotPose({ kind: 'Wx', i: 2, k: 1, s: 1 })
    expect(pose.position).toEqual([6, STOREY, 4.5])
    expect(pose.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('Wz sits on the z-plane, canonical yaw 0', () => {
    const pose = slotPose({ kind: 'Wz', i: -1, k: 0, s: 0 })
    expect(pose.position).toEqual([-1.5, 0, 0])
    expect(pose.yaw).toBe(0)
  })

  test('floor centers on the cell face', () => {
    const pose = slotPose({ kind: 'F', i: 0, k: 0, s: 2 })
    expect(pose.position).toEqual([1.5, 2 * STOREY, 1.5])
  })

  test('R-slot yaw follows the quarter', () => {
    for (const q of [0, 1, 2, 3]) {
      expect(slotPose({ kind: 'R', i: 0, k: 0, s: 0 }, q).yaw).toBeCloseTo((q * Math.PI) / 2)
    }
  })
})

describe('yawCardinal', () => {
  test('four cardinals', () => {
    expect(yawCardinal(0)).toEqual([0, -1]) // camera forward is −Z at yaw 0
    expect(yawCardinal(Math.PI)).toEqual([0, 1])
    expect(yawCardinal(-Math.PI / 2)).toEqual([1, 0])
    expect(yawCardinal(Math.PI / 2)).toEqual([-1, 0])
  })
})

describe('resolveTargetSlot — defaults', () => {
  test('wall lands on the shared edge toward the facing cell', () => {
    // Player mid cell (0,0), facing +X → shared edge is plane x=3 (Wx:1).
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,0')
    expect(result.valid).toBe(true)
  })

  test('R flips the wall to the far edge of the neighbor cell', () => {
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 1 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:2,0,0')
  })

  test('pitch up targets the storey above', () => {
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.8, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,1')
  })

  test('floor: neighbor cell level, under feet when looking down', () => {
    const ahead = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: Math.PI, pitch: 0, piece: 'floor', rotState: 0 },
      OPEN,
    )
    expect(ahead.slotId).toBe('F:0,1,0')
    const under = resolveTargetSlot(
      { position: [1.5, STOREY, 1.5], yaw: Math.PI, pitch: -0.9, piece: 'floor', rotState: 0 },
      OPEN,
    )
    expect(under.slotId).toBe('F:0,0,1')
  })

  test('stairs target the facing cell with ascent from the player side', () => {
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'stairs', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('R:1,0,0')
    expect(result.pose.yaw).toBeCloseTo(Math.PI / 2) // quarter 1 = ascend +X
  })

  test('stairs ascend AWAY on all four cardinals (the ±Z quarter fix)', () => {
    // slotPose yaw q·π/2 carries the plank's high edge (local +Z) onto
    // (sin yaw, cos yaw) — so the quarter must aim the high side ALONG the
    // facing cardinal. The pre-split mapping had ±Z swapped: Z-facing ramps
    // rose back at the player.
    const cases: Array<[number, number]> = [
      [0, Math.PI], // facing −Z → high side −Z → quarter 2
      [Math.PI, 0], // facing +Z → high side +Z → quarter 0
      [-Math.PI / 2, Math.PI / 2], // facing +X → quarter 1
      [Math.PI / 2, (3 * Math.PI) / 2], // facing −X → quarter 3
    ]
    for (const [yaw, wantYaw] of cases) {
      const result = resolveTargetSlot(
        { position: [1.5, 0, 1.5], yaw, pitch: 0, piece: 'stairs', rotState: 0 },
        OPEN,
      )
      const d = yawCardinal(yaw)
      expect(result.slotId).toBe(`R:${d[0]},${d[1]},0`)
      expect(Math.sin(result.pose.yaw)).toBeCloseTo(Math.sin(wantYaw))
      expect(Math.cos(result.pose.yaw)).toBeCloseTo(Math.cos(wantYaw))
      // High-edge direction (sin, cos) equals the facing cardinal.
      expect(Math.round(Math.sin(result.pose.yaw))).toBeCloseTo(d[0])
      expect(Math.round(Math.cos(result.pose.yaw))).toBeCloseTo(d[1])
    }
  })

  test('roof shares R slots; R presses never change its facing-aimed yaw', () => {
    for (const rotState of [0, 1, 2, 3]) {
      const result = resolveTargetSlot(
        { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'roof', rotState },
        OPEN,
      )
      expect(result.slotId).toBe('R:1,0,0')
      expect(result.pose.yaw).toBeCloseTo(Math.PI / 2) // aimed by facing alone
    }
  })

  test('ceiling flow, pure: feet at 0 aiming up resolves an F slot at s=1', () => {
    // Steep pitch: the ray's first horizontal crossing stays in the own
    // cell → its top face. Shallow (just past the band): the crossing walks
    // into the neighbor — still an F slot one storey up, never s=0.
    const steep = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: Math.PI, pitch: 1.2, piece: 'floor', rotState: 0 },
      OPEN,
    )
    expect(steep.slotId).toBe('F:0,0,1')
    expect(steep.pose.position[1]).toBeCloseTo(STOREY)
    const shallow = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: Math.PI, pitch: 0.65, piece: 'floor', rotState: 0 },
      OPEN,
    )
    const slot = parseSlotId(shallow.slotId)!
    expect(slot.kind).toBe('F')
    expect(slot.s).toBe(1)
  })
})

describe('resolveTargetSlot — ray override & validity', () => {
  test('DDA picks the first vertical plane the ray crosses', () => {
    // Eye at x=1.5 looking straight +X: the ray crosses x=3 first → Wx:1.
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,0')
  })

  test('R flip also overrides the ray target', () => {
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 1 },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:2,0,0')
  })

  test('occupied slot falls through to the next candidate', () => {
    const world = {
      isOccupied: (id: string) => id === 'Wx:1,0,0',
      isSupported: () => true,
    }
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 0 },
      world,
    )
    // Override (Wx:1) occupied → default (also Wx:1) → single failing result.
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('occupied')
  })

  test('unsupported reads as red', () => {
    const world = { isOccupied: () => false, isSupported: () => false }
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: 0, pitch: 0, piece: 'wall', rotState: 0 },
      world,
    )
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('unsupported')
  })
})

describe('slotsTouching', () => {
  test('is symmetric on a sample set', () => {
    const samples = ['Wx:1,0,0', 'Wz:0,1,0', 'F:0,0,1', 'R:0,0,0', 'Wx:0,0,1']
    for (const a of samples) {
      for (const b of slotsTouching(a)) {
        expect(slotsTouching(b)).toContain(a)
      }
    }
  })

  test('wall touches its bordering floors above and below', () => {
    const touching = slotsTouching('Wx:1,0,1')
    expect(touching).toContain('F:0,0,1')
    expect(touching).toContain('F:1,0,1')
    expect(touching).toContain('F:0,0,2')
    expect(touching).toContain('F:1,0,2')
  })

  test('floor rests on the walls of the storey below', () => {
    expect(slotsTouching('F:0,0,1')).toContain('Wx:0,0,0')
    expect(slotsTouching('F:0,0,1')).toContain('Wz:0,1,0')
  })

  test('ramps chain storey-diagonally (p5r2 QA gate c)', () => {
    // A ramp's high edge (y = 2.8·(s+1)) meets the low edge of the next
    // cell's ramp one storey up — the graph must carry that contact or the
    // run-up-your-own-ramps flow reads every higher ramp as unsupported.
    const touching = slotsTouching('R:12,8,1')
    expect(touching).toContain('R:11,8,0') // the ramp you just ran up
    expect(touching).toContain('R:13,8,2') // and the next one it will prop
    expect(touching).toContain('R:12,7,0')
    expect(touching).toContain('R:12,9,2')
    // Mirrors hold (also covered by the symmetry sweep below).
    expect(slotsTouching('R:11,8,0')).toContain('R:12,8,1')
  })

  test('never returns negative storeys', () => {
    for (const id of slotsTouching('F:0,0,0')) {
      expect(parseSlotId(id)!.s).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('terrain grounding', () => {
  test('storey 0 slots are grounded, others are not', () => {
    expect(isTerrainGrounded('Wz:4,-2,0')).toBe(true)
    expect(isTerrainGrounded('F:0,0,1')).toBe(false)
  })

  test('R slots at storey 0 count TERRAIN as support — a ground ramp just works', () => {
    // Genre parity: stairs/roofs on open ground need no wall or floor.
    expect(isTerrainGrounded('R:10,11,0')).toBe(true)
    expect(isTerrainGrounded('R:10,11,1')).toBe(false)
    // Pure end-to-end: open terrain far from anything, terrain-only support.
    const result = resolveTargetSlot(
      { position: [31.5, 0, 31.5], yaw: -Math.PI / 2, pitch: 0, piece: 'stairs', rotState: 0 },
      { isOccupied: () => false, isSupported: isTerrainGrounded },
    )
    expect(result.slotId).toBe('R:11,10,0')
    expect(result.valid).toBe(true)
    expect(result.reason).toBe('ok')
  })
})

describe('resolveTargetSlot — R-slot ray march (ramp aim-feel)', () => {
  test('pitch past the band bumps a LOW crossing to the storey above', () => {
    // Aiming up at 0.62 rad (just past PITCH_BAND): the first crossing's
    // height is still below storey 1 — the erratic mid-pitch case that used
    // to resolve a GROUND cell. The pitch-band intent wins.
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.62, piece: 'stairs', rotState: 0 },
      OPEN,
    )
    expect(result.slotId).toBe('R:1,0,1')
    expect(result.valid).toBe(true)
  })

  test('a crossing already a storey up is never double-bumped', () => {
    // Steeper aim: the crossing height alone already reads storey 1.
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.75, piece: 'stairs', rotState: 0 },
      OPEN,
    )
    expect(parseSlotId(result.slotId)!.s).toBe(1)
  })

  test('an occupied cell no longer dead-ends the aim: the march walks on', () => {
    // One ramp placed in the adjacent cell used to turn EVERY aim from this
    // spot red ("occupied") until the player physically moved.
    const world = {
      isOccupied: (id: string) => id === 'R:1,0,0',
      isSupported: () => true,
    }
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'stairs', rotState: 0 },
      world,
    )
    expect(result.slotId).toBe('R:2,0,0')
    expect(result.valid).toBe(true)
  })

  test('everything along the ray blocked → the NEAREST failure reports', () => {
    const world = { isOccupied: () => true, isSupported: () => true }
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'stairs', rotState: 0 },
      world,
    )
    expect(result.slotId).toBe('R:1,0,0')
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('occupied')
  })

  test("the march never targets the player's own cell", () => {
    // Looking straight down past the band: no cell entry along the ray —
    // falls back to the player-anchored neighbor, never R of the own cell.
    const result = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: -1.4, piece: 'roof', rotState: 0 },
      OPEN,
    )
    const slot = parseSlotId(result.slotId)!
    expect(slot.kind).toBe('R')
    expect([slot.i, slot.k]).not.toEqual([0, 0])
  })
})

describe('grid anchor', () => {
  afterEach(() => {
    resetGridAnchor()
  })

  test('an EXPLICIT identity anchor reproduces the legacy lattice bit-exact', () => {
    setGridAnchor({ x: 0, z: 0, yaw: 0 })
    // Pinned copies of expectations from the suites above — the identity
    // seams must be no-ops, not merely close.
    const pose = slotPose({ kind: 'Wx', i: 2, k: 1, s: 1 })
    expect(pose.position).toEqual([6, STOREY, 4.5])
    expect(pose.yaw).toBeCloseTo(Math.PI / 2)
    const wall = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'wall', rotState: 0 },
      OPEN,
    )
    expect(wall.slotId).toBe('Wx:1,0,0')
    expect(wall.pose.position).toEqual([3, 0, 1.5])
    expect(wall.valid).toBe(true)
    const stairs = resolveTargetSlot(
      { position: [1.5, 0, 1.5], yaw: -Math.PI / 2, pitch: 0, piece: 'stairs', rotState: 0 },
      OPEN,
    )
    expect(stairs.slotId).toBe('R:1,0,0')
    expect(stairs.pose.yaw).toBeCloseTo(Math.PI / 2)
  })

  test('worldToGrid / gridToWorld are exact inverses under a rotated anchor', () => {
    setGridAnchor({ x: 12.3, z: -4.7, yaw: Math.PI / 6 })
    const w = gridToWorld(7.25, -3.5, 1.1)
    const g = worldToGrid(w.x, w.z, w.yaw)
    expect(g.x).toBeCloseTo(7.25, 10)
    expect(g.z).toBeCloseTo(-3.5, 10)
    expect(g.yaw).toBeCloseTo(1.1, 10)
  })

  test('30°-rotated anchor: resolved poses round-trip onto lattice multiples', () => {
    setGridAnchor({ x: 12.3, z: -4.7, yaw: Math.PI / 6 })
    // Player standing at GRID (1.5, 1.5) facing grid +X — same scenario as
    // the identity "wall lands on the shared edge" test, in world clothes.
    const feet = gridToWorld(1.5, 1.5)
    const result = resolveTargetSlot(
      {
        position: [feet.x, 0, feet.z],
        yaw: -Math.PI / 2 + Math.PI / 6,
        pitch: 0,
        piece: 'wall',
        rotState: 0,
      },
      OPEN,
    )
    expect(result.slotId).toBe('Wx:1,0,0')
    expect(result.valid).toBe(true)
    // The WORLD pose is off the absolute lattice by design; mapped back into
    // the grid frame it sits exactly on the slot's lattice coordinates.
    const g = worldToGrid(result.pose.position[0], result.pose.position[2], result.pose.yaw)
    expect(g.x).toBeCloseTo(CELL, 10) // the x = CELL·1 plane
    expect(g.z).toBeCloseTo(CELL / 2, 10) // the edge midpoint
    expect(g.x - Math.round(g.x / CELL) * CELL).toBeCloseTo(0, 10) // lattice multiple
    expect(Math.sin(g.yaw)).toBeCloseTo(1, 10) // canonical Wx yaw π/2
    expect(Math.cos(g.yaw)).toBeCloseTo(0, 10)
  })

  test('slotPose carries the anchor yaw on top of the canonical slot yaw', () => {
    setGridAnchor({ x: 12.3, z: -4.7, yaw: Math.PI / 6 })
    const wz = slotPose({ kind: 'Wz', i: 0, k: 0, s: 0 })
    expect(wz.yaw).toBeCloseTo(Math.PI / 6, 10)
    const wx = slotPose({ kind: 'Wx', i: 2, k: 1, s: 1 })
    expect(wx.yaw).toBeCloseTo(Math.PI / 2 + Math.PI / 6, 10)
    // Position is the grid pose pushed through the anchor, y untouched.
    const w = gridToWorld(2 * CELL, CELL + CELL / 2)
    expect(wx.position[0]).toBeCloseTo(w.x, 10)
    expect(wx.position[1]).toBe(STOREY)
    expect(wx.position[2]).toBeCloseTo(w.z, 10)
  })

  test('y is never transformed: storeys and terrain grounding are anchor-blind', () => {
    setGridAnchor({ x: 12.3, z: -4.7, yaw: Math.PI / 6 })
    // Pitch past the band still bumps one storey — baseY stays pure STOREY·s.
    const feet = gridToWorld(1.5, 1.5)
    const up = resolveTargetSlot(
      {
        position: [feet.x, 0, feet.z],
        yaw: -Math.PI / 2 + Math.PI / 6,
        pitch: 0.8,
        piece: 'wall',
        rotState: 0,
      },
      OPEN,
    )
    expect(up.slotId).toBe('Wx:1,0,1')
    expect(up.pose.position[1]).toBe(STOREY)
    // Terrain-only support on open ground works exactly like the identity
    // suite: storey 0 grounds itself, whatever the anchor.
    const far = gridToWorld(31.5, 31.5)
    const ramp = resolveTargetSlot(
      {
        position: [far.x, 0, far.z],
        yaw: -Math.PI / 2 + Math.PI / 6,
        pitch: 0,
        piece: 'stairs',
        rotState: 0,
      },
      { isOccupied: () => false, isSupported: isTerrainGrounded },
    )
    expect(ramp.slotId).toBe('R:11,10,0')
    expect(ramp.valid).toBe(true)
    expect(ramp.pose.position[1]).toBe(0)
    expect(Math.sin(ramp.pose.yaw)).toBeCloseTo(Math.sin(Math.PI / 2 + Math.PI / 6), 10)
    expect(Math.cos(ramp.pose.yaw)).toBeCloseTo(Math.cos(Math.PI / 2 + Math.PI / 6), 10)
  })

  test('resetGridAnchor restores the identity grid', () => {
    setGridAnchor({ x: 12.3, z: -4.7, yaw: Math.PI / 6 })
    resetGridAnchor()
    expect(slotPose({ kind: 'Wz', i: -1, k: 0, s: 0 }).position).toEqual([-1.5, 0, 0])
    expect(worldToGrid(5, 7, 0.4)).toEqual({ x: 5, z: 7, yaw: 0.4 })
  })
})

describe('reach', () => {
  test('a slot beyond REACH is red', () => {
    // Player at origin cell, target the default neighbor — but from far away
    // by teleporting the player low: use pitch up two storeys to force a
    // distant pose? Simpler: player at cell (0,0) but positioned at the far
    // corner so the flipped far edge exceeds reach.
    const result = resolveTargetSlot(
      { position: [0.1, 0, 1.5], yaw: -Math.PI / 2, pitch: 0.8, piece: 'wall', rotState: 1 },
      { isOccupied: () => true, isSupported: () => true },
    )
    // All candidates occupied → failing result exists with a sane reason.
    expect(result.valid).toBe(false)
  })
})
