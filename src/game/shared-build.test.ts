import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { useScene } from '@pascal-app/core'
import { Mesh, PlaneGeometry, Vector3 } from 'three'
import { useBoots } from '../store'
import { useDestruction, type VoxelTarget } from './destruction'
import {
  gridTerrainY,
  parseSlotId,
  resetGridAnchor,
  resetStoreyLadder,
  setGridAnchor,
  setStoreyLadder,
  slotPose,
} from './grid'
import { type CatalogEntry, OPENING_ENTRIES, placeableCatalog } from './inventory'
import { applyItems, discardItems, placedItemCount } from './item-keep'
import { useItems } from './item-place'
import { discardPlaced, keepPlaced } from './keep'
import {
  coatRadiusFor,
  convertDecalsForNode,
  foldRemoteStrokes,
  getOwnPaintedByNode,
  getPaintedByNode,
  PAINT_PALETTE,
  paintColorOf,
  paintStrengthOf,
  paintValue,
  remoteCoatedCells,
  resetPaint,
  resetPaintDecals,
  spawnPaintDecal,
} from './paint'
import { applyPaint, capturePaint, usePaintKeep } from './paint-keep'
import { onPieceRemoved, pieceAt, registerPlacement, resetPieceSlots } from './piece-slots'
import { armSceneWriteSentinel } from './session'
import {
  attachBuildSync,
  buildSyncOn,
  detachBuildSync,
  forgetGridStamp,
  forgetSharedPieces,
  isForeignPiece,
  isForeignPlacement,
  pieceRecordOf,
  publishAperture,
  publishGridStamp,
  publishItem,
  publishStroke,
  receiveBuildDelta,
  reconcileSharedPieces,
  remintSharedRecords,
  resetSharedBuild,
  setBuildAppliers,
  sharedBuildDebug,
} from './shared-build'
import { gridStamp } from './shared-derive'
import {
  addLocalAperture,
  addLocalItem,
  addLocalPiece,
  addLocalStroke,
  createSharedWorld,
  emptyDelta,
  liveRecords,
  localWork,
  type PieceRec,
  quantYaw,
  rekeySharedWorld,
  type SharedDelta,
  type SharedWorld,
  takePending,
} from './shared-world'
import type { GameWorld } from './world'

/**
 * The BUILD LANE against the convergent model: what this peer publishes, what
 * a stranger's frame is allowed to do to this screen, and — the invariant that
 * matters most — what Save may write afterwards.
 *
 * Every test drives the lane through `attachBuildSync` + `receiveBuildDelta`
 * and reads the outgoing frames from a captured sink. There is no transport
 * here on purpose: those two functions ARE the injection point, and this file
 * imports nothing from net.ts or the copresence layer.
 */

const LADDER = [0, 2.8, 5.6, 8.4]
const WALL_SLOT = 'Wx:0,0,0'
const OTHER_SLOT = 'Wz:1,1,0'

/** The editor package is a zustand-shaped stub under bun test, so the bundled
 * CATALOG_ITEMS list is empty (inventory.tsx's BUNDLED guard). Placements
 * therefore run against an explicit catalog, filtered by the real
 * `placeableCatalog` so the lookup the applier does is the production one. */
const catalogEntry = (id: string): CatalogEntry => ({
  id,
  category: 'furniture',
  name: id,
  thumbnail: `https://cdn.test/${id}/thumbnail.png`,
  src: `https://cdn.test/${id}/model.glb`,
})
const CATALOG = placeableCatalog([catalogEntry('couch'), catalogEntry('fridge')])
const ITEM = CATALOG[0]!

type SceneStore = {
  getState: () => {
    setScene: (nodes: Record<string, unknown>, roots: string[]) => void
    setReadOnly?: (readOnly: boolean) => void
    nodes: Record<string, unknown>
  }
}
const scene = useScene as unknown as SceneStore

/** The session under test: our world, a peer's world to mint from, the wire. */
type Harness = {
  mine: SharedWorld
  theirs: SharedWorld
  sent: SharedDelta[]
  notices: string[]
  stamp: number
}

/** Attach the lane exactly the way builder.tsx does — grid first (the stamp
 * is published the moment the anchor and ladder are installed), then the
 * sink and the notice channel a test can read. */
function boot(): Harness {
  setGridAnchor({ x: 0, z: 0, yaw: 0 })
  setStoreyLadder(LADDER)
  const mine = createSharedWorld('me')
  const theirs = createSharedWorld('them')
  const sent: SharedDelta[] = []
  const notices: string[] = []
  attachBuildSync(mine, {
    sink: (delta) => sent.push(delta),
    notice: (text) => notices.push(text),
  })
  const stamp = publishGridStamp(0, 0, 0, [gridTerrainY(), ...LADDER])
  return { mine, theirs, sent, notices, stamp }
}

/** One frame from a peer, stamped with a grid we agree on unless told not to. */
function frame(h: Harness, from: string, fill: (delta: SharedDelta) => void): SharedDelta {
  const delta = emptyDelta(from)
  delta.gridStamp = h.stamp
  delta.lamport = h.theirs.clock
  fill(delta)
  return delta
}

/** A peer's wall record, minted in THEIR world so the id and lamport are the
 * real thing (`them#3`), which is what the authorship gate checks. */
function theirWall(h: Harness, slot: string, opts?: { yaw?: number; mask?: number }): PieceRec {
  const rec = addLocalPiece(h.theirs, {
    kind: 'wall',
    slot,
    mask: opts?.mask ?? 511,
    yaw: opts?.yaw ?? Math.PI / 2,
    height: 2.8,
    corners: null,
  })
  expect(rec).not.toBeNull()
  return rec!
}

/** A wall this player builds, exactly the way builder.tsx builds one: the
 * store append, the slot claim, then the effect that publishes it. */
function myWall(slot: string): number {
  const stored = useBoots.getState().addPlaced({
    piece: 'wall',
    position: [0, 0, 0],
    yaw: Math.PI / 2,
    slotId: slot,
    height: 2.8,
  })
  registerPlacement(slot, stored.id)
  reconcileSharedPieces()
  return stored.id
}

/** A five-cell voxel strip along X at 0.15 m spacing — enough grid for
 * splatCoat to expand a ball against (the paint-decals.test stub). */
function fakeTarget(nodeId: string): VoxelTarget {
  const count = 5
  const centers = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) centers[i * 3] = (i - 2) * 0.15
  return {
    nodeId,
    kind: 'wall',
    dormant: false,
    grid: { count, alive: new Uint8Array(count).fill(1), centers, cellY: 0.15 },
  } as unknown as VoxelTarget
}

/** foldRemoteStrokes only reads `world` to voxelize a node it cannot find;
 * every test pre-seeds the target, so the argument is never touched. */
const NO_WORLD = {} as unknown as GameWorld

/**
 * The appliers item-place.tsx's GameItems and paint.tsx's PaintTool install
 * at mount, mirrored here because neither component can mount headless. Same
 * catalog lookups, same stores, same null-means-refuse contract.
 */
