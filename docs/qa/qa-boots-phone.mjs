/**
 * QA — CAN A PHONE PLAY BOOTS? (the one-link drop, on a touch device)
 *
 * The owner's cofounder opened a `?boots=drop` lobby link on an iPhone, signed
 * in, and reported "nothing really like joining a game". The first run of this
 * script found what that was: the drop gate armed, the tap DID enter the game —
 * and then the session ran windowed under the host editor's chrome with no
 * input source at all, because a phone has no pointer lock, no div fullscreen
 * and no keyboard. A live game nobody could steer.
 *
 * So this reproduces a phone as faithfully as a desktop harness can and then
 * tries to PLAY:
 *
 *   - iPhone viewport + touch + mobile UA (device descriptor)
 *   - THE APIS iOS SAFARI DOES NOT HAVE, deleted before any page script runs:
 *     Element.requestFullscreen, document.exitFullscreen, requestPointerLock,
 *     exitPointerLock. Every call Boots makes on those is optional-chained and
 *     this is the only way to prove it.
 *   - Real touch, through CDP (Input.dispatchTouchEvent): trusted pointer
 *     events with pointerType 'touch', multi-touch capable — no synthetic
 *     dispatch, because the whole question is whether the real lane works.
 *
 * It then reports, as lines of output rather than a screenshot: did the game
 * enter, did the canvas get promoted over the host chrome, is the thumb layer
 * mounted, and does a drag turn the camera / the stick walk the player / FIRE
 * shoot / the hotbar switch weapons.
 *
 *   SCENE=… ENGINE=chromium|webkit node qa-boots-phone.mjs
 */
import { chromium, devices, webkit } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const ENGINE = process.env.ENGINE ?? 'chromium'
const PROFILE = `/tmp/boots-phone-profile-${ENGINE}`
const SHOT = process.env.SHOT ?? '/tmp/boots-phone'
const log = (...a) => console.log(...a)

const phone = devices['iPhone 13 Pro']
const engine = ENGINE === 'webkit' ? webkit : chromium

const browser = await engine.launchPersistentContext(PROFILE, {
  ...phone,
  headless: !process.env.HEADED,
  ...(ENGINE === 'chromium' ? { args: ['--disable-features=WebGPU'] } : {}),
})
const page = browser.pages()[0] ?? (await browser.newPage())

// The iOS API surface: no fullscreen for a div, no pointer lock at all.
await page.addInitScript(() => {
  for (const [proto, prop] of [
    [Element.prototype, 'requestFullscreen'],
    [Element.prototype, 'webkitRequestFullscreen'],
    [Document.prototype, 'exitFullscreen'],
    [HTMLElement.prototype, 'requestPointerLock'],
    [Element.prototype, 'requestPointerLock'],
    [Document.prototype, 'exitPointerLock'],
  ]) {
    try {
      delete proto[prop]
    } catch {}
  }
  Object.defineProperty(Document.prototype, 'fullscreenEnabled', {
    configurable: true,
    get: () => false,
  })
  Object.defineProperty(Document.prototype, 'fullscreenElement', {
    configurable: true,
    get: () => null,
  })
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get: () => null,
  })
  window.__phoneErrors = []
  window.addEventListener('error', (e) => window.__phoneErrors.push(String(e.message).slice(0, 200)))
})

const errors = []
page.on('pageerror', (e) => errors.push('[pageerror] ' + String(e).slice(0, 300)))
page.on('console', (m) => {
  const t = m.text()
  if (/boots|error|Error/i.test(t)) log('  [console]', t.slice(0, 200))
})

// ── real touch, through the browser's own input pipeline ─────────────────────
const cdp = ENGINE === 'chromium' ? await browser.newCDPSession(page) : null
const touchPoints = new Map()
async function touch(type, points) {
  if (!cdp) throw new Error('touch driving needs chromium (CDP)')
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points })
}
const down = async (id, x, y) => {
  touchPoints.set(id, { x, y, id })
  await touch('touchStart', [...touchPoints.values()])
}
const move = async (id, x, y) => {
  touchPoints.set(id, { x, y, id })
  await touch('touchMove', [...touchPoints.values()])
}
const up = async (id) => {
  touchPoints.delete(id)
  await touch('touchEnd', [...touchPoints.values()])
}
/** A finger that lands, drags in `steps`, then lifts. */
async function drag(id, from, to, steps = 10, holdMs = 16) {
  await down(id, from[0], from[1])
  for (let i = 1; i <= steps; i++) {
    await move(id, from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps)
    await page.waitForTimeout(holdMs)
  }
  await up(id)
}

