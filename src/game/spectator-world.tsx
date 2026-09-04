'use client'

import { useEffect, useRef, useState } from 'react'
import type { PlacedPiece } from '../store'
import { GunTable } from './guntable'
import { parseSlotId, setGridAnchor, setGridTerrainY, setStoreyLadder, slotPose } from './grid'
import {
  ensureFullCatalog,
  OPENING_ENTRIES,
  placeableCatalog,
} from './inventory'
import type { PlacedAperture, PlacedItem } from './item-place'
import {
  localSessionId,
  onFrame,
  registerFrameKind,
  requestState,
  startNet,
  type NetMessage,
} from './net'
import { MAX_WIRE_TEXT, WORLD_KIND, WORLD_SNAP_KIND } from './net-world'
import { untilNet } from './net-retry'
import { Nature } from './nature'
import { NodeLedger, PreviewAperture, PreviewItem, PreviewPiece } from './preview'
import type { DestroyedNode } from './save-demolition'
import { canonicalRecordOrder, electSlots } from './shared-derive'
import {
  createSharedWorld,
  damagedNodes,
  isOurs,
  isSafePeerId,
  liveRecords,
  mergeDelta,
  setGridStamp,
  type SharedDelta,
  type SharedWorld,
} from './shared-world'
import { decodeDeltaText } from './shared-wire'
import { TreesDestruct } from './trees-destruct'
import { collectWorld, deriveLiveGrid } from './world'

/**
 * Read-only multiplayer construction for the normal editor viewport.
 *
 * This deliberately owns a separate SharedWorld from the running game's
 * adapters. It receives the exact same convergent records, but never installs
 * gameplay colliders, consumes editor input, publishes local work, or writes
 * the scene document. That keeps the overview a camera onto the live session
 * rather than a second simulation competing with it.
 */

type OverviewBuilds = {
  pieces: Array<{ key: string; value: PlacedPiece }>
  items: Array<{ key: string; value: PlacedItem }>
  apertures: Array<{ key: string; value: PlacedAperture }>
  destroyed: DestroyedNode[]
}

const EMPTY: OverviewBuilds = { pieces: [], items: [], apertures: [], destroyed: [] }

function runtimeId(id: string): number {
  let hash = 2166136261
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function overviewBuilds(world: SharedWorld): OverviewBuilds {
  const { winners } = electSlots(liveRecords(world.pieces))
  const pieces: OverviewBuilds['pieces'] = []
  for (const rec of canonicalRecordOrder(winners.values())) {
    if (isOurs(world, rec.id)) continue
    const slot = parseSlotId(rec.slot)
    if (!slot) continue
    const pose = slotPose(slot)
    pieces.push({
      key: rec.id,
      value: {
        id: runtimeId(rec.id),
        piece: rec.kind,
        position: pose.position,
        yaw: rec.yaw,
        mask: rec.mask,
        slotId: rec.slot,
        ...(rec.height > 0 ? { height: rec.height } : {}),
        ...(rec.corners ? { corners: [...rec.corners] } : {}),
      } as PlacedPiece,
    })
  }

  const items: OverviewBuilds['items'] = []
  for (const rec of liveRecords(world.items)) {
    if (isOurs(world, rec.id)) continue
    const asset = placeableCatalog().find((entry) => entry.id === rec.catalogId)
    if (!asset) continue
    items.push({
      key: rec.id,
      value: {
        kind: 'item',
        id: runtimeId(rec.id),
        asset,
        position: [rec.x, rec.y, rec.z],
        yaw: rec.yaw,
      },
    })
  }

  const apertures: OverviewBuilds['apertures'] = []
  for (const rec of liveRecords(world.apertures)) {
    if (isOurs(world, rec.id)) continue
    const def = OPENING_ENTRIES.find((entry) => entry.id === rec.catalogId)
    if (!def) continue
    apertures.push({
      key: rec.id,
      value: {
        kind: 'aperture',
        id: runtimeId(rec.id),
        def,
        wallId: rec.host,
        u: rec.u,
        v: rec.v,
        width: rec.width,
        height: rec.height,
      },
    })
  }
  const destroyed = damagedNodes(world)
    .filter((nodeId) => world.nodes.get(nodeId)?.killed === true)
    .map((nodeId) => ({ nodeId, kind: 'wall' as const }))
  return { pieces, items, apertures, destroyed }
}

function readOverviewDelta(data: unknown): SharedDelta | null {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_WIRE_TEXT) return null
  try {
    return decodeDeltaText(data)
  } catch {
    return null
  }
}

