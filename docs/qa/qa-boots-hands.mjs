#!/usr/bin/env node
/**
 * FIRST-PERSON HANDS QA — one page on :3002, every weapon, screenshots to LOOK at.
 *
 *   node docs/qa/qa-boots-hands.mjs                 all weapons
 *   node docs/qa/qa-boots-hands.mjs rifle,pistol    a subset
 *
 * Per weapon: give + select it, wait for the swap to settle (the support hand's
 * ready dip has finished), screenshot /tmp/boots-hands-fp-<w>.png plus a
 * -crop.png of the lower-right two thirds (the hands, at native pixels — LOOK
 * at these). For guns: ADS (right button) → -ads.png; FIRE (left button held,
 * polled every 40 ms) → -fire.png at the first sample with the index squeezed,
 * asserting peak recoil > 0.3, peak trigger > 0.5 and a held pull > 0.9 while
 * the button is down (the handle keeps per-shot peaks because a slow poll
 * misses a frame). The hands must report `external` (driven by the viewmodel
 * — same-frame shot/recoil/aim), or the run fails. Headless runs at ~3 fps
 * with dt capped 1/30, so nothing here waits a fixed time for a motion — it
 * polls the `__bootsHands()` handle (weapon-hands.tsx).
 *
 * Knobs: HEADFUL=1 · SHOT_PREFIX=/tmp/boots-hands · SCENE · BASE · PITCH (rad,
 * default −0.35: look a little down so the floor is the backdrop) · PE_ROOT ·
 * CROP=x,y,w,h (default 420,330,860,570).
 * ONE automation browser at a time on this machine: /tmp/boots-browser.lock.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const PE_ROOT = process.env.PE_ROOT ?? path.join(os.homedir(), 'Documents/GitHub/private-editor')
const require = createRequire(path.join(PE_ROOT, 'package.json'))
const { chromium } = require('playwright')

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const BASE = process.env.BASE ?? 'http://localhost:3002'
const PREFIX = process.env.SHOT_PREFIX ?? '/tmp/boots-hands'
const HEADFUL = process.env.HEADFUL === '1'
const PITCH = Number(process.env.PITCH ?? -0.35)
const CROP = (() => {
  const [x, y, width, height] = (process.env.CROP ?? '420,330,860,570').split(',').map(Number)
  return { x, y, width, height }
})()
const LOCK = '/tmp/boots-browser.lock'
const ALL = ['knife', 'pistol', 'rifle', 'minigun', 'hammer', 'builder', 'paint']
const WEAPONS = process.argv[2] ? process.argv[2].split(',') : ALL
const GUNS = new Set(['pistol', 'rifle', 'minigun'])
const T0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── browser mutex (mp-harness recipe) ─────────────────────────────────────────
let holdingLock = false
async function takeLock() {
  for (;;) {
    try {
      fs.mkdirSync(LOCK)
      fs.writeFileSync(path.join(LOCK, 'owner'), String(process.pid))
      holdingLock = true
      return
    } catch {}
    let owner = NaN
    try {
      owner = Number(fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim())
    } catch {}
    if (Number.isFinite(owner) && owner > 0) {
      let alive = true
      try {
        process.kill(owner, 0)
      } catch {
        alive = false
      }
      if (!alive) {
        log(`stale lock (pid ${owner} gone) — reclaiming`)
        fs.rmSync(LOCK, { recursive: true, force: true })
        continue
      }
      log(`browser lock held by pid ${owner}; waiting 20 s`)
    } else log('browser lock present without a live owner; waiting 20 s')
    await sleep(20000)
  }
}
function releaseLock() {
  if (!holdingLock) return
  try {
    if (fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim() === String(process.pid))
      fs.rmSync(LOCK, { recursive: true, force: true })
  } catch {}
  holdingLock = false
}
let browser = null
async function shutdown(code) {
  try {
    if (browser) await browser.close()
  } catch {}
  browser = null
  releaseLock()
  process.exit(code)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))
/** Whole-run watchdog, armed once the lock is ours (waiting for another lane's
 * browser can take minutes and must not count). */
function armWatchdog() {
  const ms = Number(process.env.WATCHDOG_MS ?? 240000)
  const watchdog = setTimeout(() => {
    console.log(JSON.stringify({ ok: false, error: `watchdog: run exceeded ${ms} ms` }))
    void shutdown(3)
  }, ms)
  watchdog.unref()
}

