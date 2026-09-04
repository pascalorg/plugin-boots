import type { AssetInput } from '@pascal-app/core'
// Namespace import ON PURPOSE: the bun-test preload mocks @pascal-app/editor
// wholesale (useEditor only), and a named CATALOG_ITEMS import would be a
// load-time SyntaxError there; the namespace read below degrades to [].
import * as editorPkg from '@pascal-app/editor'
import type { GameSession } from './session'

/**
 * The in-game creative catalog — a fort-builder-genre item menu over the
 * host's bundled system catalog (`CATALOG_ITEMS`, ~111 items with public
 * thumbnail + GLB URLs). Press I in-game (any tool) to open; pick a couch,
 * an appliance, a planter — item-place.tsx arms an aim-anchored ghost and
 * clicking drops GAME-ONLY copies; item-keep.ts converts them into real
 * `item` nodes only from the sidebar Save button. A pinned 'openings' tab
 * (OPENING_ENTRIES, not catalog rows) offers doors and windows instead:
 * those arm item-place's WALL-SNAP ghost and Save creates real host
 * `door`/`window` nodes on the aimed wall.
 *
 * Imperative DOM, the hud.ts idiom (no React): the menu mounts INSIDE the
 * session's fullscreen container, builds its card grid once per open/tab
 * switch, and tears down entirely on close. DOM stays small by contract —
 * floor-standing items only (no attachTo, no tools) and at most
 * MENU_CATEGORY_CAP cards per category tab.
 *
 * INPUT CONTRACT (the two session-side latches, manager-wired):
 * - Pointer lock RELEASES while the menu is open (mouse turns into a
 *   cursor) and re-acquires on close. session.ts's pointerlockchange exit
 *   watcher must therefore skip the release while `isItemMenuOpen()`.
 * - While open, input.ts routes EVERY keydown to `input.onMenuKey` instead
 *   of the game state (the `menuOpen` flag on GameInput) and lets pointer /
 *   wheel events pass through to the DOM untouched — the full-viewport
 *   backdrop swallows every click, so the host editor still never sees one.
 *   Held movement keys are cleared on open so nothing sticks while the
 *   game loop is blind. Both members are feature-detected here (the fleet
 *   idiom): before the manager's input.ts wiring lands the menu still
 *   opens — keyboard nav is simply inert and clicks are eaten by input.ts.
 * - Esc: with pointer lock already released the browser spends Esc on
 *   FULLSCREEN exit, which the session rightly treats as "leave the game"
 *   (the placed items survive the exit and wait in the sidebar). I is the
 *   in-menu close key.
 */

/** The bundled catalog rows; the live host types this AssetInput & {tool?}. */
export type CatalogEntry = AssetInput & { tool?: string }

/**
 * A wall-hosted opening the catalog offers next to furniture — NOT an
 * asset row: no GLB, no free-floor ghost. Picking one arms item-place's
 * WALL-SNAP ghost instead; Save creates a real host `door`/`window` node
 * on the aimed wall (item-keep.ts). `doorType`/`windowType` values come
 * straight from the host schema enums (core DoorType / WindowType), widths
 * and heights from the schema defaults or common trade sizes.
 */
export type OpeningEntry = {
  /** Discriminant vs CatalogEntry (which never carries it). */
  opening: true
  id: string
  category: string
  name: string
  thumbnail: string
  node: 'door' | 'window'
  doorType?: 'hinged' | 'double' | 'sliding'
  windowType?: 'fixed' | 'sliding' | 'casement'
  /** Nominal aperture size (host schema `width`/`height`). */
  width: number
  height: number
  /** Bottom of the aperture above the wall base — 0 for doors (they sit on
   * the floor, host renders position[1] = height/2), sill height for
   * windows. */
  sill: number
}

/** Anything a menu card can hold. */
export type MenuEntry = CatalogEntry | OpeningEntry

export function isOpeningEntry(entry: MenuEntry): entry is OpeningEntry {
  return (entry as OpeningEntry).opening === true
}