function startOverviewBuilds(onChange: (world: SharedWorld) => void): (() => void) | null {
  if (!startNet()) return null
  const self = localSessionId()
  if (!isSafePeerId(self)) return null
  const world = createSharedWorld(self)

  const ingest = (message: NetMessage<SharedDelta>) => {
    // The room is already scoped to this project. Adopting its first non-zero
    // grid stamp lets an editor observer receive slot-addressed construction
    // even when its level display is currently exploded or isolated.
    if (world.gridStamp === 0 && message.data.gridStamp !== 0) {
      setGridStamp(world, message.data.gridStamp)
    }
    mergeDelta(world, message.data, message.sessionId)
    onChange(world)
  }

  registerFrameKind<SharedDelta>(WORLD_KIND, readOverviewDelta, { ordered: false })
  registerFrameKind<SharedDelta>(WORLD_SNAP_KIND, readOverviewDelta, { ordered: false })
  const offDelta = onFrame<SharedDelta>(WORLD_KIND, ingest)
  const offSnapshot = onFrame<SharedDelta>(WORLD_SNAP_KIND, ingest)
  requestState(WORLD_KIND)
  return () => {
    offDelta()
    offSnapshot()
  }
}

export function SpectatorBuilds() {
  const [builds, setBuilds] = useState<OverviewBuilds>(EMPTY)
  const worldRef = useRef<SharedWorld | null>(null)

  useEffect(() => {
    const frame = deriveLiveGrid()
    // Rendering slots needs the scene's frame, but this remains read-only:
    // no slot is registered and no scene node is created or changed.
    setGridTerrainY(frame.ladder?.[0] ?? 0)
    setGridAnchor(frame.anchor)
    setStoreyLadder(frame.ladder)

    let stop: (() => void) | null = null
    let alive = true
    const cancelRetry = untilNet(
      () => {
        stop = startOverviewBuilds((world) => {
          worldRef.current = world
          setBuilds(overviewBuilds(world))
        })
        return stop !== null
      },
    )
    void ensureFullCatalog().then(() => {
      // A late API catalog can resolve models that arrived on the wire first.
      // The next room frame would also refresh, but this removes that wait.
      const world = worldRef.current
      if (alive && world) setBuilds(overviewBuilds(world))
    })
    return () => {
      alive = false
      cancelRetry()
      stop?.()
      worldRef.current = null
      setBuilds(EMPTY)
    }
  }, [])

  return (
    <group userData={{ __boots: true, __bootsSpectatorWorld: true }}>
      <NodeLedger destroyed={builds.destroyed} painted={[]} />
      {builds.pieces.map(({ key, value }) => (
        <PreviewPiece key={key} piece={value} />
      ))}
      {builds.items.map(({ key, value }) => (
        <PreviewItem item={value} key={key} />
      ))}
      {builds.apertures.map(({ key, value }) => (
        <PreviewAperture key={key} placed={value} />
      ))}
    </group>
  )
}

/**
 * Boots' read-only editor overview. The host scene remains the source of the
 * building and authored road network; this adds only game-owned visuals and
 * live room projections. No gameplay collider, input handler, authority, or
 * scene-store write is installed here.
 */
export function SpectatorWorld() {
  const [world] = useState(() =>
    collectWorld({ snapLevels: false, primeBvhs: false, installGround: false }),
  )
  return (
    <>
      <SpectatorBuilds />
      <Nature world={world} />
      <TreesDestruct spectator world={world} />
      <GunTable spectator world={world} />
    </>
  )
}
