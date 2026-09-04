import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  resetGridAnchor,
  resetGridTerrainY,
  resetStoreyLadder,
  setGridAnchor,
  setGridTerrainY,
  setStoreyLadder,
} from './grid'
import { type CatalogEntry, OPENING_ENTRIES, setCatalog } from './inventory'
import { overviewBuilds } from './spectator-world'
import {
  addLocalAperture,
  addLocalItem,
  addLocalPiece,
  createSharedWorld,
  killRecord,
  mergeDelta,
  noteLocalKill,
  setGridStamp,
  snapshotOf,
} from './shared-world'

const SOFA: CatalogEntry = {
  id: 'sofa',
  category: 'furniture',
  name: 'Sofa',
  thumbnail: 'https://cdn.test/sofa.png',
  src: 'https://cdn.test/sofa.glb',
}

function reset(): void {
  setCatalog(null)
  resetGridAnchor()
  resetGridTerrainY()
  resetStoreyLadder()
}

beforeEach(() => {
  reset()
  setCatalog([SOFA])
  setGridTerrainY(0)
  setGridAnchor({ x: 0, z: 0, yaw: 0 })
  setStoreyLadder([0, 2.5, 5])
})
afterEach(reset)

describe('editor spectator world', () => {
  test('projects convergent remote walls, items and apertures without duplicating local work', () => {
    const peer = createSharedWorld('peer')
    const viewer = createSharedWorld('viewer')
    setGridStamp(peer, 42)
    setGridStamp(viewer, 42)

    const wall = addLocalPiece(peer, {
      kind: 'wall',
      slot: 'Wz:1,2,0',
      mask: 511,
      yaw: 0,
      height: 2.5,
      corners: null,
    })!
    const item = addLocalItem(peer, { catalogId: SOFA.id, x: 4, y: 1.2, z: -3, yaw: 0.5 })!
    const aperture = addLocalAperture(peer, {
      catalogId: OPENING_ENTRIES[0]!.id,
      host: 'wall-1',
      u: 0.4,
      v: 1.05,
      width: 0.9,
      height: 2.1,
    })!
    noteLocalKill(peer, 'host-wall-7')
    addLocalItem(viewer, { catalogId: SOFA.id, x: 99, y: 0, z: 99, yaw: 0 })

    mergeDelta(viewer, snapshotOf(peer), 'peer')
    const first = overviewBuilds(viewer)

    expect(first.pieces.map((entry) => entry.key)).toEqual([wall.id])
    expect(first.pieces[0]!.value.position).toEqual([4.5, 0, 6])
    expect(first.items.map((entry) => entry.key)).toEqual([item.id])
    expect(first.items[0]!.value.position).toEqual([4, 1.2, -3])
    expect(first.apertures.map((entry) => entry.key)).toEqual([aperture.id])
    expect(first.destroyed).toEqual([{ nodeId: 'host-wall-7', kind: 'wall' }])

    killRecord(peer, 'items', item.id)
    mergeDelta(viewer, snapshotOf(peer), 'peer')
    expect(overviewBuilds(viewer).items).toEqual([])
  })
})