/** Line-art data-URI thumbnail — openings have no CDN PNG to show. */
function openingThumb(body: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72" fill="none" ` +
    `stroke="rgba(255,255,255,0.85)" stroke-width="2.5">${body}</svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export const OPENINGS_CATEGORY = 'openings'

/**
 * The v1 openings page: three door and three window families whose type
 * enums the host schema supports verbatim. Sizes: doors at the schema
 * default height (2.1); the fixed window at the schema default 1.5 × 1.5
 * with a 0.9 m sill — every entry fits a host-default 2.5 m wall.
 */
export const OPENING_ENTRIES: readonly OpeningEntry[] = [
  {
    opening: true,
    id: 'opening-door-hinged',
    category: OPENINGS_CATEGORY,
    name: 'Hinged door',
    node: 'door',
    doorType: 'hinged',
    width: 0.9,
    height: 2.1,
    sill: 0,
    thumbnail: openingThumb(
      '<rect x="20" y="10" width="32" height="54"/><path d="M22 12 A30 30 0 0 1 50 40" stroke-dasharray="3 3"/><circle cx="46" cy="38" r="1.5"/>',
    ),
  },
  {
    opening: true,
    id: 'opening-door-double',
    category: OPENINGS_CATEGORY,
    name: 'Double door',
    node: 'door',
    doorType: 'double',
    width: 1.6,
    height: 2.1,
    sill: 0,
    thumbnail: openingThumb(
      '<rect x="12" y="10" width="48" height="54"/><line x1="36" y1="10" x2="36" y2="64"/><circle cx="32" cy="38" r="1.5"/><circle cx="40" cy="38" r="1.5"/>',
    ),
  },
  {
    opening: true,
    id: 'opening-door-sliding',
    category: OPENINGS_CATEGORY,
    name: 'Sliding door',
    node: 'door',
    doorType: 'sliding',
    width: 1.8,
    height: 2.1,
    sill: 0,
    thumbnail: openingThumb(
      '<rect x="10" y="10" width="52" height="54"/><rect x="14" y="14" width="26" height="46"/><path d="M44 37 h12 m-4 -4 l4 4 l-4 4"/>',
    ),
  },
  {
    opening: true,
    id: 'opening-window-fixed',
    category: OPENINGS_CATEGORY,
    name: 'Fixed window',
    node: 'window',
    windowType: 'fixed',
    width: 1.5,
    height: 1.5,
    sill: 0.9,
    thumbnail: openingThumb(
      '<rect x="14" y="14" width="44" height="44"/><line x1="36" y1="14" x2="36" y2="58"/><line x1="14" y1="36" x2="58" y2="36"/>',
    ),
  },
  {
    opening: true,
    id: 'opening-window-sliding',
    category: OPENINGS_CATEGORY,
    name: 'Sliding window',
    node: 'window',
    windowType: 'sliding',
    width: 1.5,
    height: 1.0,
    sill: 1.0,
    thumbnail: openingThumb(
      '<rect x="10" y="22" width="52" height="28"/><line x1="36" y1="22" x2="36" y2="50"/><path d="M20 36 h10 m-3 -3 l3 3 l-3 3"/>',
    ),
  },
  {
    opening: true,
    id: 'opening-window-casement',
    category: OPENINGS_CATEGORY,
    name: 'Casement window',
    node: 'window',
    windowType: 'casement',
    width: 0.6,
    height: 1.2,
    sill: 0.9,
    thumbnail: openingThumb(
      '<rect x="24" y="14" width="24" height="44"/><path d="M26 16 L44 36 L26 56" stroke-dasharray="3 3"/>',
    ),
  },
]

/** Cards per category tab — a hard DOM cap, not pagination (v1). */
export const MENU_CATEGORY_CAP = 32
/** Fixed grid columns — keyboard Up/Down move by exactly one row. */
export const MENU_COLUMNS = 4
/** Desktop catalog scale. The original 720 px / 72 px layout occupied barely
 * a third of a modern fullscreen canvas; keep the small-screen floor while
 * letting the selection surface and thumbnails read at normal game-menu size. */
export const MENU_PANEL_MAX_WIDTH_PX = 1040
export const MENU_THUMB_MIN_PX = 72
export const MENU_THUMB_MAX_PX = 112

/** The bundled system catalog, defensively: under bun test the editor
 * package is a zustand-shaped stub without CATALOG_ITEMS. */
const BUNDLED: readonly CatalogEntry[] = Array.isArray(
  (editorPkg as { CATALOG_ITEMS?: unknown }).CATALOG_ITEMS,
)
  ? ((editorPkg as { CATALOG_ITEMS: CatalogEntry[] }).CATALOG_ITEMS as CatalogEntry[])
  : []

/**
 * The host owns the real catalog. Keep the bundle only as an offline/old-host
 * fallback; once the same-origin API answers, its rows win by id so every
 * Boots client places the current published asset rather than a stale copy.
 */
let activeCatalog: readonly CatalogEntry[] = BUNDLED
let catalogHydration: Promise<readonly CatalogEntry[]> | null = null

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    row.id.length > 0 &&
    typeof row.name === 'string' &&
    typeof row.category === 'string' &&
    typeof row.src === 'string' &&
    row.src.length > 0 &&
    typeof row.thumbnail === 'string'
  )
}

export function mergeCatalog(
  apiItems: readonly CatalogEntry[],
  fallback: readonly CatalogEntry[] = BUNDLED,
): CatalogEntry[] {
  const seen = new Set(apiItems.map((item) => item.id))
  return [...apiItems, ...fallback.filter((item) => !seen.has(item.id))]
}

export function ensureFullCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<readonly CatalogEntry[]> {
  if (catalogHydration) return catalogHydration
  catalogHydration = fetchImpl('/api/plugins/boots/catalog', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`catalog answered ${response.status}`)
      const body: unknown = await response.json()
      const rows =
        body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items)
          ? (body as { items: unknown[] }).items.filter(isCatalogEntry)
          : []
      if (rows.length === 0) throw new Error('catalog answered without placeable items')
      activeCatalog = mergeCatalog(rows)
      return activeCatalog
    })
    .catch(() => {
      catalogHydration = null
      return activeCatalog
    })
  return catalogHydration
}

/** Test seam: production only calls ensureFullCatalog. */
export function setCatalog(items: readonly CatalogEntry[] | null): void {
  activeCatalog = items ? [...items] : BUNDLED
  catalogHydration = null
}

/**
 * Scope filter — pure, exported for tests: free-standing GLB items only.
 * Their bottom anchor can snap to floors, counters, shelves, or other solid
 * surfaces. `attachTo` items (wall/ceiling/wall-side) need host attachment
 * frames the game does not model, and `tool` rows are editor affordances,
 * not placeable assets.
 */
export function placeableCatalog(
  items: readonly CatalogEntry[] = activeCatalog,
): CatalogEntry[] {
  return items.filter((item) => !item.attachTo && !item.tool)
}

/** Distinct categories in first-appearance order — the tab row. */
export function catalogCategories(items: ReadonlyArray<{ category: string }>): string[] {
  const seen: string[] = []
  for (const item of items) {
    if (!seen.includes(item.category)) seen.push(item.category)
  }
  return seen
}

/** Menu order keeps doors/windows permanently discoverable even when the
 * live API contributes dozens of furniture categories. Furniture can still
 * be the initially selected page; this only pins the openings button first. */
export function catalogMenuCategories(items: ReadonlyArray<{ category: string }>): string[] {
  const categories = catalogCategories(items)
  const opening = categories.indexOf(OPENINGS_CATEGORY)
  if (opening <= 0) return categories
  categories.splice(opening, 1)
  categories.unshift(OPENINGS_CATEGORY)
  return categories
}

/** One tab's visible cards (first CAP of the category, catalog order). */
export function categoryPage<T extends { category: string }>(
  items: readonly T[],
  category: string,
  cap = MENU_CATEGORY_CAP,
): T[] {
  const page: T[] = []
  for (const item of items) {
    if (item.category !== category) continue
    page.push(item)
    if (page.length >= cap) break
  }
  return page
}

/** Grid-arrow selection move — pure, exported for tests. Left/Right step
 * one card clamped to the page, Up/Down one ROW (MENU_COLUMNS) and refuse
 * to leave the page (no wrap: muscle memory beats surprise). */
export function moveSelection(
  index: number,
  code: string,
  count: number,
  columns = MENU_COLUMNS,
): number {
  if (count <= 0) return 0
  let next = index
  if (code === 'ArrowLeft') next = index - 1
  else if (code === 'ArrowRight') next = index + 1
  else if (code === 'ArrowUp') next = index - columns
  else if (code === 'ArrowDown') next = index + columns
  if (next < 0 || next >= count) return index < 0 ? 0 : Math.min(index, count - 1)
  return next
}

// --- The open menu (one at a time, module singleton like the session) -------

/** The GameInput members the menu latches — feature-detected until the
 * manager's input.ts wiring ships them (see the header contract). */
type MenuInput = {
  state: { keys: Set<string>; firing: boolean; altFiring: boolean; actions: string[] }
  requestLock: () => void
  menuOpen?: boolean
  onMenuKey?: ((code: string) => void) | null
}

type OpenMenu = {
  session: GameSession
  input: MenuInput
  root: HTMLDivElement
  tabsEl: HTMLDivElement
  titleHintEl: HTMLSpanElement
  gridEl: HTMLDivElement
  tabEls: HTMLButtonElement[]
  cardEls: HTMLDivElement[]
  items: MenuEntry[]
  categories: string[]
  page: MenuEntry[]
  category: number
  selected: number
  onPick: (item: MenuEntry) => void
}

let menu: OpenMenu | null = null

const FONT = "600 12px/1.3 system-ui, -apple-system, sans-serif"
const CARD_BORDER = '1px solid rgba(255,255,255,0.14)'
const CARD_BORDER_ON = '1px solid rgba(120,255,160,0.95)'

export function isItemMenuOpen(): boolean {
  return menu !== null
}

/**
 * Open the catalog over the running session. Returns false when it cannot
 * (already open, no DOM, empty placeable catalog still opens — with an
 * "unavailable" line so the player learns why the key did something empty).
 * The pick callback fires once per selection; the menu closes itself after.
 */
export function openItemMenu(
  session: GameSession,
  onPick: (item: MenuEntry) => void,
): boolean {
  if (menu || typeof document === 'undefined') return false
  const catalog = placeableCatalog()
  const items: MenuEntry[] = [...catalog, ...OPENING_ENTRIES]
  const categories = catalogMenuCategories(items)

  // Latch input FIRST (flag before the lock release, so the session's
  // pointerlockchange guard already reads the menu as open when it fires).
  const input = session.input as unknown as MenuInput
  input.state.keys.clear()
  input.state.firing = false
  input.state.altFiring = false
  input.state.actions.length = 0
  input.menuOpen = true
  input.onMenuKey = handleMenuKey
  // The catalog is open — the "I — place furniture" micro-hint is moot.
  session.hud.hintSeen?.('catalog')

  const root = document.createElement('div')
  root.id = 'boots-item-menu'
  // One notch above the HUD (2147483646) — the backdrop must both paint
  // over it and take pointer events the HUD deliberately refuses.
  root.style.cssText =
    'position:absolute;inset:0;z-index:2147483647;pointer-events:auto;user-select:none;' +
    'display:flex;align-items:center;justify-content:center;background:rgba(8,10,12,0.6)'
  // Backdrop click = close (clicks on the panel don't bubble to the root).
  root.addEventListener('pointerdown', (e) => {
    if (e.target === root) closeItemMenu()
  })

  const panel = document.createElement('div')
  panel.style.cssText =
    `display:flex;flex-direction:column;gap:14px;width:min(${MENU_PANEL_MAX_WIDTH_PX}px,94vw);max-height:min(86vh,860px);` +
    `box-sizing:border-box;padding:20px 22px;border-radius:14px;background:rgba(16,18,22,0.94);color:#fff;font:${FONT};` +
    'border:1px solid rgba(255,255,255,0.12);box-shadow:0 12px 48px rgba(0,0,0,0.55)'
  root.appendChild(panel)

  const title = document.createElement('div')
  title.style.cssText = 'display:flex;align-items:baseline;gap:10px'
  const titleText = document.createElement('span')
  titleText.textContent = 'ITEM CATALOG'
  titleText.style.cssText = 'font-size:18px;letter-spacing:0.18em'
  const titleHint = document.createElement('span')
  titleHint.textContent = 'click or arrows + Enter · Q/E tabs · I close'
  titleHint.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.55)'
  title.appendChild(titleText)
  title.appendChild(titleHint)
  panel.appendChild(title)

  const tabs = document.createElement('div')
  tabs.style.cssText =
    'display:flex;gap:8px;flex-wrap:nowrap;overflow-x:auto;flex-shrink:0;padding-bottom:5px'
  panel.appendChild(tabs)

  const grid = document.createElement('div')
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${MENU_COLUMNS},minmax(0,1fr));gap:12px;overflow-y:auto;padding:3px`
  panel.appendChild(grid)

  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.textContent = 'Catalog unavailable in this host build.'
    empty.style.cssText = 'color:rgba(255,255,255,0.5);padding:18px;text-align:center'
    panel.appendChild(empty)
  }

  const tabEls: HTMLButtonElement[] = categories.map((category, index) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.textContent = `${index + 1} ${category}`
    tab.style.cssText =
      `font:${FONT};font-size:13px;letter-spacing:0.06em;padding:7px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;` +
      'background:transparent;color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.2)'
    tab.addEventListener('click', () => setCategory(index))
    tabs.appendChild(tab)
    return tab
  })

  session.container.appendChild(root)

  menu = {
    session,
    input,
    root,
    tabsEl: tabs,
    titleHintEl: titleHint,
    gridEl: grid,
    tabEls,
    cardEls: [],
    items,
    categories,
    page: [],
    category: 0,
    selected: 0,
    onPick,
  }
  const defaultCategory = catalog[0]?.category
  const defaultIndex = defaultCategory ? categories.indexOf(defaultCategory) : -1
  setCategory(defaultIndex >= 0 ? defaultIndex : 0)

  // Render the bundled fallback immediately, then replace it in-place when
  // the API responds. The menu never flashes closed or steals pointer lock.
  void ensureFullCatalog().then(() => {
    if (menu?.root === root) refreshOpenMenuCatalog()
  })

  if (document.pointerLockElement) document.exitPointerLock()
  return true
}

function refreshOpenMenuCatalog(): void {
  const open = menu
  if (!open) return
  const previousCategory = open.categories[open.category]
  open.items = [...placeableCatalog(), ...OPENING_ENTRIES]
  open.categories = catalogMenuCategories(open.items)
  open.tabsEl.replaceChildren()
  open.tabEls = open.categories.map((category, index) => {
    const tab = document.createElement('button')
    tab.type = 'button'
    tab.textContent = `${index + 1} ${category}`
    tab.style.cssText =
      `font:${FONT};font-size:13px;letter-spacing:0.06em;padding:7px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;` +
      'background:transparent;color:rgba(255,255,255,0.75);border:1px solid rgba(255,255,255,0.2)'
    tab.addEventListener('click', () => setCategory(index))
    open.tabsEl.appendChild(tab)
    return tab
  })
  open.titleHintEl.textContent = 'click or arrows + Enter · Q/E tabs · I close'
  const preserved = previousCategory ? open.categories.indexOf(previousCategory) : -1
  setCategory(preserved >= 0 ? preserved : 0)
}

/**
 * Close the menu (no-op when closed; returns whether it WAS open — the
 * session's Esc fallback wiring keys off that). `relock` re-engages the
 * pointer lock for the resuming game; session teardown passes false (the
 * input is detaching anyway).
 */
export function closeItemMenu(relock = true): boolean {
  const open = menu
  if (!open) return false
  menu = null
  open.input.menuOpen = false
  open.input.onMenuKey = null
  open.root.remove()
  if (relock) open.input.requestLock()
  return true
}

function setCategory(index: number): void {
  const open = menu
  if (!open) return
  open.category = Math.max(0, Math.min(index, open.categories.length - 1))
  const category = open.categories[open.category]
  open.page = category ? categoryPage(open.items, category) : []
  open.selected = 0
  for (let i = 0; i < open.tabEls.length; i++) {
    const on = i === open.category
    const tab = open.tabEls[i]!
    tab.style.background = on ? 'rgba(120,255,160,0.16)' : 'transparent'
    tab.style.color = on ? '#fff' : 'rgba(255,255,255,0.75)'
    tab.style.borderColor = on ? 'rgba(120,255,160,0.7)' : 'rgba(255,255,255,0.2)'
    if (on) tab.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
  rebuildGrid()
}

/** Card DOM rebuilt per open/tab switch only — never per frame. */
function rebuildGrid(): void {
  const open = menu
  if (!open) return
  open.gridEl.replaceChildren()
  open.cardEls = open.page.map((item, index) => {
    const card = document.createElement('div')
    card.style.cssText =
      'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px 8px;' +
      `min-height:128px;border-radius:10px;cursor:pointer;background:rgba(255,255,255,0.05);border:${CARD_BORDER}`
    const img = document.createElement('img')
    img.src = item.thumbnail
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    // Thumbnails are public-CORS Supabase PNGs; a failed image just leaves
    // the name label (no retry, no placeholder churn).
    img.style.cssText =
      `width:clamp(${MENU_THUMB_MIN_PX}px,9vw,${MENU_THUMB_MAX_PX}px);` +
      `height:clamp(${MENU_THUMB_MIN_PX}px,9vw,${MENU_THUMB_MAX_PX}px);object-fit:contain;pointer-events:none`
    img.addEventListener('error', () => img.remove())
    const label = document.createElement('div')
    label.textContent = item.name
    label.style.cssText =
      'font-size:clamp(11px,1vw,14px);color:rgba(255,255,255,0.9);text-align:center;line-height:1.3;' +
      'max-height:2.6em;overflow:hidden'
    card.appendChild(img)
    card.appendChild(label)
    card.addEventListener('click', () => pick(index))
    card.addEventListener('pointerenter', () => setSelected(index))
    open.gridEl.appendChild(card)
    return card
  })
  setSelected(0)
}

function setSelected(index: number): void {
  const open = menu
  if (!open || open.cardEls.length === 0) return
  const previous = open.cardEls[open.selected]
  if (previous) previous.style.border = CARD_BORDER
  open.selected = Math.max(0, Math.min(index, open.cardEls.length - 1))
  const card = open.cardEls[open.selected]
  if (card) {
    card.style.border = CARD_BORDER_ON
    card.scrollIntoView({ block: 'nearest' })
  }
}

function pick(index: number): void {
  const open = menu
  const item = open?.page[index]
  if (!open || !item) return
  const onPick = open.onPick
  // Close FIRST (restores the latch + lock inside the click/Enter user
  // gesture, which pointer-lock re-acquisition needs), then hand over.
  closeItemMenu()
  onPick(item)
}

/** Keydown router — input.ts calls this instead of touching game state
 * while `menuOpen` (every code arrives here already swallowed). */
function handleMenuKey(code: string): void {
  const open = menu
  if (!open) return
  if (code === 'KeyI') {
    closeItemMenu()
    return
  }
  if (code === 'Enter' || code === 'Space' || code === 'NumpadEnter') {
    pick(open.selected)
    return
  }
  if (code.startsWith('Arrow')) {
    setSelected(moveSelection(open.selected, code, open.cardEls.length))
    return
  }
  if (code === 'KeyQ' || code === 'KeyE' || code === 'Tab') {
    const step = code === 'KeyQ' ? -1 : 1
    const count = open.categories.length
    if (count > 0) setCategory((open.category + step + count) % count)
    return
  }
  if (code.startsWith('Digit')) {
    const index = Number(code.slice(5)) - 1
    if (index >= 0 && index < open.categories.length) setCategory(index)
  }
}