function installAppliers(): void {
  setBuildAppliers({
    spawnItem: (rec) => {
      const entry = CATALOG.find((e) => e.id === rec.catalogId)
      if (!entry) return null
      return useItems.getState().addItem(entry, [rec.x, rec.y, rec.z], rec.yaw).id
    },
    spawnAperture: (rec) => {
      const def = OPENING_ENTRIES.find((e) => e.id === rec.catalogId)
      if (!def) return null
      return useItems
        .getState()
        .addAperture(def, rec.host, rec.u, rec.v, { width: rec.width, height: rec.height }).id
    },
    removePlacement: (id) => useItems.getState().removeItem(id),
    foldStrokes: (strokes) => foldRemoteStrokes(NO_WORLD, strokes),
  })
}

/**
 * EVERY STORE THIS FILE READS IS A MODULE SINGLETON — clear them going IN too.
 *
 * The assertions here are about WHOLE stores (`placed` has length 1,
 * `liveRecords` has length 0), and reconcileSharedPieces walks the entire
 * placed store, so one leftover piece from an earlier test file publishes a
 * record this file never asked for. `--randomize --seed=31337` arrived with
 * exactly one, and "a slotless legacy piece publishes nothing" failed on a
 * stranger's wall. Cleaning up after ourselves cannot fix that; cleaning up
 * before can.
 */
const isolate = () => {
  resetSharedBuild()
  useBoots.getState().resolvePlaced()
  useBoots.getState().setPhase('editor')
  useItems.getState().resolveItems()
  usePaintKeep.getState().clear()
  resetPieceSlots()
  resetPaintDecals()
  resetPaint()
  useDestruction.getState().reset()
  resetGridAnchor()
  resetStoreyLadder()
  scene.getState().setReadOnly?.(false)
  scene.getState().setScene({}, [])
}

beforeEach(isolate)
afterEach(isolate)

// ── The grid frame, in PRODUCTION mount order ───────────────────────────────

/**
 * THE BUG THIS BLOCK EXISTS FOR (production, reported live 2026-09-01: "MASSIVE
 * problem that others couldn't see my constructions / only some destructions").
 *
 * `PlacedPieces` publishes the grid fingerprint from the effect that installs
 * the anchor. `ActiveGame` — its PARENT — is what calls startWorldSync() →
 * attachBuildSync. React runs a child's effects BEFORE its parent's, so the
 * publish always ran against a lane that did not exist yet, and the old
 * `publishGridStamp` answered that by returning 0 and doing nothing at all.
 *
 * It nevertheless worked on every machine it was tested on, because StrictMode
 * double-invokes effects and the second pass found the lane attached — and
 * StrictMode's double-invoke is DEVELOPMENT ONLY. In a production build the
 * stamp stayed 0 for the whole session, and the grid gate reads
 * `delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp`, so BOTH
 * directions failed at once: nobody saw anybody's walls, floors or slopes, while
 * grid-free voxel damage kept landing. Two clients on a dev server could never
 * catch it.
 *
 * So these tests call the seams in the order PRODUCTION calls them — child
 * first, exactly once — and the fix is that the frame is retained rather than
 * published.
 */
describe('the grid frame survives the mount order', () => {
  test('publishing BEFORE the lane attaches still reaches the world (the prod order)', () => {
    setGridAnchor({ x: 0, z: 0, yaw: 0 })
    setStoreyLadder(LADDER)
    // 1. the child effect: no lane yet, and it is never called again.
    const stamp = publishGridStamp(0, 0, 0, LADDER)
    expect(stamp).toBe(gridStamp(0, 0, 0, LADDER))
    expect(stamp).not.toBe(0)

    // 2. the parent effect: the transport arrives.
    const world = createSharedWorld('us')
    attachBuildSync(world)

    // THE ASSERTION THE PRODUCTION BUG WOULD HAVE FAILED.
    expect(world.gridStamp).toBe(stamp)
    expect(sharedBuildDebug().gridStamp).toBe(stamp)
    expect(sharedBuildDebug().gridFrameHeld).toBe(true)

    // …and it is a real grid, so a peer on the same lot is believed.
    const them = createSharedWorld('them')
    const rec = addLocalPiece(them, {
      kind: 'wall',
      slot: OTHER_SLOT,
      mask: 511,
      yaw: 0,
      height: 2.8,
      corners: null,
    })!
    const frame = emptyDelta('them')
    frame.gridStamp = stamp
    frame.pieces.push(rec)
    const fx = receiveBuildDelta(frame, 'them')
    expect(fx.refusedGrid).toBe(false)
    expect(fx.addedPieces).toHaveLength(1)
  })

  test('a stamp published while attached lands immediately, as it always did', () => {
    const world = createSharedWorld('us')
    attachBuildSync(world)
    const stamp = publishGridStamp(3, -4, 0, LADDER)
    expect(world.gridStamp).toBe(stamp)
  })

  test('the transport may detach and re-attach mid-session without losing the lot', () => {
    // The frame belongs to the piece tree, not to the wire: a bus that goes away
    // and comes back (the host re-keys a session and replaces the whole bus) must
    // not leave us unable to name our own lot.
    publishGridStamp(0, 0, 0, LADDER)
    const first = createSharedWorld('us')
    attachBuildSync(first)
    detachBuildSync()
    const second = createSharedWorld('us-renamed')
    attachBuildSync(second)
    expect(second.gridStamp).toBe(gridStamp(0, 0, 0, LADDER))
  })

  test('a session that ends forgets the frame, so the next lot is not adopted', () => {
    publishGridStamp(9, 9, 0, LADDER)
    forgetGridStamp()
    const world = createSharedWorld('us')
    attachBuildSync(world)
    expect(world.gridStamp).toBe(0)
  })
})

// ── Sync off: single-player is not touched ──────────────────────────────────

