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
 * `item` nodes only from the sidebar Save button.
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
 *   (pendingDecision keeps the placed items). I is the in-menu close key.
 */

/** The bundled catalog rows; the live host types this AssetInput & {tool?}. */
export type CatalogEntry = AssetInput & { tool?: string }

/** Cards per category tab — a hard DOM cap, not pagination (v1). */
export const MENU_CATEGORY_CAP = 32
/** Fixed grid columns — keyboard Up/Down move by exactly one row. */
export const MENU_COLUMNS = 4

/** The bundled system catalog, defensively: under bun test the editor
 * package is a zustand-shaped stub without CATALOG_ITEMS. */
const BUNDLED: readonly CatalogEntry[] = Array.isArray(
  (editorPkg as { CATALOG_ITEMS?: unknown }).CATALOG_ITEMS,
)
  ? ((editorPkg as { CATALOG_ITEMS: CatalogEntry[] }).CATALOG_ITEMS as CatalogEntry[])
  : []

/**
 * v1 scope filter — pure, exported for tests: floor-standing GLB items
 * only. `attachTo` items (wall/ceiling/wall-side) need host attachment
 * frames the game does not model, and `tool` rows are editor affordances,
 * not placeable assets.
 */
export function placeableCatalog(
  items: readonly CatalogEntry[] = BUNDLED,
): CatalogEntry[] {
  return items.filter((item) => !item.attachTo && !item.tool)
}

/** Distinct categories in first-appearance order — the tab row. */
export function catalogCategories(items: readonly CatalogEntry[]): string[] {
  const seen: string[] = []
  for (const item of items) {
    if (!seen.includes(item.category)) seen.push(item.category)
  }
  return seen
}

/** One tab's visible cards (first CAP of the category, catalog order). */
export function categoryPage(
  items: readonly CatalogEntry[],
  category: string,
  cap = MENU_CATEGORY_CAP,
): CatalogEntry[] {
  const page: CatalogEntry[] = []
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
  gridEl: HTMLDivElement
  tabEls: HTMLButtonElement[]
  cardEls: HTMLDivElement[]
  items: CatalogEntry[]
  categories: string[]
  page: CatalogEntry[]
  category: number
  selected: number
  onPick: (item: CatalogEntry) => void
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
  onPick: (item: CatalogEntry) => void,
): boolean {
  if (menu || typeof document === 'undefined') return false
  const items = placeableCatalog()
  const categories = catalogCategories(items)

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
    'display:flex;flex-direction:column;gap:10px;width:min(720px,88%);max-height:78%;' +
    `padding:14px 16px;border-radius:10px;background:rgba(16,18,22,0.94);color:#fff;font:${FONT};` +
    'border:1px solid rgba(255,255,255,0.12);box-shadow:0 12px 48px rgba(0,0,0,0.55)'
  root.appendChild(panel)

  const title = document.createElement('div')
  title.style.cssText = 'display:flex;align-items:baseline;gap:10px'
  const titleText = document.createElement('span')
  titleText.textContent = 'ITEM CATALOG'
  titleText.style.cssText = 'font-size:14px;letter-spacing:0.18em'
  const titleHint = document.createElement('span')
  titleHint.textContent = 'click or arrows + Enter · 1-5 tabs · I close'
  titleHint.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.45)'
  title.appendChild(titleText)
  title.appendChild(titleHint)
  panel.appendChild(title)

  const tabs = document.createElement('div')
  tabs.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap'
  panel.appendChild(tabs)

  const grid = document.createElement('div')
  grid.style.cssText = `display:grid;grid-template-columns:repeat(${MENU_COLUMNS},1fr);gap:8px;overflow-y:auto;padding:2px`
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
      `font:${FONT};letter-spacing:0.06em;padding:5px 10px;border-radius:999px;cursor:pointer;` +
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
  setCategory(0)

  if (document.pointerLockElement) document.exitPointerLock()
  return true
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
      'display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 6px;' +
      `border-radius:8px;cursor:pointer;background:rgba(255,255,255,0.05);border:${CARD_BORDER}`
    const img = document.createElement('img')
    img.src = item.thumbnail
    img.alt = ''
    img.loading = 'lazy'
    img.draggable = false
    // Thumbnails are public-CORS Supabase PNGs; a failed image just leaves
    // the name label (no retry, no placeholder churn).
    img.style.cssText = 'width:72px;height:72px;object-fit:contain;pointer-events:none'
    img.addEventListener('error', () => img.remove())
    const label = document.createElement('div')
    label.textContent = item.name
    label.style.cssText =
      'font-size:11px;color:rgba(255,255,255,0.85);text-align:center;line-height:1.25;' +
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
