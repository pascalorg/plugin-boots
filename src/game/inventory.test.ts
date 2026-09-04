import { describe, expect, test } from 'bun:test'
import { DoorNode, WindowNode } from '@pascal-app/core'
import {
  type CatalogEntry,
  catalogCategories,
  catalogMenuCategories,
  categoryPage,
  isItemMenuOpen,
  isOpeningEntry,
  MENU_CATEGORY_CAP,
  MENU_COLUMNS,
  MENU_PANEL_MAX_WIDTH_PX,
  MENU_THUMB_MAX_PX,
  MENU_THUMB_MIN_PX,
  mergeCatalog,
  moveSelection,
  OPENING_ENTRIES,
  OPENINGS_CATEGORY,
  placeableCatalog,
} from './inventory'

/**
 * Catalog helpers (pure) + menu-state guards. The DOM menu itself is
 * render-side (no document under bun test — openItemMenu is covered by its
 * headless guard); every filter/paging/selection rule runs here against
 * explicit lists, independent of the bundled CATALOG_ITEMS (which the
 * test-preload editor stub doesn't ship).
 */

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id,
  category: 'furniture',
  name: id,
  thumbnail: `https://cdn.test/${id}/thumbnail.png`,
  src: `https://cdn.test/${id}/model.glb`,
  ...over,
})

describe('placeableCatalog', () => {
  test('keeps floor-standing items, drops attachTo and tool rows', () => {
    const items = [
      entry('couch'),
      entry('mirror', { attachTo: 'wall-side' }),
      entry('ceiling-fan', { attachTo: 'ceiling' }),
      entry('paint-roller', { tool: 'paint' }),
      entry('fridge', { category: 'appliance' }),
    ]
    expect(placeableCatalog(items).map((i) => i.id)).toEqual(['couch', 'fridge'])
  })

  test('bundled default is safe under the test stub (no throw, an array)', () => {
    expect(Array.isArray(placeableCatalog())).toBe(true)
  })
})

describe('API catalog merge', () => {
  test('API rows win by id and retain bundled rows as an offline-compatible tail', () => {
    const bundled = [entry('chair'), entry('lamp')]
    const apiChair = entry('chair', { name: 'Current chair', src: 'https://api.test/chair.glb' })
    const apiSofa = entry('sofa')
    expect(mergeCatalog([apiChair, apiSofa], bundled)).toEqual([apiChair, apiSofa, bundled[1]!])
  })
})

describe('catalogCategories', () => {
  test('distinct categories in first-appearance order', () => {
    const items = [
      entry('a', { category: 'furniture' }),
      entry('b', { category: 'kitchen' }),
      entry('c', { category: 'furniture' }),
      entry('d', { category: 'outdoor' }),
    ]
    expect(catalogCategories(items)).toEqual(['furniture', 'kitchen', 'outdoor'])
  })
})

describe('categoryPage', () => {
  test('filters by category, preserves catalog order, caps the page', () => {
    const items = Array.from({ length: MENU_CATEGORY_CAP + 8 }, (_, i) =>
      entry(`chair-${i}`),
    ).concat(entry('grill', { category: 'outdoor' }))
    const page = categoryPage(items, 'furniture')
    expect(page).toHaveLength(MENU_CATEGORY_CAP)
    expect(page[0]!.id).toBe('chair-0')
    expect(categoryPage(items, 'outdoor').map((i) => i.id)).toEqual(['grill'])
    expect(categoryPage(items, 'bathroom')).toEqual([])
  })
})

