/**
 * QA — THE REBRAND, IN THE BROWSER.
 *
 * The ask was "keep the name but all logos and images … maybe animated gif
 * during loading above the bar". Three of those words are checkable and none of
 * them are checkable from a unit test, because all three live in the DOM the
 * host and the browser build between them:
 *
 *  1. ANIMATED. A static WebP and an animated one are the same MIME type, the
 *     same `<img>`, and the same `complete === true`. So this fetches the asset
 *     bytes and counts ANMF chunks in the RIFF container: >1 frame or it is not
 *     animated, whatever it looks like in a screenshot. (This is the check that
 *     would catch the real regression — Next's image OPTIMIZER flattens
 *     animation, and the day someone routes this asset through `next/image`
 *     instead of a raw `.src` URL, the loader silently becomes a still.)
 *
 *  2. ABOVE THE BAR. Compared as geometry — hero.bottom ≤ bar.top — in BOTH
 *     loading surfaces: drop-gate.tsx's share-link veil and hud.ts's in-game
 *     card. A hero that renders below the bar, or off-screen, passes every
 *     other check here.
 *
 *  3. THE RAIL ENTRY STILL RESOLVES. `img[src*="boots-icon"]` is the only thing
 *     in the rail's DOM that names Boots (the host renders the entry as a 20×20
 *     icon with no text and no aria-label), so qa-boots-roster.mjs depends on
 *     that filename surviving any art change. This asserts it decodes at its
 *     real size, not just that the element exists.
 *
 *   node docs/qa/qa-boots-brand.mjs                 # dev server on :3002
 *   SCENE=<id> HEADED=1 node docs/qa/qa-boots-brand.mjs
 *
 * HEADED matters for surface 2b: the in-game card is only up while the session's
 * real entry work runs, and headless renders at ~5 fps, which changes how long
 * that is. The script polls rather than sleeping a fixed time, and reports
 * `card seen` honestly if the card came and went before the first sample.
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? 'projectahyvrpvr3g1juxpr'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext('/tmp/boots-brand-qa-profile', {
  args: ['--window-size=1440,900'],
  headless: !process.env.HEADED,
  viewport: { height: 900, width: 1440 },
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
const fails = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
const ok = (label, cond, detail = '') => {
  if (!cond) fails.push(label)
  log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`)
}

/** Hero + bar geometry in a surface, or null if the hero is not mounted. */
const surface = (barSelector) =>
  page.evaluate((sel) => {
    const img = document.querySelector('img[data-boots-hero]')
    const bar = document.querySelector(sel)
    if (!img || !bar) return null
    const h = img.getBoundingClientRect()
    const b = bar.getBoundingClientRect()
    return {
      bar: { bottom: b.bottom, top: b.top, width: b.width },
      complete: img.complete,
      hero: { bottom: h.bottom, height: h.height, top: h.top, width: h.width },
      natural: [img.naturalWidth, img.naturalHeight],
      src: img.src,
    }
  }, barSelector)

log(`goto ${URL}`)
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log(e.message))

// ── 1. the share-link veil ──────────────────────────────────────────────────
// POLLED, not slept. Two clocks make a fixed wait wrong in both directions: a
// cold dev server compiles the route for many seconds before the plugin mounts
// anything at all, and once the census settles the gate hides the bar
// (`display:none` → an all-zero rect) to show JUMP IN. So this waits for the
// window where BOTH are on screen, and requires the bar to have real width.
log('\n=== the share-link veil (drop-gate.tsx) ===')
let veil = null
for (let i = 0; i < 120 && !veil; i++) {
  await page.waitForTimeout(500)
  const s = await surface('[data-boots-drop-bar]')
  if (s?.bar.width > 0) veil = s
}
ok('the veil mounts the hero above its bar', !!veil)
if (veil) {
  ok('the hero decoded', veil.complete && veil.natural[0] > 0, `natural ${veil.natural.join('×')}`)
  ok('the hero is ABOVE the bar', veil.hero.bottom <= veil.bar.top + 1,
    `hero.bottom ${Math.round(veil.hero.bottom)} vs bar.top ${Math.round(veil.bar.top)}`)
  ok('the hero is on screen at a real size', veil.hero.width > 200 && veil.hero.height > 80,
    `${Math.round(veil.hero.width)}×${Math.round(veil.hero.height)}`)
  // Aspect: a `cover` crop at a fixed height ate the plate's hazard rail in the
  // first pass, and nothing but the ratio would have caught it.
  const ratio = veil.hero.width / veil.hero.height
  const natural = veil.natural[0] / veil.natural[1]
  ok('the hero is undistorted and uncropped', Math.abs(ratio - natural) < 0.05,
    `rendered ${ratio.toFixed(2)} vs natural ${natural.toFixed(2)}`)

  // ── ANIMATED, from the bytes ──────────────────────────────────────────────
  const anim = await page.evaluate(async (src) => {
    const buf = new Uint8Array(await (await fetch(src)).arrayBuffer())
    const tag = (i) => String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3])
    if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') return { error: 'not a WebP' }
    let off = 12
    let frames = 0
    let hasAnim = false
    while (off + 8 <= buf.length) {
      const fourcc = tag(off)
      const size = buf[off + 4] | (buf[off + 5] << 8) | (buf[off + 6] << 16) | (buf[off + 7] << 24)
      if (fourcc === 'ANIM') hasAnim = true
      if (fourcc === 'ANMF') frames++
      off += 8 + size + (size % 2)
    }
    return { bytes: buf.length, frames, hasAnim }
  }, veil.src)
  log(`  bytes: ${JSON.stringify(anim)}`)
  ok('the loader is a real ANIMATED WebP', anim.hasAnim === true && anim.frames > 1,
    `ANIM=${anim.hasAnim} frames=${anim.frames}`)
  ok('the loader is served raw, not through the image optimizer',
    !/\/_next\/image/.test(veil.src), veil.src.slice(-58))
}

