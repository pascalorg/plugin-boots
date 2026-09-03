#!/usr/bin/env node
/**
 * BOOTS PROJECT-LEAK QA — does one project's pending window follow you into
 * another project? (Owner P0, 2026-09-02: "I see 'save changes' 'discard all'
 * and many items and walls and roofs that I placed IN THE DIFFERENT PROJECT".)
 *
 *   TAG=before node scripts/qa/project-leak.mjs     # against the unfixed plugin copy
 *   TAG=after  node scripts/qa/project-leak.mjs     # against the fixed copy
 *
 * WHAT IT DOES, on the LOCAL dev server (http://localhost:3002):
 *   1. copies scene A (65fbacdc1faf) into scene B (`boots-leak-B`) through
 *      POST /api/scenes, so both projects have the same building and Boots installed;
 *   2. opens A, Jumps in, builds two walls with the real builder (holdFire), Esc;
 *      asserts the Save/Discard offer is up and the pending key for A holds them;
 *   3. CLIENT-SIDE navigates to B (window.next.router.push — the same in-tab
 *      navigation the prod editor does between projects) and asserts B shows NO
 *      offer, NO pending preview meshes and has NO pending key; then Jumps in and
 *      Esc's in B so an Esc there cannot write A's fort under B's key;
 *   4. client-side navigates back to A and asserts the offer is still there (the
 *      legitimate restore of the product's spine, docs/SESSION-CHANGES.md);
 *   5. full-reloads B (page.goto) and asserts it is clean there too.
 *
 * Prints one JSON summary and PASS/FAIL (exit 0/1; 2 harness error; 3 watchdog).
 * Screenshots: /tmp/boots-leak/<TAG>-*.png — LOOK at them.
 *
 * ONE automation browser at a time on this machine: /tmp/boots-browser.lock.
 * Nothing under src/ is touched: the page is driven through the plugin's own
 * QA handles (__boots, __bootsBuilder) and a React-devtools hook stub that
 * exposes the R3F scene in editor phase (the mp-harness recipe).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const PE_ROOT = process.env.PE_ROOT ?? path.join(os.homedir(), 'Documents/GitHub/private-editor')
const require = createRequire(path.join(PE_ROOT, 'package.json'))
const { chromium } = require('playwright')

const TAG = process.env.TAG ?? 'run'
const BASE = process.env.BASE ?? 'http://localhost:3002'
const SCENE_A = process.env.SCENE ?? '65fbacdc1faf'
const SCENE_B = process.env.SCENE_B ?? 'boots-leak-B'
const OUT = process.env.OUT ?? '/tmp/boots-leak'
const HEADFUL = process.env.HEADFUL === '1'
const LOCK = '/tmp/boots-browser.lock'
const T0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
fs.mkdirSync(OUT, { recursive: true })

// ── the browser mutex ────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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
    } else {
      log('browser lock present without a live owner file; waiting 20 s')
    }
    await sleep(20000)
  }
}
function releaseLock() {
  if (!holdingLock) return
  try {
    const owner = fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim()
    if (owner === String(process.pid)) fs.rmSync(LOCK, { recursive: true, force: true })
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
// Whole-run watchdog, armed once the browser lock is ours (waiting for another
// automation browser is not this run's time): a hung dev server must not hold
// the mutex forever.
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 720000)
function armWatchdog() {
  const watchdog = setTimeout(() => {
    console.log(JSON.stringify({ ok: false, tag: TAG, error: `watchdog: run exceeded ${WATCHDOG_MS} ms` }))
    void shutdown(3)
  }, WATCHDOG_MS)
  watchdog.unref()
}

// ── scene B = a copy of scene A ──────────────────────────────────────────────
async function ensureSceneB() {
  const have = await fetch(`${BASE}/api/scenes/${SCENE_B}`)
  if (have.ok) return 'existing'
  const a = await fetch(`${BASE}/api/scenes/${SCENE_A}`)
  if (!a.ok) throw new Error(`scene A fetch ${a.status}`)
  const { graph } = await a.json()
  const res = await fetch(`${BASE}/api/scenes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: SCENE_B, name: 'boots leak B (QA copy of A)', graph }),
  })
  if (!res.ok) throw new Error(`scene B create ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return 'created'
}

// ── what runs inside the page before anything loads ──────────────────────────
function installQaShims() {
  // Pointer-lock shim (qa-boots-pendingview recipe): the session treats a LOST
  // lock as Esc, so `document.exitPointerLock()` is the real exit path.
  window.__qaLock = { el: null }
  Object.defineProperty(Document.prototype, 'pointerLockElement', {
    configurable: true,
    get() {
      return window.__qaLock.el
    },
  })
  HTMLCanvasElement.prototype.requestPointerLock = function () {
    window.__qaLock.el = this
    setTimeout(() => document.dispatchEvent(new Event('pointerlockchange')), 0)
    return Promise.resolve()
  }
  Document.prototype.exitPointerLock = function () {
    if (!window.__qaLock.el) return
    window.__qaLock.el = null
    document.dispatchEvent(new Event('pointerlockchange'))
  }
  // React-devtools hook stub → every R3F root → the three.js scene in ANY phase.
  const roots = new Set()
  const base = {
    isDisabled: false,
    supportsFiber: true,
    supportsFlight: false,
    renderers: new Map(),
    _ids: 0,
    inject(renderer) {
      const id = ++base._ids
      base.renderers.set(id, renderer)
      return id
    },
    onCommitFiberRoot(_id, root) {
      roots.add(root)
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
    setStrictMode() {},
    on() {},
    off() {},
    emit() {},
    sub() {
      return () => {}
    },
    getFiberRoots() {
      return roots
    },
  }
  globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__ = new Proxy(base, {
    get(target, key) {
      return key in target ? target[key] : () => {}
    },
  })
  globalThis.__bootsQaScenes = () => {
    const out = []
    for (const root of roots) {
      try {
        const s = root.containerInfo?.getState?.()
        if (s?.scene?.isScene) out.push(s)
      } catch {}
    }
    return out
  }
  /** Meshes the plugin owns in the viewport right now (`userData.__boots`):
   * in editor phase that is exactly the pending-changes preview. */
  globalThis.__bootsQaPreview = () => {
    let meshes = 0
    for (const s of globalThis.__bootsQaScenes()) {
      s.scene.traverse((o) => {
        if (o.isMesh && o.userData?.__boots) meshes++
      })
    }
    return meshes
  }
}