/** What the page shows, in the words the gate and the touch layer use. */
const survey = () =>
  page.evaluate(() => {
    const texts = [...document.querySelectorAll('button')].map((b) =>
      (b.textContent || '').trim().slice(0, 40),
    )
    const veil = [...document.body.children].find(
      (el) =>
        el instanceof HTMLElement &&
        getComputedStyle(el).position === 'fixed' &&
        getComputedStyle(el).zIndex === '9999',
    )
    const promoted = document.querySelector('[data-boots-fake-fullscreen]')
    const box = promoted?.getBoundingClientRect()
    const mid = document.elementFromPoint(window.innerWidth / 2, 26)
    return {
      apis: {
        pointerLock: typeof HTMLCanvasElement.prototype.requestPointerLock,
        fullscreen: typeof Element.prototype.requestFullscreen,
        touch: navigator.maxTouchPoints,
        coarse: window.matchMedia('(pointer: coarse)').matches,
      },
      buttons: texts.filter(Boolean),
      canvases: document.querySelectorAll('canvas').length,
      dropVeil: veil ? getComputedStyle(veil).backgroundColor : null,
      gameVeil: Boolean(document.querySelector('[data-boots-veil]')),
      phase: globalThis.__boots?.state?.()?.phase ?? null,
      reentry: Boolean(document.querySelector('[data-boots-reentry]')),
      search: location.search,
      bootsApi: Boolean(globalThis.__boots),
      // The phone-specific lanes.
      fakeFullscreen: promoted
        ? {
            covers:
              Math.abs(box.left) <= 1 &&
              Math.abs(box.top) <= 1 &&
              Math.abs(box.width - window.innerWidth) <= 2 &&
              Math.abs(box.height - window.innerHeight) <= 2,
            rect: [Math.round(box.width), Math.round(box.height)],
          }
        : null,
      touchLayer: Boolean(document.querySelector('[data-boots-touch]')),
      touchButtons: [...document.querySelectorAll('[data-boots-touch-button]')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map((el) => el.dataset.bootsTouchButton),
      hudCompact: document.getElementById('boots-hud')?.dataset.bootsHudCompact ?? null,
      // HOST FURNITURE STILL INSIDE THE PROMOTED BOX. Everything outside the
      // container went behind it; whatever the editor renders as a child of the
      // canvas host (the compass dial, for one) rides along and is painted over
      // the game. Reported with rects so a collision with the thumb clusters is
      // visible as numbers, not just in a screenshot.
      hostOverlays: promoted
        ? [...promoted.children]
            .filter(
              (el) =>
                el instanceof HTMLElement &&
                el.tagName !== 'CANVAS' &&
                !el.dataset.bootsTouch &&
                el.id !== 'boots-hud' &&
                !el.querySelector('canvas') &&
                el.getBoundingClientRect().width > 0,
            )
            .map((el) => {
              const r = el.getBoundingClientRect()
              return {
                tag: el.tagName,
                cls: String(el.className || '').slice(0, 60),
                text: (el.textContent || '').trim().slice(0, 24),
                rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
              }
            })
        : null,
      // The HUD readouts that used to sit under the thumbs.
      hudRects: Object.fromEntries(
        ['health', 'weapon'].map((k) => {
          const el = [...(document.getElementById('boots-hud')?.children ?? [])].find((c) =>
            k === 'health' ? /^\d+$/.test((c.textContent || '').trim()) : /·|\(Q\)/.test(c.textContent || ''),
          )
          if (!el) return [k, null]
          const r = el.getBoundingClientRect()
          return [k, [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]]
        }),
      ),
      // What owns the top of the screen: host chrome would mean the game is
      // still buried, whatever the phase says.
      // WHAT ELSE IS PAINTED OVER THE GAME. The promoted container hides host
      // chrome that sits behind it in the stacking order, but a `position:fixed`
      // overlay with a comparable z-index still shows through (the editor's
      // compass dial, bottom-left, in the first phone screenshots). Reported as
      // the element chain under a few sample points plus every very-high-z
      // element on the page, so the selector to stand down is discoverable.
      paintedOver: [
        [38, window.innerHeight - 46],
        [window.innerWidth - 38, window.innerHeight - 46],
        [window.innerWidth - 38, 46],
      ].map(([x, y]) => {
        let el = document.elementFromPoint(x, y)
        const chain = []
        for (let i = 0; el && i < 4; i++, el = el.parentElement) {
          const cs = getComputedStyle(el)
          chain.push(
            `${el.tagName}${el.id ? '#' + el.id : ''}${String(el.className || '')
              .split(' ')
              .filter(Boolean)
              .slice(0, 3)
              .map((c) => '.' + c)
              .join('')}[${cs.position}/z${cs.zIndex}]`,
          )
        }
        return { at: [x, y], chain }
      }),
      highZ: [...document.querySelectorAll('body *')]
        .filter((el) => {
          const cs = getComputedStyle(el)
          const z = Number(cs.zIndex)
          return (
            Number.isFinite(z) &&
            z > 1000000 &&
            cs.visibility !== 'hidden' &&
            cs.display !== 'none' &&
            el.getBoundingClientRect().width > 0
          )
        })
        .map((el) => {
          const r = el.getBoundingClientRect()
          const cs = getComputedStyle(el)
          return `${el.tagName}${el.id ? '#' + el.id : ''}${
            el.dataset.bootsTouch ? '[boots-touch]' : ''
          } z${cs.zIndex} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`
        }),
      topOfScreen: mid ? `${mid.tagName}${mid.dataset?.bootsTouch ? '[touch]' : ''}` : null,
      topInsideSession: Boolean(promoted && mid && promoted.contains(mid)),
    }
  })

const pose = () => page.evaluate(() => globalThis.__boots?.cameraPose?.() ?? null)
const gameState = () =>
  page.evaluate(() => {
    const s = globalThis.__boots?.state?.() ?? {}
    return { weapon: s.weapon, health: s.health, placed: s.placed?.length ?? 0, clip: s.clip ?? {} }
  })
const rectOf = (code) =>
  page.evaluate((c) => {
    const el = document.querySelector(`[data-boots-touch-button="${c}"]`)
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1) return null
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
  }, code)