describe('with sync off the build lane does not exist', () => {
  test('every publish and receive entry point is inert, and the store is byte-identical', () => {
    expect(buildSyncOn()).toBe(false)
    setGridAnchor({ x: 0, z: 0, yaw: 0 })
    setStoreyLadder(LADDER)

    const id = useBoots.getState().addPlaced({
      piece: 'wall',
      position: [1, 0, 2],
      yaw: Math.PI / 2,
      slotId: WALL_SLOT,
      height: 2.8,
    }).id
    const target = fakeTarget('wall-1')
    useDestruction.getState().targets.set('wall-1', target)

    const before = JSON.stringify({
      placed: useBoots.getState().placed,
      items: useItems.getState().items,
      painted: [...getPaintedByNode()].map(([node, cells]) => [node, [...cells]]),
    })

    // Every seam the wiring touches, called exactly as the game calls it.
    // publishGridStamp is the one that ANSWERS with sync off: the frame is
    // retained for a later attach (see its own comment), and computing a
    // fingerprint touches no world and no store — which is what this test is
    // about. That it lands nowhere is asserted below.
    expect(publishGridStamp(0, 0, 0, LADDER)).toBe(gridStamp(0, 0, 0, LADDER))
    expect(sharedBuildDebug().gridStampPublishes).toBe(0)
    reconcileSharedPieces()
    expect(publishItem(id, 'crate-small', [0, 0, 0], 0)).toBeNull()
    expect(publishAperture(id, 'opening-door-hinged', 'wall-1', 1, 1, 0.9, 2)).toBeNull()
    expect(publishStroke('wall-1', 2, 0, 0, 0, 0.25)).toBeNull()

    // And a stranger shouting a full frame at a single-player session: the
    // receive door is shut, so not one record is even merged.
    const loner = createSharedWorld('them')
    const rec = addLocalPiece(loner, {
      kind: 'wall',
      slot: OTHER_SLOT,
      mask: 511,
      yaw: 0,
      height: 2.8,
      corners: null,
    })!
    const hostile = emptyDelta('them')
    hostile.gridStamp = gridStamp(0, 0, 0, LADDER)
    hostile.pieces.push(rec)
    const fx = receiveBuildDelta(hostile, 'them')
    expect(fx.addedPieces).toHaveLength(0)
    expect(fx.dropped).toBe(0) // nothing was even looked at

    const after = JSON.stringify({
      placed: useBoots.getState().placed,
      items: useItems.getState().items,
      painted: [...getPaintedByNode()].map(([node, cells]) => [node, [...cells]]),
    })
    expect(after).toBe(before)
    expect(isForeignPiece(id)).toBe(false)
    expect(isForeignPlacement(id)).toBe(false)
    expect(pieceRecordOf(id)).toBeNull()
    expect(sharedBuildDebug().on).toBe(false)
  })

  test('the paint ledger Save reads is the SAME OBJECT the game writes', () => {
    // Not "an equal map" — the identical object, so single-player walks the
    // pre-sync code path with no copy and no filter in it.
    expect(getOwnPaintedByNode()).toBe(getPaintedByNode())
    const target = fakeTarget('wall-1')
    useDestruction.getState().targets.set('wall-1', target)
    const mesh = new Mesh(new PlaneGeometry(6, 6))
    mesh.updateMatrixWorld(true)
    expect(spawnPaintDecal(mesh, 'wall-1', new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.4, 3)).toBe(
      true,
    )
    convertDecalsForNode('wall-1')
    expect(getPaintedByNode().get('wall-1')!.size).toBeGreaterThan(0)
    expect(getOwnPaintedByNode()).toBe(getPaintedByNode())
    expect(remoteCoatedCells('wall-1').size).toBe(0)
  })

  test('a local piece still reaches Save untouched', () => {
    setGridAnchor({ x: 0, z: 0, yaw: 0 })
    setStoreyLadder(LADDER)
    useBoots.getState().addPlaced({
      piece: 'wall',
      position: [0, 0, 0],
      yaw: Math.PI / 2,
      slotId: WALL_SLOT,
      height: 2.8,
    })
    // Whatever the host registry offers in this environment, the piece was
    // CONSIDERED: kept or skipped, it went through the pass.
    const result = keepPlaced()
    expect(result.kept + result.skipped).toBe(1)
  })
})

// ── Pieces: a stranger's wall becomes a real wall ────────────────────────────

describe('a remote piece materializes from its slot alone', () => {
  test('the pose is derived, the slot is claimed, and it is marked as theirs', () => {
    const h = boot()
    const rec = theirWall(h, WALL_SLOT)
    const fx = receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')

    expect(fx.addedPieces).toHaveLength(1)
    expect(fx.refusedGrid).toBe(false)
    const placed = useBoots.getState().placed
    expect(placed).toHaveLength(1)
    const piece = placed[0]!
    // Not one coordinate travelled: the pose is slotPose of the slot id.
    const pose = slotPose(parseSlotId(WALL_SLOT)!)
    expect(piece.position[0]).toBeCloseTo(pose.position[0], 10)
    expect(piece.position[1]).toBeCloseTo(pose.position[1], 10)
    expect(piece.position[2]).toBeCloseTo(pose.position[2], 10)
    expect(piece.yaw).toBeCloseTo(rec.yaw, 10)
    expect(piece.slotId).toBe(WALL_SLOT)
    expect(piece.height).toBe(2.8)
    // The runtime slot registry is the occupancy authority and it agrees.
    expect(pieceAt(WALL_SLOT)).toBe(piece.id)
    expect(isForeignPiece(piece.id)).toBe(true)
    expect(sharedBuildDebug().pieces.foreign).toBe(1)
    // Nothing of theirs goes back out on the wire.
    expect(h.sent).toHaveLength(0)
  })

  test('re-delivery, a snapshot and a reordered frame all land on one wall', () => {
    const h = boot()
    const rec = theirWall(h, WALL_SLOT)
    const f = frame(h, 'them', (d) => d.pieces.push(rec))
    receiveBuildDelta(f, 'them')
    const first = useBoots.getState().placed[0]!.id
    for (let i = 0; i < 5; i++) receiveBuildDelta(f, 'them')
    const snapshot = frame(h, 'them', (d) => {
      d.kind = 'snapshot'
      d.pieces.push(rec)
    })
    receiveBuildDelta(snapshot, 'them')
    expect(useBoots.getState().placed).toHaveLength(1)
    expect(useBoots.getState().placed[0]!.id).toBe(first) // not respawned
    expect(pieceAt(WALL_SLOT)).toBe(first)
  })

  test('a tombstone from anywhere takes the wall down and frees the slot', () => {
    const h = boot()
    const rec = theirWall(h, WALL_SLOT)
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')
    expect(useBoots.getState().placed).toHaveLength(1)
    receiveBuildDelta(frame(h, 'them', (d) => d.deadPieces.push(rec.id)), 'them')
    expect(useBoots.getState().placed).toHaveLength(0)
    expect(pieceAt(WALL_SLOT)).toBeUndefined()
    expect(sharedBuildDebug().pieces.bound).toBe(0)
  })

  test('a slotless legacy piece publishes nothing but still lives locally', () => {
    const h = boot()
    const stored = useBoots.getState().addPlaced({
      piece: 'wall',
      position: [3, 0, 0],
      yaw: 0,
      height: 2.8,
    })
    reconcileSharedPieces()
    expect(pieceRecordOf(stored.id)).toBeNull()
    expect(liveRecords(h.mine.pieces)).toHaveLength(0)
    expect(useBoots.getState().placed).toHaveLength(1) // it renders and saves
  })
})

// ── Publish: what leaves this client ────────────────────────────────────────