/** session.ts treats a LOST pointer lock/fullscreen as Esc; deny both up front. */
function installCaptureGuard() {
  try {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
  } catch {}
  const denied = () => Promise.reject(new DOMException('QA: pointer lock disabled', 'NotAllowedError'))
  try {
    Element.prototype.requestPointerLock = denied
  } catch {}
  try {
    Element.prototype.requestFullscreen = denied
  } catch {}
}

/** Poll a page predicate every `every` ms up to `timeout` ms; returns the value or null. */
async function poll(page, fn, arg, { every = 60, timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const v = await page.evaluate(fn, arg).catch(() => null)
    if (v) return v
    await sleep(every)
  }
  return null
}

let inGame = false
const summary = { ok: false, external: null, weapons: {}, failures: [], screenshots: [], consoleErrors: [], pageErrors: [], navigations: [] }

/** Full frame + a native-pixel crop of the hands region. */
async function shoot(page, base) {
  await page.screenshot({ path: `${base}.png` })
  summary.screenshots.push(`${base}.png`)
  await page.screenshot({ path: `${base}-crop.png`, clip: CROP })
  summary.screenshots.push(`${base}-crop.png`)
  return `${base}.png`
}
const NOISE = /pointer lock|PointerLock|favicon|Permissions policy|autoplay|DevTools|ERR_ABORTED/i