const yawOf = (p) => (p ? Math.round(Math.atan2(p.quaternion[1], p.quaternion[3]) * 2 * 57.2958) : null)
const posOf = (p) => (p ? p.position.map((v) => Math.round(v * 100) / 100) : null)

log(`engine=${ENGINE} goto ${URL}`)
await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 240000 }).catch((e) => log('goto:', e.message))

for (const wait of [3000, 6000, 12000]) {
  await page.waitForTimeout(wait)
  log(`\n— after ${wait}ms —`)
  log(JSON.stringify(await survey(), null, 1))
}
await page.screenshot({ path: `${SHOT}-1-arrival.png` }).catch(() => {})

// ── TAP JUMP IN, the way a thumb would ───────────────────────────────────────
const jumpIn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /jump in/i.test(x.textContent || ''))
  if (!b) return null
  const r = b.getBoundingClientRect()
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
})
log(`\nJUMP IN at ${JSON.stringify(jumpIn)}`)
if (jumpIn) {
  // A real tap: the drop gate's button is a DOM button, so this must reach it
  // as a click through the browser's own touch→click compatibility path.
  await page.touchscreen.tap(jumpIn.x, jumpIn.y)
}

for (const wait of [2000, 6000, 10000]) {
  await page.waitForTimeout(wait)
  log(`\n— ${wait}ms after the tap —`)
  log(JSON.stringify(await survey(), null, 1))
}
await page.screenshot({ path: `${SHOT}-2-after-tap.png` }).catch(() => {})

// ── CAN TWO THUMBS PLAY IT? ──────────────────────────────────────────────────
const W = phone.viewport.width
const H = phone.viewport.height
log(`\n=== thumb probes (viewport ${W}×${H}) ===`)