describe('what this player builds goes out once, quantized', () => {
  test('a placement mints one record and one frame', () => {
    const h = boot()
    const id = myWall(WALL_SLOT)
    expect(h.sent).toHaveLength(1)
    const delta = h.sent[0]!
    expect(delta.pieces).toHaveLength(1)
    expect(delta.gridStamp).toBe(h.stamp)
    const rec = delta.pieces[0]!
    expect(rec.slot).toBe(WALL_SLOT)
    expect(rec.kind).toBe('wall')
    // Quantized ON MINT: the local world holds exactly the number the peer
    // will hold, so nothing downstream can drift from the wire.
    expect(rec.yaw).toBe(quantYaw(Math.PI / 2))
    expect(rec.height).toBe(2.8)
    expect(pieceRecordOf(id)).toBe(rec.id)
    expect(isForeignPiece(id)).toBe(false)
    // Re-running the diff publishes nothing new.
    reconcileSharedPieces()
    expect(h.sent).toHaveLength(1)

    // An off-quarter yaw proves the rounding is real and happens at the mint,
    // not at the codec: the record — and so this client's own state — carries
    // the 65536-step value.
    useBoots.getState().addPlaced({
      piece: 'wall',
      position: [3, 0, 0],
      yaw: 1.2345678,
      slotId: OTHER_SLOT,
      height: 2.8,
    })
    reconcileSharedPieces()
    const odd = liveRecords(h.mine.pieces).find((r) => r.slot === OTHER_SLOT)!
    expect(odd.yaw).not.toBe(1.2345678)
    expect(odd.yaw).toBe(quantYaw(1.2345678))
  })

  test('an F-edit replaces the record; undo tombstones it', () => {
    const h = boot()
    const id = myWall(WALL_SLOT)
    const firstRec = pieceRecordOf(id)!

    useBoots.getState().setPlacedMask(id, 447) // pocket the middle cell
    reconcileSharedPieces()
    const second = pieceRecordOf(id)!
    expect(second).not.toBe(firstRec)
    expect(liveRecords(h.mine.pieces)).toHaveLength(1)
    expect(liveRecords(h.mine.pieces)[0]!.mask).toBe(447)
    expect(h.mine.pieces.dead.has(firstRec)).toBe(true)
    const edit = h.sent[1]!
    expect(edit.deadPieces).toContain(firstRec)
    expect(edit.pieces).toHaveLength(1)

    useBoots.getState().removePlaced(id)
    reconcileSharedPieces()
    expect(liveRecords(h.mine.pieces)).toHaveLength(0)
    expect(h.sent[2]!.deadPieces).toContain(second)
    expect(pieceRecordOf(id)).toBeNull()
  })

  test('items, apertures and strokes each publish their own record', () => {
    const h = boot()
    const itemId = publishItem(9001, ITEM.id, [1.234567, 0, -2], Math.PI)
    expect(itemId).not.toBeNull()
    const apId = publishAperture(9002, 'opening-door-hinged', 'wall-1', 1.5, 1, 0.9, 2.1)
    expect(apId).not.toBeNull()
    expect(publishStroke('wall-1', 3, 0.5, 1, 0.5, 0.25)).not.toBeNull()

    const work = localWork(h.mine)
    expect(work.items).toHaveLength(1)
    expect(work.apertures).toHaveLength(1)
    expect(work.strokes).toHaveLength(1)
    expect(work.items[0]!.catalogId).toBe(ITEM.id)
    expect(work.items[0]!.x).toBe(1.235) // quantized on mint
    expect(work.apertures[0]!.host).toBe('wall-1')
    expect(isForeignPlacement(9001)).toBe(false)
    // Publishing the same runtime placement twice is refused, not duplicated.
    expect(publishItem(9001, ITEM.id, [1, 0, 1], 0)).toBeNull()
    expect(localWork(h.mine).items).toHaveLength(1)
  })
})

// ── One slot, two builders ──────────────────────────────────────────────────

describe('two builders claim one slot', () => {
  /**
   * Two OTHER peers claim the same slot; we only watch. Both claims exist
   * before either arrives, which is the case convergence is actually about —
   * a local claim minted after hearing theirs is genuinely later (the lamport
   * says so), and there would be nothing to converge.
   */
  function race(order: 'ab' | 'ba'): string | null {
    const h = boot()
    const alpha = createSharedWorld('alpha')
    const beta = createSharedWorld('beta')
    beta.clock = 500 // beta's claim is later in (lamport, id) order
    const mk = (w: SharedWorld) =>
      addLocalPiece(w, {
        kind: 'wall',
        slot: WALL_SLOT,
        mask: 511,
        yaw: 0,
        height: 2.8,
        corners: null,
      })!
    const a = mk(alpha)
    const b = mk(beta)
    const send = (from: string, rec: PieceRec) => {
      const d = emptyDelta(from)
      d.gridStamp = h.stamp
      d.lamport = rec.lamport
      d.pieces.push(rec)
      receiveBuildDelta(d, from)
    }
    if (order === 'ab') {
      send('alpha', a)
      send('beta', b)
    } else {
      send('beta', b)
      send('alpha', a)
    }
    expect(useBoots.getState().placed).toHaveLength(1)
    return pieceRecordOf(useBoots.getState().placed[0]!.id)
  }

  test('the same record wins whichever order the claims arrive in', () => {
    const ab = race('ab')
    resetSharedBuild()
    useBoots.getState().resolvePlaced()
    resetPieceSlots()
    const ba = race('ba')
    expect(ab).toBe('beta#1') // the later lamport, on both clients
    expect(ba).toBe('beta#1')
  })

  test('the local loser is TOLD, not silently deleted', () => {
    const h = boot()
    // We built here first; their claim was stamped later than ours.
    const id = myWall(WALL_SLOT)
    h.theirs.clock = 500
    const rec = theirWall(h, WALL_SLOT, { yaw: 0 })
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')

    const placed = useBoots.getState().placed
    expect(placed).toHaveLength(1)
    expect(placed[0]!.id).not.toBe(id) // our wall went
    expect(isForeignPiece(placed[0]!.id)).toBe(true) // theirs stands in its place
    expect(pieceAt(WALL_SLOT)).toBe(placed[0]!.id)
    // And the player found out why, in their own words.
    expect(h.notices).toContain('Another builder claimed that wall slot')
  })

  test('losing once is final — the deposed record never comes back', () => {
    const h = boot()
    const id = myWall(WALL_SLOT)
    const mineRec = pieceRecordOf(id)
    h.theirs.clock = 500
    const rec = theirWall(h, WALL_SLOT, { yaw: 0 })
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')
    expect(sharedBuildDebug().pieces.deposed).toBe(1)
    // Their frame replays (a snapshot, a retransmit): our deposed wall must
    // not flicker back into the slot it lost.
    for (let i = 0; i < 3; i++) {
      receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')
      reconcileSharedPieces()
    }
    expect(useBoots.getState().placed).toHaveLength(1)
    expect(pieceRecordOf(useBoots.getState().placed[0]!.id)).toBe(rec.id)
    expect(mineRec).not.toBe(rec.id)
  })

  test('an earlier claim from a peer loses to the wall already standing', () => {
    const h = boot()
    myWall(OTHER_SLOT) // lamport 1
    const id = myWall(WALL_SLOT) // lamport 2
    const stale = theirWall(h, WALL_SLOT, { yaw: 0 }) // lamport 1 in their world
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(stale)), 'them')
    expect(useBoots.getState().placed).toHaveLength(2)
    expect(pieceAt(WALL_SLOT)).toBe(id)
    expect(isForeignPiece(id)).toBe(false)
    expect(h.notices).toHaveLength(0) // we lost nothing, so we hear nothing
  })
})

// ── The grid gate ───────────────────────────────────────────────────────────

