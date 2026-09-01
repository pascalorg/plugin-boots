import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Box3, BoxGeometry, Matrix4, Mesh, Vector3 } from 'three'
import { resetSnapVoiceGate } from './audio'
import { resetCraters } from './craters'
import { clearDebris } from './debris'
import { clearDust } from './dust'
import { clearGlassShards } from './glass'
import { clearShellDebris } from './shell-debris'
import { resetSettleDrain, resetStructure } from './structure'
import {
  collapseWholeTarget,
  damageExplosion,
  damageSegment,
  damageTarget,
  prevoxelizeTick,
  resetDestruction,
  restoreOperableTarget,
  setPrevoxelizeClock,
  setShellFlag,
  useDestruction,
  type VoxelTarget,
} from './destruction'
import { fire } from './shooting'
import { playerRig } from './player'
import { setDamageSync, sharedDamageDebug, damageSyncActive } from './shared-damage'
import { createSharedWorld, type SharedDelta } from './shared-world'
import { bvhFor, type ColliderEntry, type GameWorld } from './world'
import { WEAPONS } from './weapons'

/**
 * SINGLE PLAYER MUST NOT MOVE.
 *
 * The damage lane now has publish calls threaded through the hottest code in
 * the game — every carve, every snapped stick, every collapse. The promise
 * made when that landed was that a solo session behaves exactly as it did
 * before: same voxels dead, same order in the render queue, same sheet
 * bookkeeping, same segment hit points, no allocation.
 *
 * "Exactly" is not a figure of speech here, so this file proves it by running
 * the same scripted demolition twice — once with sync off, once with sync on —
 * against a seeded Math.random, and comparing a full state fingerprint
 * character for character. The carve path draws 4-6 rim nibbles at random
 * offsets, jitters every settle timer and scatters debris, so the seed is what
 * makes the comparison meaningful: with it, any divergence at all in what the
 * publish calls consumed from the random stream shows up as a different hole.
 *
 * The fingerprint is the full alive bitmap (not a hash — a collision would
 * quietly pass), plus removedQueue order, revision counters, per-segment hp
 * and per-sheet hit/torn counts.
 */

// ── a deterministic world ────────────────────────────────────────────────────

function boxCollider(
  nodeId: string,
  nodeType: string,
  size: [number, number, number],
  center: [number, number, number],
): ColliderEntry {
  const mesh = new Mesh(new BoxGeometry(size[0], size[1], size[2]))
  mesh.position.set(center[0], center[1], center[2])
  mesh.updateMatrixWorld(true)
  mesh.geometry.computeBoundingBox()
  const worldBox = mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
  return {
    mesh,
    bvh: bvhFor(mesh),
    inverse: new Matrix4().copy(mesh.matrixWorld).invert(),
    worldBox,
    root: mesh,
    nodeId,
    nodeType,
  }
}

function makeWorld(): GameWorld {
  const wallA = boxCollider('wall-1', 'wall', [2, 2.7, 0.12], [0, 1.35, 0])
  const wallB = boxCollider('wall-2', 'wall', [3, 2.7, 0.12], [5, 1.35, 0])
  const crate = boxCollider('crate-1', 'item', [1.2, 0.3, 1.2], [10, 1.35, 0])
  const door = boxCollider('door-1', 'door', [0.9, 2.1, 0.1], [2.5, 1.05, 3])
  const colliders = [wallA, wallB, crate, door]
  const buildingAabb = new Box3()
  for (const c of colliders) buildingAabb.union(c.worldBox)
  const wallEntry = (c: ColliderEntry, start: [number, number], end: [number, number]) => ({
    node: { id: c.nodeId, start, end, height: 2.7, thickness: 0.12 },
    root: c.root,
    meshes: [c.mesh],
  })
  return {
    colliders,
    walls: new Map([
      ['wall-1', wallEntry(wallA, [-1, 0], [1, 0])],
      ['wall-2', wallEntry(wallB, [3.5, 0], [6.5, 0])],
    ]),
    glass: [],
    doors: [],
    overlayRoots: [],
    buildingAabb,
    spawn: new Vector3(6, 0, 6),
    spawnYaw: 0,
    levelId: null,
  }
}