// 1. LOOK — drag across the right half, outside every button.
const beforeLook = await pose()
await drag(1, [W * 0.62, H * 0.34], [W * 0.30, H * 0.34], 12)
await page.waitForTimeout(400)
const afterLook = await pose()
log(`look: yaw ${yawOf(beforeLook)}° → ${yawOf(afterLook)}°  (drag ${Math.round(W * 0.32)}px left)`)

// 2. WALK — hold the stick forward for ~1s.
const beforeWalk = await pose()
await down(2, W * 0.24, H * 0.80)
for (let i = 0; i < 24; i++) {
  await move(2, W * 0.24, H * 0.80 - 70)
  await page.waitForTimeout(40)
}
await up(2)
await page.waitForTimeout(300)
const afterWalk = await pose()
const walked =
  beforeWalk && afterWalk
    ? Math.round(
        Math.hypot(
          afterWalk.position[0] - beforeWalk.position[0],
          afterWalk.position[2] - beforeWalk.position[2],
        ) * 100,
      ) / 100
    : null
log(`walk: ${JSON.stringify(posOf(beforeWalk))} → ${JSON.stringify(posOf(afterWalk))}  moved ${walked} m`)

// 3. WEAPON SWITCH — the session opens on the builder, so tapping the BUILD chip
// proves nothing. Tap KNIFE (always owned, always a change), then come back to
// BUILD so the FIRE probe below still has a piece to place.
const tapChip = async (id, code) => {
  const chip = await rectOf(code)
  if (!chip) return null
  await down(id, chip.x, chip.y)
  await page.waitForTimeout(120)
  await up(id)
  await page.waitForTimeout(500)
  return chip
}
const weaponBefore = (await gameState()).weapon
const knifeChip = await tapChip(3, 'Digit1')
const weaponKnife = (await gameState()).weapon
const buildChip = await tapChip(31, 'Digit4')
const weaponBack = (await gameState()).weapon
log(`hotbar: KNIFE chip ${JSON.stringify(knifeChip)}  BUILD chip ${JSON.stringify(buildChip)}`)
log(`  weapon ${weaponBefore} → ${weaponKnife} → ${weaponBack}   (switch works: ${weaponKnife === 'knife' && weaponBack === 'builder'})`)
log(`build row now visible: ${JSON.stringify((await survey()).touchButtons)}`)

// 4. FIRE — hold the trigger for half a second.
const fire = await rectOf('FIRE')
const beforeFire = await gameState()
if (fire) {
  await down(4, fire.x, fire.y)
  await page.waitForTimeout(600)
  await up(4)
  await page.waitForTimeout(600)
}
const afterFire = await gameState()
log(`fire: button at ${JSON.stringify(fire)}`)
log(`  before ${JSON.stringify(beforeFire)}`)
log(`  after  ${JSON.stringify(afterFire)}`)

// 5. JUMP — the other hold button, checked on the Y axis.
const jump = await rectOf('Space')
const beforeJump = await pose()
let peak = beforeJump?.position[1] ?? 0
if (jump) {
  await down(5, jump.x, jump.y)
  for (let i = 0; i < 14; i++) {
    await page.waitForTimeout(40)
    const p = await pose()
    if (p) peak = Math.max(peak, p.position[1])
  }
  await up(5)
}
log(`jump: y ${Math.round((beforeJump?.position[1] ?? 0) * 100) / 100} → peak ${Math.round(peak * 100) / 100}`)

await page.screenshot({ path: `${SHOT}-3-in-game.png` }).catch(() => {})

// 6. EXIT — the ✕, which is the only way out of a phone session.
const exit = await rectOf('EXIT')
if (exit) {
  await down(6, exit.x, exit.y)
  await page.waitForTimeout(120)
  await up(6)
  await page.waitForTimeout(2500)
}
const afterExit = await survey()
log(`\nexit: tapped ${JSON.stringify(exit)} → phase ${afterExit.phase}, reentry pill ${afterExit.reentry}`)
log(`  fake fullscreen released: ${afterExit.fakeFullscreen === null}`)
log(`  touch layer gone: ${afterExit.touchLayer === false}`)
await page.screenshot({ path: `${SHOT}-4-after-exit.png` }).catch(() => {})

log(`\npage errors: ${errors.length}`)
for (const e of errors.slice(0, 8)) log(' ', e)
log('window errors:', JSON.stringify(await page.evaluate(() => window.__phoneErrors ?? [])))

await browser.close()