describe('a builder on a different lot grid', () => {
  test('their slot pieces are refused and the player is told once', () => {
    const h = boot()
    const rec = theirWall(h, WALL_SLOT)
    const wrong = frame(h, 'them', (d) => d.pieces.push(rec))
    wrong.gridStamp = h.stamp ^ 0x5f5f5f5f // a different lot entirely

    const fx = receiveBuildDelta(wrong, 'them')
    expect(fx.refusedGrid).toBe(true)
    expect(fx.addedPieces).toHaveLength(0)
    expect(useBoots.getState().placed).toHaveLength(0)
    expect(h.notices).toEqual(['A builder is on a different lot grid — their pieces are hidden'])

    // Refused, not spammed: a second bad frame says nothing new.
    receiveBuildDelta(wrong, 'them')
    expect(h.notices).toHaveLength(1)
  })

  test('the same peer’s items still arrive — only slots are lot-relative', () => {
    const h = boot()
    installAppliers()
    const item = addLocalItem(h.theirs, {
      catalogId: ITEM.id,
      x: 2,
      y: 0,
      z: 3,
      yaw: 0,
    })!
    const wrong = frame(h, 'them', (d) => d.items.push(item))
    wrong.gridStamp = 0 // unknown grid: the hardest case the gate allows
    const fx = receiveBuildDelta(wrong, 'them')
    // The item is world-absolute, so it lands: a mismatch costs pieces, not
    // everything. And the gate keeps quiet, because this frame never spelled a
    // slot — there is nothing for a stamp to have been wrong about.
    expect(fx.refusedGrid).toBe(false)
    expect(fx.dropped).toBe(0)
    expect(useItems.getState().items).toHaveLength(1)
    expect(isForeignPlacement(useItems.getState().items[0]!.id)).toBe(true)

    // Same peer, same bad stamp, now with a wall in the frame: that one IS
    // refused, and the second item still arrives beside it.
    const second = addLocalItem(h.theirs, { catalogId: ITEM.id, x: 4, y: 0, z: 3, yaw: 0 })!
    const both = frame(h, 'them', (d) => {
      d.pieces.push(theirWall(h, WALL_SLOT))
      d.items.push(second)
    })
    both.gridStamp = 0
    const fx2 = receiveBuildDelta(both, 'them')
    expect(fx2.refusedGrid).toBe(true)
    expect(fx2.dropped).toBe(1)
    expect(useBoots.getState().placed).toHaveLength(0)
    expect(useItems.getState().items).toHaveLength(2)
  })

  test('a stamp we have not published yet refuses everyone’s slots, in silence', () => {
    setGridAnchor({ x: 0, z: 0, yaw: 0 })
    setStoreyLadder(LADDER)
    const mine = createSharedWorld('me')
    const notices: string[] = []
    attachBuildSync(mine, { notice: (t) => notices.push(t) }) // no publishGridStamp
    const theirs = createSharedWorld('them')
    const rec = addLocalPiece(theirs, {
      kind: 'wall',
      slot: WALL_SLOT,
      mask: 511,
      yaw: 0,
      height: 2.8,
      corners: null,
    })!
    const delta = emptyDelta('them')
    delta.gridStamp = gridStamp(0, 0, 0, LADDER)
    delta.pieces.push(rec)
    expect(receiveBuildDelta(delta, 'them').refusedGrid).toBe(true)
    expect(useBoots.getState().placed).toHaveLength(0)
    // The transport attaches before the piece tree publishes our stamp, so this
    // window is REAL in a live session. Refusing is right; blaming a stranger's
    // lot for our own startup order is not — the player cannot act on it, and
    // the next frame lands anyway.
    expect(notices).toEqual([])

    // Once we know our own lot, the very same frame is a real disagreement and
    // the player hears about it.
    publishGridStamp(0, 0, 0, [gridTerrainY(), ...LADDER])
    expect(receiveBuildDelta(delta, 'them').refusedGrid).toBe(true)
    expect(notices).toEqual(['A builder is on a different lot grid — their pieces are hidden'])
  })
})

// ── Items and apertures ─────────────────────────────────────────────────────

describe('remote catalog items and openings', () => {
  test('an item is looked up locally and spawned; an unknown id is refused', () => {
    const h = boot()
    installAppliers()
    const good = addLocalItem(h.theirs, { catalogId: ITEM.id, x: 1, y: 0, z: 2, yaw: Math.PI / 2 })!
    const junk = addLocalItem(h.theirs, { catalogId: 'no-such-thing', x: 0, y: 0, z: 0, yaw: 0 })!
    receiveBuildDelta(frame(h, 'them', (d) => d.items.push(good, junk)), 'them')

    const items = useItems.getState().items
    expect(items).toHaveLength(1)
    const placement = items[0]!
    expect(placement.kind).toBe('item')
    expect(isForeignPlacement(placement.id)).toBe(true)
    // The refused record stays alive in the model — another client may well
    // have that asset, and a later re-fold can pick it up.
    expect(liveRecords(h.mine.items)).toHaveLength(2)
  })

  test('an aperture is materialized from the record, not re-derived', () => {
    const h = boot()
    installAppliers()
    const def = OPENING_ENTRIES[0]!
    const rec = addLocalAperture(h.theirs, {
      catalogId: def.id,
      host: 'wall-1',
      u: 1.25,
      v: 1,
      width: def.width + 0.4, // a resized opening on their screen
      height: def.height,
    })!
    receiveBuildDelta(frame(h, 'them', (d) => d.apertures.push(rec)), 'them')
    const placed = useItems.getState().items[0]!
    expect(placed.kind).toBe('aperture')
    if (placed.kind !== 'aperture') return
    expect(placed.wallId).toBe('wall-1')
    expect(placed.u).toBe(1.25)
    expect(placed.width).toBeCloseTo(def.width + 0.4, 6)
  })

  test('a tombstoned placement leaves this screen too', () => {
    const h = boot()
    installAppliers()
    const rec = addLocalItem(h.theirs, { catalogId: ITEM.id, x: 1, y: 0, z: 2, yaw: 0 })!
    receiveBuildDelta(frame(h, 'them', (d) => d.items.push(rec)), 'them')
    expect(useItems.getState().items).toHaveLength(1)
    receiveBuildDelta(frame(h, 'them', (d) => d.deadItems.push(rec.id)), 'them')
    expect(useItems.getState().items).toHaveLength(0)
    expect(sharedBuildDebug().placements.bound).toBe(0)
  })
})

// ── Paint ───────────────────────────────────────────────────────────────────