// ── 2. the in-game loading card ─────────────────────────────────────────────
log('\n=== the in-game loading card (hud.ts) ===')
// Same reasoning: wait for the swap the gate performs when the census settles,
// rather than for a number of seconds that is only true on a warm server.
let jumped = false
for (let i = 0; i < 60 && !jumped; i++) {
  await page.waitForTimeout(500)
  jumped = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(
      (x) => /jump in/i.test(x.textContent || '') && x.offsetParent !== null,
    )
    b?.click()
    return !!b
  })
}
ok('JUMP IN was there to click', jumped)
let card = null
for (let i = 0; i < 16 && !card; i++) {
  await page.waitForTimeout(i === 0 ? 200 : 350)
  card = await surface('[data-boots-veil-bar]')
}
ok('the card mounts the hero', !!card)
if (card) {
  ok('the hero is ABOVE the card bar', card.hero.bottom <= card.bar.top + 1,
    `hero.bottom ${Math.round(card.hero.bottom)} vs bar.top ${Math.round(card.bar.top)}`)
  ok('the card hero fills the card width', card.hero.width > 300, `${Math.round(card.hero.width)}px`)
  ok('the card hero is undistorted',
    Math.abs(card.hero.width / card.hero.height - card.natural[0] / card.natural[1]) < 0.05)
} else {
  log('  (the card came and went before the first sample — HEADED=1 slows it enough to see)')
}

// ── 3. the rail entry + the panel header ────────────────────────────────────
// Reloaded WITH the drop marker on purpose: a bare `/scene/<id>` never loads the
// plugin at all, so there would be no rail entry to look at (same reason
// qa-boots-roster.mjs keeps the marker). The veil is then lifted out of the DOM
// rather than clicked through — it is an opaque overlay, and `veil.remove()` is
// exactly what the gate's own cleanup does.
log('\n=== the rail entry + the panel header ===')
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log(e.message))
await page.waitForTimeout(14000)
await page.evaluate(() => document.querySelector('[data-boots-drop-veil]')?.remove())
const badge = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img[src*="boots-icon"]')]
  return imgs.map((img) => {
    const r = img.getBoundingClientRect()
    return { complete: img.complete, natural: [img.naturalWidth, img.naturalHeight], rendered: [Math.round(r.width), Math.round(r.height)] }
  })
})
log(`  entries: ${JSON.stringify(badge)}`)
ok('the rail entry resolves by filename (roster QA depends on it)', badge.length > 0)
ok('the badge decoded', badge.every((b) => b.complete && b.natural[0] > 0))
ok('the badge is square (it is cropped for 20px)', badge.every((b) => b.natural[0] === b.natural[1]))
if (badge[0]) {
  await page.evaluate(() => document.querySelector('img[src*="boots-icon"]')?.closest('button')?.click())
  await page.waitForTimeout(2200)
  const header = await page.evaluate(() => document.querySelectorAll('img[src*="boots-icon"]').length)
  ok('the panel header carries the badge too', header >= 2, `${header} on screen`)
}

log('\n=== VERDICT ===')
log(`  failed assertions : ${fails.length}${fails.length ? ` → ${fails.join('; ')}` : ''}`)
log(`  page errors       : ${errors.length}`)
for (const e of errors.slice(0, 5)) log(`    ${e}`)
log(`  BRAND WIRED: ${fails.length === 0 && errors.length === 0}`)
await browser.close()
process.exit(fails.length === 0 && errors.length === 0 ? 0 : 1)