describe('moveSelection', () => {
  test('left/right step one card, clamped to the page', () => {
    expect(moveSelection(3, 'ArrowRight', 10)).toBe(4)
    expect(moveSelection(0, 'ArrowLeft', 10)).toBe(0)
    expect(moveSelection(9, 'ArrowRight', 10)).toBe(9)
  })

  test('up/down move one row (MENU_COLUMNS), never off the page', () => {
    expect(moveSelection(1, 'ArrowDown', 10)).toBe(1 + MENU_COLUMNS)
    expect(moveSelection(1, 'ArrowUp', 10)).toBe(1)
    expect(moveSelection(8, 'ArrowDown', 10)).toBe(8)
  })

  test('degenerate inputs stay sane (empty page, stale index)', () => {
    expect(moveSelection(4, 'ArrowRight', 0)).toBe(0)
    expect(moveSelection(99, 'ArrowLeft', 3)).toBe(2)
  })
})

describe('menu state (headless)', () => {
  test('closed by default; nothing here can open it without a DOM', () => {
    expect(isItemMenuOpen()).toBe(false)
  })
})

describe('menu presentation scale', () => {
  test('uses a large desktop surface without sacrificing the narrow-screen floor', () => {
    expect(MENU_PANEL_MAX_WIDTH_PX).toBeGreaterThanOrEqual(1000)
    expect(MENU_THUMB_MAX_PX).toBeGreaterThanOrEqual(110)
    expect(MENU_THUMB_MIN_PX).toBeGreaterThanOrEqual(72)
    expect(MENU_THUMB_MAX_PX).toBeGreaterThan(MENU_THUMB_MIN_PX)
  })
})

describe('OPENING_ENTRIES (the doors/windows tab)', () => {
  test('one openings category, pinned first in the visible menu tabs', () => {
    const items = [entry('couch'), entry('fridge', { category: 'appliance' }), ...OPENING_ENTRIES]
    expect(catalogCategories(items)).toEqual(['furniture', 'appliance', OPENINGS_CATEGORY])
    expect(catalogMenuCategories(items)).toEqual([OPENINGS_CATEGORY, 'furniture', 'appliance'])
    expect(categoryPage(items, OPENINGS_CATEGORY)).toHaveLength(OPENING_ENTRIES.length)
  })

  test('every entry is card-complete and host-schema-typed', () => {
    expect(OPENING_ENTRIES.length).toBeGreaterThanOrEqual(4)
    for (const opening of OPENING_ENTRIES) {
      expect(opening.opening).toBe(true)
      expect(opening.category).toBe(OPENINGS_CATEGORY)
      expect(opening.name.length).toBeGreaterThan(0)
      expect(opening.thumbnail.startsWith('data:image/svg+xml,')).toBe(true)
      expect(opening.width).toBeGreaterThan(0)
      expect(opening.height).toBeGreaterThan(0)
      // Proof by the REAL host schema: the entry's family value parses.
      const base = {
        object: 'node',
        parentId: 'wall_x',
        visible: true,
        metadata: {},
        name: opening.name,
      }
      if (opening.node === 'door') {
        const parsed = DoorNode.parse({ ...base, doorType: opening.doorType }) as {
          doorType: string
        }
        expect(parsed.doorType).toBe(opening.doorType!)
        expect(opening.sill).toBe(0) // doors sit on the floor
        expect(opening.windowType).toBeUndefined()
      } else {
        const parsed = WindowNode.parse({ ...base, windowType: opening.windowType }) as {
          windowType: string
        }
        expect(parsed.windowType).toBe(opening.windowType!)
        expect(opening.sill).toBeGreaterThan(0)
        expect(opening.doorType).toBeUndefined()
      }
      // Every entry fits a host-default 2.5 m wall under the top margin.
      expect(opening.sill + opening.height).toBeLessThanOrEqual(2.45)
    }
  })

  test('ids are unique', () => {
    expect(new Set(OPENING_ENTRIES.map((o) => o.id)).size).toBe(OPENING_ENTRIES.length)
  })

  test('isOpeningEntry discriminates openings from catalog assets', () => {
    expect(isOpeningEntry(OPENING_ENTRIES[0]!)).toBe(true)
    expect(isOpeningEntry(entry('couch'))).toBe(false)
  })
})