describe('remote strokes fold into the one coat ledger', () => {
  test('the fold uses the live coat arithmetic and accumulates like a spray', () => {
    const h = boot()
    installAppliers()
    useDestruction.getState().targets.set('wall_a', fakeTarget('wall_a'))
    const color = 3
    const radius = coatRadiusFor(0.5)
    const one = addLocalStroke(h.theirs, { node: 'wall_a', color, x: 0, y: 0, z: 0, radius })!
    receiveBuildDelta(frame(h, 'them', (d) => d.strokes.push(one)), 'them')

    const cells = getPaintedByNode().get('wall_a')!
    expect(cells.size).toBe(3) // the strip's middle three, under the disc
    const center = cells.get(2)!
    expect(paintColorOf(center)).toBe(color)
    // COAT_ADD at the centre — the same number sprayPaint would have written,
    // because paintValue/coatBaseStrength are IMPORTED, not re-implemented.
    expect(center).toBe(paintValue(color, 0.45))
    expect(paintStrengthOf(center)).toBeCloseTo(0.45, 2)

    // A second stroke of the same colour builds on the first.
    const two = addLocalStroke(h.theirs, { node: 'wall_a', color, x: 0, y: 0, z: 0, radius })!
    receiveBuildDelta(frame(h, 'them', (d) => d.strokes.push(two)), 'them')
    expect(paintStrengthOf(getPaintedByNode().get('wall_a')!.get(2)!)).toBeCloseTo(0.9, 2)

    // A different colour RESTARTS the accumulator (coatBaseStrength's rule).
    const other = addLocalStroke(h.theirs, { node: 'wall_a', color: 5, x: 0, y: 0, z: 0, radius })!
    receiveBuildDelta(frame(h, 'them', (d) => d.strokes.push(other)), 'them')
    const repainted = getPaintedByNode().get('wall_a')!.get(2)!
    expect(paintColorOf(repainted)).toBe(5)
    expect(repainted).toBe(paintValue(5, 0.45)) // not 0.9 carried across colours
  })

  test('re-delivering the same strokes does not double-coat', () => {
    const h = boot()
    installAppliers()
    useDestruction.getState().targets.set('wall_a', fakeTarget('wall_a'))
    const radius = coatRadiusFor(0.5)
    const strokes = [0, 1, 2].map(
      (i) =>
        addLocalStroke(h.theirs, { node: 'wall_a', color: 2, x: i * 0.15 - 0.15, y: 0, z: 0, radius })!,
    )
    const f = frame(h, 'them', (d) => d.strokes.push(...strokes))
    receiveBuildDelta(f, 'them')
    const settled = JSON.stringify([...getPaintedByNode().get('wall_a')!].sort())
    for (let i = 0; i < 4; i++) receiveBuildDelta(f, 'them')
    // Shuffled, and as a snapshot: a lattice join, so the ledger is the same.
    const shuffled = frame(h, 'them', (d) => {
      d.kind = 'snapshot'
      d.strokes.push(strokes[2]!, strokes[0]!, strokes[1]!)
    })
    receiveBuildDelta(shuffled, 'them')
    expect(JSON.stringify([...getPaintedByNode().get('wall_a')!].sort())).toBe(settled)
  })

  test('a colour outside this client’s palette is refused', () => {
    const h = boot()
    installAppliers()
    useDestruction.getState().targets.set('wall_a', fakeTarget('wall_a'))
    const hostile = addLocalStroke(h.theirs, {
      node: 'wall_a',
      color: PAINT_PALETTE.length + 9, // sane on the wire, unknown to the drain
      x: 0,
      y: 0,
      z: 0,
      radius: coatRadiusFor(0.5),
    })!
    receiveBuildDelta(frame(h, 'them', (d) => d.strokes.push(hostile)), 'them')
    expect(getPaintedByNode().get('wall_a')).toBeUndefined()
  })

  test('painting over a stranger’s coat makes that cell yours again', () => {
    const h = boot()
    installAppliers()
    useDestruction.getState().targets.set('wall_a', fakeTarget('wall_a'))
    const rec = addLocalStroke(h.theirs, {
      node: 'wall_a',
      color: 4,
      x: 0,
      y: 0,
      z: 0,
      radius: coatRadiusFor(0.5),
    })!
    receiveBuildDelta(frame(h, 'them', (d) => d.strokes.push(rec)), 'them')
    expect(remoteCoatedCells('wall_a').size).toBe(3)
    expect(getOwnPaintedByNode().get('wall_a')!.size).toBe(0)

    // Our own spray over the middle of their patch (the decal lane, which is
    // the local write path that runs headless).
    const mesh = new Mesh(new PlaneGeometry(6, 6))
    mesh.updateMatrixWorld(true)
    expect(spawnPaintDecal(mesh, 'wall_a', new Vector3(0, 0, 0), new Vector3(0, 0, 1), 0.4, 7)).toBe(
      true,
    )
    convertDecalsForNode('wall_a')
    const own = getOwnPaintedByNode().get('wall_a')!
    expect(own.size).toBeGreaterThan(0)
    expect(remoteCoatedCells('wall_a').size).toBeLessThan(3)
    // Every cell we now own reads OUR colour.
    for (const value of own.values()) expect(paintColorOf(value)).toBe(7)
    // And the shared ledger still holds the full picture for the drain.
    expect(getPaintedByNode().get('wall_a')!.size).toBe(3)
  })
})

// ── The invariant that matters most: Save writes only our work ──────────────