// ── page driving ─────────────────────────────────────────────────────────────
let page = null
const errors = []
const violations = []
let shot = 0
const snap = async (name) => {
  const file = `${OUT}/${TAG}-${String(++shot).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: file }).catch(() => {})
  log(`  shot ${file}`)
  return file
}

/** Wait for the editor to be up on the current page (canvas + Boots rail button). */
async function waitEditor(maxMs = 90000) {
  const t = Date.now()
  while (Date.now() - t < maxMs) {
    const ok = await page
      .evaluate(() => {
        const canvas = document.querySelector('canvas')
        const rail = document.querySelector('button:has(img[src*="boots"])')
        const scenes = globalThis.__bootsQaScenes?.() ?? []
        return Boolean(canvas && rail && scenes.length > 0)
      })
      .catch(() => false)
    if (ok) return true
    await sleep(1000)
  }
  return false
}

/** Open the Boots sidebar tab if it is not already showing its content. */
async function openPanel() {
  const showing = await page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /jump in/i.test(b.textContent || '')),
  )
  if (showing) return
  const rail = page.locator('button:has(img[src*="boots"])')
  if ((await rail.count()) > 0) {
    await rail.first().click().catch(() => {})
    await sleep(1500)
  }
}

async function enterGame() {
  for (let attempt = 0; attempt < 3; attempt++) {
    await openPanel()
    await page.evaluate(() => {
      for (const b of document.querySelectorAll('button'))
        if (/jump in/i.test(b.textContent || '')) {
          b.click()
          break
        }
    })
    for (let i = 0; i < 25; i++) {
      await sleep(1000)
      if (await page.evaluate(() => Boolean(globalThis.__boots))) {
        for (let j = 0; j < 30; j++) {
          if (!(await page.evaluate(() => Boolean(document.querySelector('[data-boots-veil]')))))
            break
          await sleep(1000)
        }
        await sleep(4000)
        return true
      }
    }
  }
  return false
}

/** THE REAL EXIT (see installQaShims). Returns true when the game is gone. */
async function escOut() {
  await page.evaluate(() => document.exitPointerLock())
  await sleep(3500)
  return !(await page.evaluate(() => Boolean(globalThis.__boots)))
}

const tp = (x, z, yaw, pitch, y) =>
  page.evaluate(
    ({ x, z, yaw, pitch, y }) => globalThis.__boots.teleport(x, z, yaw, pitch, y),
    { x, z, yaw, pitch, y },
  )

/** Aim from `from` at the world point `at`: forward = (-sin yaw, -cos yaw). */
async function aimFrom(from, at) {
  const yaw = Math.atan2(-(at[0] - from[0]), -(at[2] - from[2]))
  const pitch = Math.atan2(at[1] - from[1], Math.hypot(at[0] - from[0], at[2] - from[2]))
  await tp(from[0], from[2], yaw, pitch, from[1])
  await sleep(500)
}

async function holdBuild(ms) {
  await page.evaluate(() => {
    globalThis.__bootsBuilder.holdFire = true
  })
  await sleep(ms)
  await page.evaluate(() => {
    globalThis.__bootsBuilder.holdFire = false
  })
  await sleep(500)
}

const piecesInGame = () => page.evaluate(() => globalThis.__boots?.pieces?.().length ?? -1)

/** Editor-phase reads: the decision buttons, the preview census, the stored key. */
async function editorState(scope) {
  return page.evaluate((scope) => {
    const buttons = [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim())
      .filter((t) => /save changes|discard all/i.test(t))
    const raw = localStorage.getItem(`boots.pending.1.${scope}`)
    let stored = null
    if (raw) {
      try {
        const snap = JSON.parse(raw)
        stored = {
          placed: snap.placed?.length ?? 0,
          items: snap.items?.length ?? 0,
          destroyed: snap.destroyed?.length ?? 0,
          painted: snap.painted?.length ?? 0,
        }
      } catch {
        stored = 'unparseable'
      }
    }
    const keys = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith('boots.pending.')) keys.push(k)
    }
    return {
      offer: buttons.length > 0,
      buttons,
      preview: globalThis.__bootsQaPreview?.() ?? -1,
      stored,
      keys,
      inGame: Boolean(globalThis.__boots),
      path: location.pathname,
    }
  }, scope)
}

/** Client-side navigation, the way the host does it between projects. */
async function clientNav(to) {
  const pushed = await page.evaluate((to) => {
    const router = globalThis.next?.router
    if (!router?.push) return false
    router.push(to)
    return true
  }, to)
  if (!pushed) throw new Error('window.next.router.push unavailable — cannot client-side navigate')
  await page.waitForURL(`**${to}`, { timeout: 60000 })
  const up = await waitEditor()
  if (!up) throw new Error(`editor never came up after client nav to ${to}`)
  await sleep(6000)
  await openPanel()
  await sleep(1500)
}

// ── the run ──────────────────────────────────────────────────────────────────
const out = { tag: TAG, sceneA: SCENE_A, sceneB: SCENE_B, steps: {}, shots: [] }
const fails = []
const must = (cond, why) => {
  if (!cond) fails.push(why)
}

async function main() {
  await takeLock()
  armWatchdog()
  out.sceneBWas = await ensureSceneB()
  log('scene B', out.sceneBWas)

  browser = await chromium.launch({
    headless: !HEADFUL,
    channel: 'chrome',
    args: ['--disable-features=WebGPU', '--use-gl=angle', '--use-angle=swiftshader'],
  })
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
  page = await context.newPage()
  await page.addInitScript(installQaShims)
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (/INVARIANT/i.test(m.text())) violations.push(m.text().slice(0, 300))
  })

  // 1. A: jump in, build two walls, Esc.
  log('goto A')
  await page.goto(`${BASE}/scene/${SCENE_A}`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  if (!(await waitEditor())) throw new Error('editor A never came up')
  await sleep(8000)
  await openPanel()
  const preA = await editorState(SCENE_A)
  out.steps.aFresh = preA
  must(!preA.offer && preA.stored === null, 'A should start with nothing pending (fresh context)')

  if (!(await enterGame())) throw new Error('never entered the game in A')
  await page.evaluate(() => globalThis.__boots.setBotsFrozen(true))
  // Open ground east of the building (pendingprobe5); stand and look at the
  // ground 3 m ahead, hold the builder once per slot.
  const cam = await page.evaluate(() => globalThis.__boots.cameraPose().position)
  await tp(15, 0, 0)
  await sleep(600)
  const eye = await page.evaluate(() => globalThis.__boots.cameraPose().position)
  const feetY = eye[1] - 1.6
  let placedVia = 'builder'
  await aimFrom([15, eye[1], 0], [15, feetY, -3])
  await holdBuild(700)
  let n = await piecesInGame()
  if (n < 1) {
    await aimFrom([15, eye[1], 0], [15, feetY, -2])
    await holdBuild(900)
    n = await piecesInGame()
  }
  await aimFrom([15, eye[1], 0], [18, feetY, 0])
  await holdBuild(700)
  n = await piecesInGame()
  if (n < 2) {
    await aimFrom([15, eye[1], 0], [12, feetY, 0])
    await holdBuild(900)
    n = await piecesInGame()
  }
  if (n < 2) {
    // The store path the real click ends in (builder.tsx addPlaced) — the ledger
    // is what this run is about, not slot geometry under headless GL.
    placedVia = `builder(${n})+addPlaced`
    await page.evaluate((k) => {
      const s = globalThis.__boots.state()
      for (let i = s.placed.length; i < 2; i++)
        s.addPlaced({ piece: 'wall', position: [15 + i * 3, 0, -3], yaw: 0, mask: 511 })
    }, n)
    n = await piecesInGame()
  }
  out.steps.aBuilt = { pieces: n, placedVia, cameraAtSpawn: cam, eye }
  log('A built pieces:', n, 'via', placedVia)
  must(n >= 2, 'two pieces placed in A')
  await snap('A-in-game-built')

  must(await escOut(), 'Esc left the game in A')
  await sleep(1500)
  await openPanel()
  const aAfter = await editorState(SCENE_A)
  out.steps.aAfterEsc = aAfter
  out.shots.push(await snap('A-after-esc-offer'))
  log('A after Esc:', JSON.stringify(aAfter))
  must(aAfter.offer, 'A shows the Save/Discard offer after Esc')
  must(aAfter.stored?.placed >= 2, 'A pending key holds the two walls')
  must(aAfter.preview >= 2, 'A previews the pending walls')

  // 2. client-side nav to B — must be clean.
  log('client nav → B')
  await clientNav(`/scene/${SCENE_B}`)
  const bAfterNav = await editorState(SCENE_B)
  out.steps.bAfterClientNav = bAfterNav
  out.shots.push(await snap('B-after-client-nav'))
  log('B after client nav:', JSON.stringify(bAfterNav))
  must(!bAfterNav.offer, `B must show NO Save/Discard offer (got ${JSON.stringify(bAfterNav.buttons)})`)
  must(bAfterNav.preview === 0, `B must preview NO foreign pieces (got ${bAfterNav.preview})`)
  must(bAfterNav.stored === null, `B must have no pending key (got ${JSON.stringify(bAfterNav.stored)})`)

  // 2b. Jump in + Esc in B: an Esc there must not write A's fort under B's key.
  const enteredB = await enterGame()
  out.steps.bEntered = enteredB
  if (enteredB) {
    await page.evaluate(() => globalThis.__boots.setBotsFrozen(true))
    out.steps.bInGamePieces = await piecesInGame()
    must(out.steps.bInGamePieces === 0, `B's game must start with 0 placed pieces (got ${out.steps.bInGamePieces})`)
    must(await escOut(), 'Esc left the game in B')
    await sleep(1500)
    await openPanel()
    const bAfterEsc = await editorState(SCENE_B)
    out.steps.bAfterEsc = bAfterEsc
    out.shots.push(await snap('B-after-esc'))
    log('B after Esc:', JSON.stringify(bAfterEsc))
    must(!bAfterEsc.offer, 'B shows no offer after an empty session')
    must(bAfterEsc.stored === null, `B must still have no pending key after Esc (got ${JSON.stringify(bAfterEsc.stored)})`)
  } else {
    log('could not enter the game in B (non-fatal for the leak question)')
  }

  // 3. back to A — the legitimate restore.
  log('client nav → A')
  await clientNav(`/scene/${SCENE_A}`)
  const aBack = await editorState(SCENE_A)
  out.steps.aAfterReturn = aBack
  out.shots.push(await snap('A-after-return'))
  log('A after return:', JSON.stringify(aBack))
  must(aBack.offer, 'A still offers Save/Discard after coming back')
  must(aBack.stored?.placed >= 2, 'A pending key intact after the round trip')
  must(aBack.preview >= 2, `A previews its own pending walls again (got ${aBack.preview})`)

  // 4. full reload of B — clean there too.
  log('full reload → B')
  await page.goto(`${BASE}/scene/${SCENE_B}`, { waitUntil: 'domcontentloaded', timeout: 240000 })
  if (!(await waitEditor())) throw new Error('editor B never came up on reload')
  await sleep(8000)
  await openPanel()
  const bReload = await editorState(SCENE_B)
  out.steps.bAfterFullReload = bReload
  out.shots.push(await snap('B-after-full-reload'))
  log('B after full reload:', JSON.stringify(bReload))
  must(!bReload.offer && bReload.preview === 0 && bReload.stored === null, 'B clean after a full reload')

  out.errors = errors.slice(0, 20)
  out.violations = violations.slice(0, 20)
  out.ok = fails.length === 0
  out.fails = fails
  fs.writeFileSync(`${OUT}/${TAG}-summary.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out))
  console.log(out.ok ? 'PASS' : `FAIL: ${fails.join(' | ')}`)
  await shutdown(out.ok ? 0 : 1)
}

main().catch(async (e) => {
  out.error = String(e?.stack ?? e).slice(0, 800)
  out.errors = errors.slice(0, 20)
  try {
    if (page) out.shots.push(await snap('exception'))
  } catch {}
  fs.writeFileSync(`${OUT}/${TAG}-summary.json`, JSON.stringify(out, null, 1))
  console.log(JSON.stringify(out))
  console.log('FAIL: harness exception')
  await shutdown(2)
})
