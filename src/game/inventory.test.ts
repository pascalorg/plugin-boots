import { describe, expect, test } from 'bun:test'
import {
  type CatalogEntry,
  catalogCategories,
  categoryPage,
  isItemMenuOpen,
  MENU_CATEGORY_CAP,
  MENU_COLUMNS,
  moveSelection,
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