describe('a world full of other people’s work yields nothing to Save', () => {
  test('live, with the scene-write sentinel armed', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const info = spyOn(console, 'info').mockImplementation(() => {})

    const seeded = {
      'wall-1': { id: 'wall-1', type: 'wall', name: 'south wall' },
      'wall-2': { id: 'wall-2', type: 'wall', name: 'north wall' },
      'slab-1': { id: 'slab-1', type: 'slab', name: 'floor' },
    }
    scene.getState().setScene(seeded, ['wall-1', 'wall-2', 'slab-1'])
    useBoots.getState().setPhase('game')
    const teardown: Array<() => void> = []
    armSceneWriteSentinel(teardown)

    const before = scene.getState().nodes
    const beforeJson = JSON.stringify(before)

    const h = boot()
    installAppliers()
    useDestruction.getState().targets.set('wall-1', fakeTarget('wall-1'))
    const def = OPENING_ENTRIES[0]!

    // A whole neighbourhood built by three strangers: walls, floors, roofs,
    // furniture, openings and paint.
    for (let peer = 0; peer < 3; peer++) {
      const from = `peer-${peer}`
      const theirs = createSharedWorld(from)
      const delta = emptyDelta(from)
      delta.gridStamp = h.stamp
      delta.lamport = 10 + peer
      for (let i = 0; i < 4; i++) {
        delta.pieces.push(
          addLocalPiece(theirs, {
            kind: i % 2 === 0 ? 'wall' : 'floor',
            slot: i % 2 === 0 ? `Wx:${peer},${i},0` : `F:${peer},${i},0`,
            mask: 511,
            yaw: 0,
            height: 2.8,
            corners: null,
          })!,
        )
        delta.items.push(
          addLocalItem(theirs, { catalogId: ITEM.id, x: peer, y: 0, z: i, yaw: 0 })!,
        )
        delta.strokes.push(
          addLocalStroke(theirs, {
            node: 'wall-1',
            color: (peer + i) % PAINT_PALETTE.length,
            x: (i - 2) * 0.15,
            y: 0,
            z: 0,
            radius: coatRadiusFor(0.4),
          })!,
        )
      }
      delta.apertures.push(
        addLocalAperture(theirs, {
          catalogId: def.id,
          host: 'wall-1',
          u: 1 + peer,
          v: 1,
          width: def.width,
          height: def.height,
        })!,
      )
      receiveBuildDelta(delta, from)
    }

    // The screen is FULL of their work.
    expect(useBoots.getState().placed.length).toBe(12)
    expect(useItems.getState().items.length).toBe(15)
    expect(getPaintedByNode().get('wall-1')!.size).toBeGreaterThan(0)
    expect(sharedBuildDebug().pieces.foreign).toBe(12)

    // And Save has nothing whatsoever to write.
    expect(placedItemCount()).toBe(0)
    expect(capturePaint()).toBe(0)
    expect(usePaintKeep.getState().painted).toEqual([])
    expect(applyPaint()).toBe(0)
    const pieces = keepPlaced()
    expect(pieces).toEqual({ kept: 0, skipped: 0, windows: 0, doors: 0, roofs: 0, floors: 0 })
    const items = applyItems()
    expect(items).toEqual({ kept: 0, skipped: 0, doors: 0, windows: 0 })

    const after = scene.getState().nodes
    expect(after).toBe(before) // object identity: not even a re-spread
    expect(JSON.stringify(after)).toBe(beforeJson)
    expect(Object.keys(after).sort()).toEqual(['slab-1', 'wall-1', 'wall-2'])
    expect(error).not.toHaveBeenCalled()

    for (const fn of teardown.splice(0)) fn()
    error.mockRestore()
    info.mockRestore()
  })

  test('mine saves, theirs does not, from the same store', () => {
    const h = boot()
    installAppliers()
    const rec = theirWall(h, OTHER_SLOT)
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')
    myWall(WALL_SLOT)
    expect(useBoots.getState().placed).toHaveLength(2)

    // Exactly one piece is considered by the pass — ours.
    const result = keepPlaced()
    expect(result.kept + result.skipped).toBe(1)
  })

  test('Save unbinds our records but never tombstones them', () => {
    const h = boot()
    const id = myWall(WALL_SLOT)
    const recId = pieceRecordOf(id)!
    keepPlaced()
    // On this screen the wall became a real node; on every other screen it is
    // still the wall it always was, so the record must survive.
    expect(h.mine.pieces.dead.has(recId)).toBe(false)
    expect(liveRecords(h.mine.pieces)).toHaveLength(1)
    expect(pieceRecordOf(id)).toBeNull()
    // And the now-empty store must not read as a demolition, nor re-spawn.
    reconcileSharedPieces()
    expect(liveRecords(h.mine.pieces)).toHaveLength(1)
    expect(h.mine.pieces.dead.size).toBe(0)
    expect(useBoots.getState().placed).toHaveLength(0)
    expect(h.sent.some((d) => d.deadPieces.length > 0)).toBe(false)
  })

  test('Discard forgets our placements without killing anyone’s', () => {
    const h = boot()
    installAppliers()
    publishItem(7001, ITEM.id, [1, 0, 1], 0)
    const theirItem = addLocalItem(h.theirs, { catalogId: ITEM.id, x: 5, y: 0, z: 5, yaw: 0 })!
    receiveBuildDelta(frame(h, 'them', (d) => d.items.push(theirItem)), 'them')
    discardPlaced()
    discardItems()
    expect(liveRecords(h.mine.items)).toHaveLength(2)
    expect(h.mine.items.dead.size).toBe(0)
    expect(isForeignPlacement(7001)).toBe(false)
  })

  test('authorship outlives the session, because Save runs after teardown', () => {
    const h = boot()
    installAppliers()
    const rec = theirWall(h, WALL_SLOT)
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(rec)), 'them')
    const theirPieceId = useBoots.getState().placed[0]!.id
    const item = addLocalItem(h.theirs, { catalogId: ITEM.id, x: 1, y: 0, z: 1, yaw: 0 })!
    receiveBuildDelta(frame(h, 'them', (d) => d.items.push(item)), 'them')
    const theirItemId = useItems.getState().items[0]!.id

    // exitGame detaches the lane; the panel's Save happens LATER. If detaching
    // forgot who built what, every stranger's wall would read as ours at
    // exactly the moment Save writes the document.
    detachBuildSync()
    expect(buildSyncOn()).toBe(false)
    expect(isForeignPiece(theirPieceId)).toBe(true)
    expect(isForeignPlacement(theirItemId)).toBe(true)
    expect(keepPlaced()).toEqual({
      kept: 0,
      skipped: 0,
      windows: 0,
      doors: 0,
      roofs: 0,
      floors: 0,
    })
    expect(applyItems()).toEqual({ kept: 0, skipped: 0, doors: 0, windows: 0 })
  })
})

// ── A rename mid-session ────────────────────────────────────────────────────

describe('the host renames us mid-session', () => {
  test('a wall we built under the old name does not come back as a stranger’s', () => {
    const h = boot()
    installAppliers()
    const id = myWall(WALL_SLOT)
    const ours = pieceRecordOf(id)!
    expect(ours.startsWith('me#')).toBe(true)

    // The rename keeps every record in place and remembers the old name. It
    // reports our wall as a stale mint because this harness drives the lane
    // through a sink, which never drains the journal — the transport's
    // takePending is what empties it. So the residue the model warns about is
    // exactly this: work published under a name no peer will vouch for again.
    expect(rekeySharedWorld(h.mine, 'me-2')).toEqual([ours])
    expect(h.mine.self).toBe('me-2')
    expect(h.mine.formerSelves).toEqual(['me'])
    expect(liveRecords(h.mine.pieces).map((r) => r.id)).toContain(ours)

    // Save resolved that wall into the document: the record is released and
    // the game piece is gone from the store, exactly as keep.ts leaves it.
    forgetSharedPieces()
    useBoots.getState().removePlaced(id)
    onPieceRemoved(WALL_SLOT) // the slot is free again, as after any removal
    expect(pieceRecordOf(id)).toBeNull()

    // Now a stranger builds somewhere else, which re-runs the election over
    // every live record — including the one we published under our old name.
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(theirWall(h, OTHER_SLOT))), 'them')

    const placed = useBoots.getState().placed
    expect(placed).toHaveLength(1) // theirs only
    expect(placed[0]!.slotId).toBe(OTHER_SLOT)
    // The wall we just made real is NOT standing next to itself as somebody
    // else's work: no piece in the store carries the record we published under
    // our old name. `isAuthoredBy(id, world.self)` would have re-spawned it as
    // a remote piece the moment our name changed.
    for (const piece of placed) expect(pieceRecordOf(piece.id)).not.toBe(ours)
    expect(isForeignPiece(id)).toBe(false)
  })

  test('our own catalog item and our own paint survive the rename unduplicated', () => {
    const h = boot()
    installAppliers()
    const item = publishItem(41, ITEM.id, [1, 0, 2], 0)
    expect(item).not.toBeNull()
    publishStroke('wall-1', 3, 0, 0, 0, 0.3)
    rekeySharedWorld(h.mine, 'me-2')

    // A snapshot from a peer that carries our pre-rename work back to us. The
    // records are already in our world, so the model adds nothing — and the
    // author gate is what keeps the strokes from folding a second time even
    // when a reset makes them look new.
    const echo = frame(h, 'them', (d) => {
      for (const rec of liveRecords(h.mine.items)) d.items.push(rec)
      for (const rec of liveRecords(h.mine.strokes)) d.strokes.push(rec)
    })
    const fx = receiveBuildDelta(echo, 'them')
    expect(fx.addedItems).toHaveLength(0)
    expect(fx.addedStrokes).toHaveLength(0)
    expect(useItems.getState().items).toHaveLength(0) // never spawned a copy
  })
})