async function main() {
  await takeLock()
  armWatchdog()
  log(`lock taken (pid ${process.pid}); weapons: ${WEAPONS.join(',')}`)
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !HEADFUL,
    args: ['--disable-features=WebGPU', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling'],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !NOISE.test(t)) summary.consoleErrors.push(t.slice(0, 220))
  })
  page.on('pageerror', (e) => summary.pageErrors.push(String(e).slice(0, 300)))
  // A dev-server HMR full reload mid-run (another lane hot-deploying) throws the
  // page back to the editor: record it so a failure is attributed, not guessed.
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame() && inGame) summary.navigations.push({ t: +((Date.now() - T0) / 1000).toFixed(1), url: f.url() })
  })
  await page.addInitScript(installCaptureGuard)
  await page.goto(`${BASE}/scene/${SCENE}?boots=drop`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('canvas', { timeout: 90000 })
  const veilButton = page.locator('[data-boots-drop-veil] button', { hasText: /jump in/i })
  try {
    await veilButton.first().waitFor({ state: 'visible', timeout: 30000 })
    await veilButton.first().click()
  } catch {
    await page.getByRole('button', { name: /jump in/i }).first().click({ timeout: 10000 })
  }
  await page.waitForFunction(() => !!globalThis.__boots && !!globalThis.__bootsHands, null, { timeout: 60000 })
  log('in game; __bootsHands present')
  inGame = true
  // The drop veil's loading card ("lacing up your boots…") still covers the
  // view for a while: wait until it is gone before the first shot.
  const loaded = await poll(
    page,
    () => !document.querySelector('[data-boots-drop-veil]') && !/lacing up/i.test(document.body.innerText),
    null,
    { every: 250, timeout: 60000 },
  )
  log(`loading veil gone: ${!!loaded}`)
  // Look a little down so the floor is the backdrop, from wherever we spawned.
  await page.evaluate((pitch) => {
    const c = globalThis.__boots.cameraPose()
    const [x, , z] = c.position
    const st = globalThis.__bootsPlayer?.sample?.()
    globalThis.__boots.teleport(x, z, st?.yaw ?? 0, pitch)
  }, PITCH)
  await page.mouse.move(640, 450)
  // The hands must be driven by the viewmodel (exact same-frame signals).
  const first = await page.evaluate(() => globalThis.__bootsHands())
  summary.external = first?.external ?? null
  if (first?.external !== true) summary.failures.push(`hands not driven by the viewmodel (source ${first?.source ?? 'n/a'})`)

  for (const w of WEAPONS) {
    const rec = { shown: false, settled: false, shots: {} }
    summary.weapons[w] = rec
    await page.evaluate((w) => {
      const st = globalThis.__boots.state()
      st.giveWeapon?.(w)
      st.setWeapon(w)
    }, w)
    const shown = await poll(page, (w) => globalThis.__bootsHands().shown === w && globalThis.__bootsHands().rightMounted, w)
    rec.shown = !!shown
    if (!shown) {
      summary.failures.push(`${w}: hands never reported shown`)
      continue
    }
    // The draw-in + the support hand's ready dip: wait until the dip has played out.
    const settled = await poll(
      page,
      () => {
        const h = globalThis.__bootsHands()
        return h.ready === 0 && h.recoil === 0 ? h : null
      },
      null,
      { timeout: 6000 },
    )
    rec.settled = !!settled
    await sleep(250)
    const shot = await shoot(page, `${PREFIX}-fp-${w}`)
    log(`${w}: carry shot → ${shot}`)

    if (!GUNS.has(w)) continue
    // ADS (pistol/rifle have an aim pose; the minigun just steadies).
    if (w !== 'minigun') {
      await page.mouse.down({ button: 'right' })
      const aimed = await poll(page, () => (globalThis.__bootsHands().aim > 0.9 ? globalThis.__bootsHands() : null), null, {
        timeout: 5000,
      })
      rec.ads = aimed ? { aim: aimed.aim, triggerAngles: aimed.triggerAngles } : null
      await sleep(200)
      const adsShot = await shoot(page, `${PREFIX}-fp-${w}-ads`)
      await page.mouse.up({ button: 'right' })
      await poll(page, () => (globalThis.__bootsHands().aim < 0.1 ? true : null), null, { timeout: 4000 })
      log(`${w}: ads shot → ${adsShot} (aim ${aimed?.aim ?? 'n/a'})`)
    }
    // FIRE: hold the left button, poll the hands, screenshot on the squeeze.
    await page.mouse.down()
    let maxRecoil = 0
    let maxTrigger = 0
    let maxHeld = 0
    let fireShot = null
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const h = await page.evaluate(() => globalThis.__bootsHands()).catch(() => null)
      if (h) {
        maxRecoil = Math.max(maxRecoil, h.recoil, h.peakRecoil ?? 0)
        maxTrigger = Math.max(maxTrigger, h.trigger, h.peakTrigger ?? 0)
        maxHeld = Math.max(maxHeld, h.held ?? 0)
        if (!fireShot && h.trigger > 0.3) fireShot = await shoot(page, `${PREFIX}-fp-${w}-fire`)
      }
      if (fireShot && maxRecoil > 0.3 && maxTrigger > 0.5 && maxHeld > 0.9) break
      await sleep(40)
    }
    await page.mouse.up()
    rec.shots = { maxRecoil: +maxRecoil.toFixed(3), maxTrigger: +maxTrigger.toFixed(3), maxHeld: +maxHeld.toFixed(3), fireShot }
    // The shot frame reads recoil 1 / trigger 1 (feel.recoilEnvelope(0),
    // triggerCurve(0)); the peaks survive a slow poll. `held` is the eased
    // pull that stays while the button is down (spin-up included).
    if (!(maxRecoil > 0.3)) summary.failures.push(`${w}: max recoil ${maxRecoil.toFixed(2)} ≤ 0.3 while firing`)
    if (!(maxTrigger > 0.5)) summary.failures.push(`${w}: max trigger ${maxTrigger.toFixed(2)} ≤ 0.5 while firing`)
    if (!(maxHeld > 0.9)) summary.failures.push(`${w}: held pull ${maxHeld.toFixed(2)} ≤ 0.9 with the button down`)
    log(`${w}: fire → recoil ${maxRecoil.toFixed(2)} trigger ${maxTrigger.toFixed(2)} held ${maxHeld.toFixed(2)} ${fireShot ?? '(no squeeze frame caught)'}`)
    // Let the clip/shots settle before the next weapon.
    await poll(page, () => (globalThis.__bootsHands().recoil === 0 ? true : null), null, { timeout: 3000 })
  }
}

let exitCode = 1
try {
  await main()
  summary.ok = summary.failures.length === 0
  exitCode = summary.ok ? 0 : 1
} catch (e) {
  summary.failures.push(`harness error: ${String(e?.stack ?? e).slice(0, 600)}`)
  exitCode = 2
} finally {
  summary.consoleErrors = summary.consoleErrors.slice(0, 8)
  summary.pageErrors = summary.pageErrors.slice(0, 8)
  if (summary.navigations.length > 0) summary.failures.push(`page navigated ${summary.navigations.length}× mid-run (HMR reload?)`)
  console.log(JSON.stringify(summary))
  console.log(summary.ok ? 'PASS' : `FAIL: ${summary.failures.join(' | ')}`)
  await shutdown(exitCode)
}