// ── a seeded random stream ───────────────────────────────────────────────────

const realRandom = Math.random
let randomCalls = 0

/** mulberry32 — small, fast, and identical across both runs. */
function seedRandom(seed: number): void {
  let a = seed >>> 0
  randomCalls = 0
  Math.random = () => {
    randomCalls++
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * EMPTY THE PARTICLE RINGS FIRST.
 *
 * Dust, debris and shell fragments live in fixed-size pools that only recycle
 * on an update tick, and nothing here ticks them. A COLD pool hands out every
 * slot it is asked for; a full one refuses some — and refusing a particle means
 * skipping the Math.random calls that would have jittered it. So two runs whose
 * pools start at different occupancies draw a different COUNT from the stream,
 * every later carve lands on a different part of the seeded sequence, and the
 * rubble differs for a reason that has nothing to do with anything under test.
 *
 * This used to warm the pools UP instead, looping until two consecutive
 * demolitions drew the same count, on the theory that "full" is a fixed point.
 * It is not a state — it is a coincidence of two counts matching, and the loop
 * accepted the first coincidence it saw. With `bun test --randomize` the pools
 * arrive carrying whatever an earlier test file left in them, the fixed point is
 * reached at a different occupancy, and solo-vs-solo diverged inside a single
 * test (seed 2175878450: alive 432 vs 325, sheet 0 at 25 hits vs 144 and torn).
 *
 * EMPTY is a state. Every pool has a clear, so every measured run starts from
 * the same one and the counts follow.
 */
function coldPools(): void {
  resetDestruction()
  resetStructure()
  resetSettleDrain()
  resetCraters()
  clearDebris()
  clearDust()
  clearShellDebris()
  clearGlassShards()
  resetSnapVoiceGate()
}

// ── the fingerprint ──────────────────────────────────────────────────────────

function fingerprint(): string {
  const targets = useDestruction.getState().targets
  const lines: string[] = []
  for (const nodeId of [...targets.keys()].sort()) {
    const t = targets.get(nodeId) as VoxelTarget
    lines.push(
      [
        `node ${nodeId}`,
        `kind ${t.kind}`,
        `dormant ${t.dormant === true ? 1 : 0}`,
        `walkOnly ${t.walkOnly === true ? 1 : 0}`,
        `count ${t.grid.count}`,
        `alive ${t.grid.aliveCount}`,
        // The whole bitmap, verbatim. This is the assertion that matters.
        `bitmap ${t.grid.alive.join('')}`,
        // Order, not just membership: the renderer drains this queue in
        // order, and a reordering would be a real (if invisible) change.
        `queue ${t.removedQueue.join(',')}`,
        `revision ${t.revision}`,
        `segments ${t.segments.map((s) => `${s.id}:${s.hp}:${s.broken ? 1 : 0}`).join('|')}`,
        `sheets ${t.sheets.map((s) => `${s.id}:${s.hits}:${s.torn}:${s.flownOff ? 1 : 0}`).join('|')}`,
      ].join('\n'),
    )
  }
  return lines.join('\n')
}

// ── the script ───────────────────────────────────────────────────────────────

/**
 * Every publish site in destruction.ts, driven through its real caller:
 * carves (damageTargetOne + the fan), a stud snap (damageSegment), a blast
 * (explosionRing + explosionSegments + the 48-stick cap), a whole-target
 * collapse (collapseWholeTarget + the kill bit), a sealed-door handback
 * (restoreOperableTarget + the epoch), and one full trigger pull through
 * shooting.ts's fire() so its batch boundary is exercised too.
 */
function demolish(world: GameWorld): void {
  // A FROZEN clock: the time budget never expires, so the prevoxelize queue
  // drains in one tick every time. With the real clock the split between ticks
  // rides on machine load, and the run stops being reproducible.
  setPrevoxelizeClock(() => 0)
  let done = false
  for (let i = 0; i < 80 && !done; i++) done = prevoxelizeTick(world, 8)

  damageTarget(world, 'wall-1', new Vector3(0, 1.4, 0.06), 0.22, new Vector3(0, 0, -1))
  damageTarget(world, 'wall-1', new Vector3(0.35, 1.05, 0.06), 0.3, new Vector3(0, 0, -1))
  damageTarget(world, 'wall-1', new Vector3(-0.4, 1.9, 0.06), 0.26, new Vector3(0, 0, -1))
  damageTarget(world, 'wall-2', new Vector3(5, 1.6, 0.06), 0.25, new Vector3(0, 0, -1))

  const wall = useDestruction.getState().targets.get('wall-1')
  const seg = wall?.segments.find((s) => !s.broken)
  if (seg) damageSegment(world, 'wall-1', seg.id, 9999, new Vector3(0, 1.4, 0))

  damageExplosion(world, new Vector3(5, 1.2, 0), 1.6, { immediate: true })

  collapseWholeTarget('crate-1')

  // The one non-monotone operation: a sealed door handed back to the host.
  damageTarget(world, 'door-1', new Vector3(2.5, 1.05, 3), 0.2, new Vector3(0, 0, -1))
  restoreOperableTarget('door-1')

  // And a real trigger pull, standing off z+ looking down −Z into wall-1.
  playerRig.position.set(0, 1.35, 5)
  playerRig.yaw = 0
  playerRig.pitch = 0
  playerRig.speed = 0
  playerRig.grounded = true
  fire(world, WEAPONS.rifle)
}

function runSolo(seed: number): string {
  coldPools()
  seedRandom(seed)
  const world = makeWorld()
  demolish(world)
  return fingerprint()
}

function runSynced(seed: number, sink: SharedDelta[]): string {
  coldPools()
  seedRandom(seed)
  const shared = createSharedWorld('me')
  setDamageSync({ world: shared, publish: (delta) => sink.push(delta) })
  try {
    const world = makeWorld()
    demolish(world)
    return fingerprint()
  } finally {
    setDamageSync(null)
  }
}

// ── the suite ────────────────────────────────────────────────────────────────

// Pin the voxel-only lane the way destruction.test.ts does, so the comparison
// is not at the mercy of the conforming-shell tier's own scheduling.
beforeEach(() => {
  setShellFlag('wall', false)
  setShellFlag('roof', false)
  setShellFlag('slab', false)
})
afterEach(() => {
  setPrevoxelizeClock(null)
  Math.random = realRandom
  setDamageSync(null)
  resetDestruction()
  resetCraters()
  clearDebris()
  playerRig.position.set(0, 0, 0)
})
afterAll(() => {
  setShellFlag('wall', true)
  setShellFlag('roof', true)
  setShellFlag('slab', true)
  Math.random = realRandom
})

describe('single player is byte-identical with sync off', () => {
  test('the harness itself is deterministic (same seed, same rubble)', () => {
    // If this fails, nothing below means anything: the comparison would be
    // measuring the random stream, not the publish calls.
    const a = runSolo(0x5eed)
    const drawsA = randomCalls
    const b = runSolo(0x5eed)
    expect(b).toBe(a)
    // The DRAW COUNT too, asserted separately: a divergence here says the two
    // runs consumed different amounts of the stream (a pool refusing a particle,
    // a leftover settle timer), which is a different diagnosis from the same
    // stream producing different rubble. The bitmap diff alone cannot tell them
    // apart, and it was the pool-occupancy kind that made this suite flaky under
    // --randomize.
    expect(randomCalls).toBe(drawsA)
    expect(a.length).toBeGreaterThan(2000)
  })

  test('sync ON leaves the local scene character-for-character identical', () => {
    const solo = runSolo(0x5eed)

    const sink: SharedDelta[] = []
    const synced = runSynced(0x5eed, sink)

    // Not toEqual on objects — the literal fingerprint string, so a diff is
    // readable and a bitmap collision is impossible.
    expect(synced).toBe(solo)
    // …and the run really did publish, or the assertion above is vacuous.
    expect(sink.length).toBeGreaterThan(0)
    const cellNodes = sink.flatMap((d) => d.nodes.filter((n) => n.removed.length > 0))
    expect(cellNodes.length).toBeGreaterThan(0)
    // All four lanes of the damage model went out over the course of the run.
    expect(sink.some((d) => d.nodes.some((n) => n.killed))).toBe(true)
    expect(sink.some((d) => d.nodes.some((n) => n.segments.length > 0))).toBe(true)
    expect(sink.some((d) => d.nodes.some((n) => n.reset && n.epoch > 0))).toBe(true)
    // Deltas, not restatements: no cell is ever announced twice.
    const seen = new Set<string>()
    for (const delta of sink) {
      for (const node of delta.nodes) {
        for (const cell of node.removed) {
          const key = `${node.nodeId}/${cell}`
          expect(seen.has(key)).toBe(false)
          seen.add(key)
        }
      }
    }
  })

  test('a different seed really does produce different rubble (the test can fail)', () => {
    const a = runSolo(0x5eed)
    const b = runSolo(0xc0ffee)
    expect(b).not.toBe(a)
  })
})

describe('with sync off the bridge is inert', () => {
  test('no sync installed after a full demolition: nothing pending, nothing active', () => {
    coldPools()
    seedRandom(0x5eed)
    demolish(makeWorld())
    expect(damageSyncActive()).toBe(false)
    const dbg = sharedDamageDebug()
    expect(dbg.active).toBe(false)
    expect(dbg.batchDepth).toBe(0)
    expect(dbg.applying).toBe(false)
    // The pending map is allocated lazily on the first publish. Zero here
    // means the solo path never even created the container.
    expect(dbg.pendingNodes).toBe(0)
    expect(dbg.pendingCells).toBe(0)
    expect(dbg.pendingSegments).toBe(0)
  })

  test('every publish entry point guards on the null sync BEFORE it touches anything', () => {
    // A runtime test can only sample the paths it happens to walk. This one
    // reads the source and holds the shape of the guard, so a future publish
    // helper cannot be added that reads a grid, sorts, or allocates first.
    const src = readFileSync(new URL('./shared-damage.ts', import.meta.url), 'utf8')
    const entries = [...src.matchAll(/^export function (publish\w+)\([\s\S]*?\n\}/gm)]
    expect(entries.length).toBeGreaterThanOrEqual(5)
    for (const match of entries) {
      const [body, name] = match
      // Skip the signature — which may wrap over several parameter lines —
      // and read the first real statement of the body.
      const open = body.indexOf('{')
      const firstStatement = body
        .slice(open + 1)
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith('//') && !line.startsWith('*'))
      expect(`${name}: ${firstStatement}`).toBe(
        `${name}: if (sync === null || remoteDepth > 0) return`,
      )
    }
  })

  test('batch boundaries cost nothing when there is no sync', () => {
    const src = readFileSync(new URL('./shared-damage.ts', import.meta.url), 'utf8')
    for (const name of ['beginDamageBatch', 'endDamageBatch']) {
      const at = src.indexOf(`export function ${name}(`)
      expect(at).toBeGreaterThan(0)
      const head = src.slice(at, src.indexOf('\n}', at))
      expect(head).toContain('if (sync === null) return')
    }
  })

  test('the hot publish sites in destruction.ts pass scratch arrays, not fresh ones', () => {
    // Cell lists are gathered into module-scope arrays that keep their
    // capacity between calls: a collapse loop must not allocate per frame in
    // single player. Named `_`-prefixed and reset with `.length = 0`.
    const src = readFileSync(new URL('./destruction.ts', import.meta.url), 'utf8')
    for (const scratch of ['_collapsedCells', '_flownCells', '_avalancheCells']) {
      expect(src).toContain(`const ${scratch}: number[] = []`)
      expect(src).toContain(`${scratch}.length = 0`)
    }
    // No closure-allocating wrapper on the runtime damage paths: batches are
    // opened and closed by hand around a try/finally. (Word boundary — the
    // begin/end pair spells `inDamageBatch(` as a substring.)
    expect(/[^A-Za-z]inDamageBatch\(/.test(src)).toBe(false)
  })
})