// ── The work the rename could not save by itself ────────────────────────────

/**
 * `rekeySharedWorld` renames a live session in place, so everything a peer has
 * already seen keeps its name. What it cannot fix is the handful of adds still
 * in the journal at that instant: no peer has them, and every peer will refuse
 * them now that our envelope says a different name. Left alone that is a
 * silent, permanent, one-client desync — the wall you happened to be placing
 * stands on your screen and on nobody else's.
 *
 * A note on the numbers below: the residue is bounded by "since the last
 * `takePending`", which in play is one tick because the transport drains
 * unconditionally. This harness drives the lane through a sink and never
 * pumps, so its journal holds everything the test ever made. These counts are
 * harness counts, not play counts.
 */
describe('a rename leaves unsent work behind', () => {
  test('re-minting gives it a name peers will accept, through the journal and not the wire', () => {
    const h = boot()
    installAppliers()
    const wall = myWall(WALL_SLOT)
    const oldPiece = pieceRecordOf(wall)!
    const oldItem = publishItem(41, ITEM.id, [1, 0, 2], 0)!
    const stale = rekeySharedWorld(h.mine, 'me-2')
    expect(stale).toContain(oldPiece)
    expect(stale).toContain(oldItem)

    const sentBefore = h.sent.length
    const fresh = remintSharedRecords(stale)
    expect(fresh).toHaveLength(stale.length)
    for (const id of fresh) expect(id.startsWith('me-2#')).toBe(true)

    // IN INPUT ORDER: the caller reads the difference between what it handed
    // over and what came back as the genuinely unrecoverable remainder, so the
    // positions have to line up lane for lane.
    const freshPiece = fresh[stale.indexOf(oldPiece)]!
    const freshItem = fresh[stale.indexOf(oldItem)]!
    expect(pieceRecordOf(wall)).toBe(freshPiece)
    expect(liveRecords(h.mine.items).map((r) => r.id)).toContain(freshItem)

    // The same two runtime objects, re-addressed — not two more of them.
    expect(sharedBuildDebug().pieces).toMatchObject({ bound: 1, foreign: 0 })
    expect(sharedBuildDebug().placements).toMatchObject({ bound: 1, foreign: 0 })
    expect(useBoots.getState().placed).toHaveLength(1)
    expect(publishItem(41, ITEM.id, [1, 0, 2], 0)).toBeNull() // still bound

    // IT MUST NOT PUBLISH. The re-mints leave by the one road the transport
    // drains, so a bus that coalesces frames never sees them twice.
    expect(h.sent.length).toBe(sentBefore)
    const pending = takePending(h.mine)!
    expect(pending.pieces.map((r) => r.id)).toContain(freshPiece)
    expect(pending.items.map((r) => r.id)).toContain(freshItem)
  })

  test('the re-bound piece is not read as an edit and replaced all over again', () => {
    const h = boot()
    const wall = myWall(WALL_SLOT)
    const stale = rekeySharedWorld(h.mine, 'me-2')
    const fresh = remintSharedRecords(stale)
    expect(fresh).toHaveLength(1)
    const live = liveRecords(h.mine.pieces).length

    // Reconcile compares each standing piece against the fingerprint it
    // published. A re-mint that forgot to carry that fingerprint over would
    // look like a moved wall here, and reconcile would tombstone the record we
    // just minted and mint a third one.
    reconcileSharedPieces()
    expect(liveRecords(h.mine.pieces)).toHaveLength(live)
    expect(h.mine.pieces.dead.size).toBe(0)
    expect(pieceRecordOf(wall)).toBe(fresh[0]!)
  })

  test('work already resolved into the document is never resurrected', () => {
    const h = boot()
    const wall = myWall(WALL_SLOT)
    const stale = rekeySharedWorld(h.mine, 'me-2')
    expect(stale).toEqual([pieceRecordOf(wall)!])

    // Save took that wall: the record is released and the game piece is gone,
    // exactly as keep.ts leaves things. Re-publishing it now would put a
    // stranger's copy of a wall the player already owns back on the field —
    // the one outcome worse than losing an unsent tick of work.
    forgetSharedPieces()
    useBoots.getState().removePlaced(wall)
    onPieceRemoved(WALL_SLOT)
    const live = liveRecords(h.mine.pieces).length

    expect(remintSharedRecords(stale)).toEqual([])
    expect(liveRecords(h.mine.pieces)).toHaveLength(live)
    expect(useBoots.getState().placed).toHaveLength(0)
  })

  test('strokes, strangers, an empty list and a detached lane are no-ops', () => {
    const h = boot()
    installAppliers()
    const stroke = publishStroke('wall-1', 3, 0, 0, 0, 0.3)!
    const wall = myWall(WALL_SLOT)
    const oldPiece = pieceRecordOf(wall)!
    rekeySharedWorld(h.mine, 'me-2')

    expect(remintSharedRecords([])).toEqual([])
    // A stroke has no runtime object to re-read, only the coat ledger it
    // already folded into; a stranger's id was never ours to mint.
    expect(remintSharedRecords([stroke, 'them#4', 'nobody#9'])).toEqual([])
    expect(liveRecords(h.mine.strokes).map((r) => r.id)).toEqual([stroke])

    // A junk id in the batch costs itself and nothing else: the one record
    // that can be recovered still is.
    const fresh = remintSharedRecords([stroke, oldPiece, 'them#4'])
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toBe(pieceRecordOf(wall)!)

    detachBuildSync()
    expect(buildSyncOn()).toBe(false)
    expect(remintSharedRecords([oldPiece])).toEqual([])
  })

  test('the re-mint does not depose the wall it replaces', () => {
    const h = boot()
    installAppliers()
    const wall = myWall(WALL_SLOT)
    const fresh = remintSharedRecords(rekeySharedWorld(h.mine, 'me-2'))
    expect(fresh).toHaveLength(1)

    // Both records claim the slot now, and a stranger's frame re-runs the
    // election over every live record. The re-mint is canonically later so it
    // wins; the record it replaced lost, but nothing is bound to it any more,
    // so no wall is uninstalled and nobody is told their slot was taken.
    receiveBuildDelta(frame(h, 'them', (d) => d.pieces.push(theirWall(h, OTHER_SLOT))), 'them')
    expect(
      useBoots
        .getState()
        .placed.map((p) => p.slotId)
        .sort(),
    ).toEqual([OTHER_SLOT, WALL_SLOT].sort())
    expect(h.notices).toEqual([])
    expect(pieceRecordOf(wall)).toBe(fresh[0]!)
    expect(isForeignPiece(wall)).toBe(false) // still ours to Save
  })
})
