#!/usr/bin/env node
/**
 * BOOTS MULTIPLAYER QA HARNESS — two players, one browser, no login.
 *
 *   MODE=play      node scripts/qa/mp-harness.mjs   (default) A and B both Jump in
 *   MODE=spectate  node scripts/qa/mp-harness.mjs   A plays, B stays in the editor and watches
 *   MODE=voice     node scripts/qa/mp-harness.mjs   play + prove the WebRTC voice mesh links
 *
 * Env knobs: HEADFUL=1 (show the browser), SCENE=<id> (default 65fbacdc1faf),
 * BASE=http://localhost:3002, SHOT_PREFIX=/tmp/mp (→ <prefix>-A.png / -B.png),
 * BUS_RAW=1 (disable the host-faithful 66 ms coalescing in the bus stub),
 * KEEP_OPEN=1 (leave the browser up after the summary until Ctrl-C),
 * ALLOW_CAPTURE=1 (keep native pointer lock/fullscreen — see installQaCaptureGuard),
 * PE_ROOT=<private-editor checkout> (where `playwright` is resolved from).
 *
 * WHAT IT PROVES (and prints as one JSON line, exit 0/1):
 *   framesAtoB / framesBtoA  'pose' frames each side actually RECEIVED from the other
 *   positionsChanged         B's received pose data for A moved while A held W (or, if
 *                            W produced nothing, after a teleport — `moved.source` says which)
 *   avatarsSeenOnA/B         three.js objects named `boots-remote-<sessionId>` in each
 *                            page's R3F scene, with an on-screen (frustum) flag
 *   voice                    per-peer RTCPeerConnection state from __boots.voice()
 *   screenshots              <prefix>-A.png, <prefix>-B.png — LOOK at them
 *
 * HOW IT REACHES THE PAGE WITHOUT TOUCHING src/:
 *   - `__pascalCollabBus` v1 stub installed pre-load (addInitScript), bridging the two
 *     pages over a BroadcastChannel. Faithful to the host module
 *     (plugin-collab-bus.ts): host-stamped identity, no self-echo, 8 000-byte cap,
 *     latest-value coalescing per (pluginId,event) at 66 ms. Both sessions are on the
 *     roster from the start. Per page: globalThis.__bootsBusLog (ring, cap 2000,
 *     {dir,event,sessionId,t,data}), __bootsDeliver(msg), __bootsQaBus() stats.
 *   - A `__REACT_DEVTOOLS_GLOBAL_HOOK__` stub records every fiber root; the R3F
 *     root's containerInfo IS its zustand store, so __bootsQaScenes() yields the
 *     three.js scene + camera in ANY phase (a spectator page has no __boots).
 *   - In-game pages expose globalThis.__boots (game-root.tsx): presence(), voice(),
 *     voiceInternals(), teleport(x,z,yaw), cameraPose(), state().
 *
 * ONE automation browser at a time on this machine: /tmp/boots-browser.lock.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const PE_ROOT = process.env.PE_ROOT ?? path.join(os.homedir(), 'Documents/GitHub/private-editor')
const require = createRequire(path.join(PE_ROOT, 'package.json'))
const { chromium } = require('playwright')

const MODE = (process.env.MODE ?? 'play').toLowerCase()
if (!['play', 'spectate', 'voice'].includes(MODE)) {
  console.error(`MODE must be play | spectate | voice (got '${MODE}')`)
  process.exit(2)
}
const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const BASE = process.env.BASE ?? 'http://localhost:3002'
const SHOT_PREFIX = process.env.SHOT_PREFIX ?? '/tmp/mp'
const HEADFUL = process.env.HEADFUL === '1'
const KEEP_OPEN = process.env.KEEP_OPEN === '1'
const BUS_COALESCE = process.env.BUS_RAW !== '1'
const LOCK = '/tmp/boots-browser.lock'
const T0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)

// ── 1. the browser mutex ─────────────────────────────────────────────────────
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
    // browser.close() has been seen to hang after PASS while this process still
    // held the lock; never let a stuck teardown keep the fleet waiting.
    if (browser)
      await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10_000))])
  } catch {}
  browser = null
  releaseLock()
  process.exit(code)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))
// Whole-run watchdog: a hung dev server must not hold the mutex forever.
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 170000)
const watchdog = setTimeout(() => {
  console.log(JSON.stringify({ ok: false, mode: MODE, error: `watchdog: run exceeded ${WATCHDOG_MS} ms` }))
  void shutdown(3)
}, WATCHDOG_MS)
watchdog.unref()

// ── 2. what runs INSIDE each page before anything loads ──────────────────────
/**
 * The bus stub. Mirrors apps/community/.../plugin-collab-bus.ts: identity is
 * stamped by the transport, never by the payload; no echo to self; 8 000-byte
 * serialized cap → 'suppressed'; latest-value coalescing per (pluginId, event)
 * every 66 ms → 'deferred' (intermediate payloads are DROPPED, exactly like prod,
 * so monotone counters survive and naive per-event streams do not).
 */
function installQaBus({ sessionId, clientId, userId, projectId, roster, coalesce }) {
  const COALESCE_MS = 66
  const MAX_SERIALIZED = 8000
  const MAX_EVENT = 40
  const PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
  const LOG_CAP = 2000
  const channel = new BroadcastChannel('boots-qa-bus')
  const subscribers = new Map() // pluginId → Set<handler>
  const participantHandlers = new Set()
  const lastSentAtByKey = new Map()
  const pendingByKey = new Map()
  const encoder = new TextEncoder()
  const stats = { published: 0, suppressed: 0, deferred: 0, coalesced: 0, delivered: 0, dropped: 0 }
  const busLog = []
  const record = (entry) => {
    busLog.push(entry)
    if (busLog.length > LOG_CAP) busLog.splice(0, busLog.length - LOG_CAP)
  }

  const fits = (pluginId, event, data) => {
    try {
      const probe = JSON.stringify({
        clientId,
        data,
        event,
        kind: 'plugin',
        pluginId,
        projectId,
        protocolVersion: 1,
        sentAt: Number.MAX_SAFE_INTEGER,
        sequence: Number.MAX_SAFE_INTEGER,
        sessionId,
      })
      return encoder.encode(probe).byteLength <= MAX_SERIALIZED
    } catch {
      return false
    }
  }
  const send = (pluginId, event, data) => {
    const t = Date.now()
    channel.postMessage({ pluginId, event, data, sessionId, clientId, userId, sentAt: t })
    stats.published += 1
    lastSentAtByKey.set(`${pluginId}\n${event}`, t)
    record({ dir: 'out', event, sessionId, t, data })
  }
  const schedule = (pluginId, event, key, data, delayMs) => {
    const existing = pendingByKey.get(key)
    if (existing) clearTimeout(existing.timer)
    pendingByKey.set(key, {
      data,
      timer: setTimeout(() => {
        const pending = pendingByKey.get(key)
        pendingByKey.delete(key)
        if (pending) send(pluginId, event, pending.data)
      }, Math.max(1, delayMs)),
    })
  }
  const publish = (pluginId, event, data) => {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) return 'suppressed'
    if (typeof event !== 'string' || event.length < 1 || event.length > MAX_EVENT) return 'suppressed'
    if (!fits(pluginId, event, data)) {
      stats.suppressed += 1
      return 'suppressed'
    }
    if (!coalesce) {
      send(pluginId, event, data)
      return 'sent'
    }
    const key = `${pluginId}\n${event}`
    const pending = pendingByKey.get(key)
    if (pending) {
      pending.data = data // latest value wins; the one it replaced is gone
      stats.coalesced += 1
      stats.deferred += 1
      return 'deferred'
    }
    const last = lastSentAtByKey.get(key)
    const elapsed = last === undefined ? Number.POSITIVE_INFINITY : Date.now() - last
    if (elapsed < COALESCE_MS) {
      schedule(pluginId, event, key, data, COALESCE_MS - elapsed)
      stats.deferred += 1
      return 'deferred'
    }
    send(pluginId, event, data)
    return 'sent'
  }

  const deliver = (frame) => {
    if (!frame || typeof frame !== 'object') return 0
    if (frame.sessionId === sessionId) return 0 // never echo to self
    const handlers = subscribers.get(frame.pluginId)
    record({ dir: 'in', event: frame.event, sessionId: frame.sessionId, t: Date.now(), data: frame.data })
    if (!handlers || handlers.size === 0) {
      stats.dropped += 1
      return 0
    }
    const msg = {
      event: frame.event,
      data: frame.data,
      sessionId: frame.sessionId,
      clientId: frame.clientId,
      userId: frame.userId,
      sentAt: frame.sentAt,
    }
    let n = 0
    for (const handler of [...handlers]) {
      try {
        handler(msg)
        n++
      } catch (e) {
        console.error('[qa-bus] handler threw', e)
      }
    }
    stats.delivered += 1
    return n
  }
  channel.onmessage = (message) => void deliver(message.data)

  const participants = () => roster.map((p) => ({ ...p, sessions: p.sessions.map((s) => ({ ...s })) }))

  globalThis.__pascalCollabBus = {
    version: 1,
    projectId,
    sessionId,
    clientId,
    userId,
    publish,
    subscribe: (pluginId, handler) => {
      let set = subscribers.get(pluginId)
      if (!set) {
        set = new Set()
        subscribers.set(pluginId, set)
      }
      set.add(handler)
      return () => set.delete(handler)
    },
    getParticipants: participants,
    onParticipants: (handler) => {
      participantHandlers.add(handler)
      // The real host pushes the roster shortly after subscription; so do we.
      setTimeout(() => {
        if (participantHandlers.has(handler)) handler(participants())
      }, 0)
      return () => participantHandlers.delete(handler)
    },
  }
  globalThis.__bootsBusLog = busLog
  /** Inject a frame as if a peer sent it. `pluginId` defaults to Boots. */
  globalThis.__bootsDeliver = (msg) => deliver({ pluginId: 'pascal:boots', ...msg })
  globalThis.__bootsQaBus = () => ({ ...stats, subscribers: [...subscribers.keys()], logSize: busLog.length })
}

/**
 * Scene access without a plugin hook: React (and R3F's own reconciler) call
 * __REACT_DEVTOOLS_GLOBAL_HOOK__.inject/onCommitFiberRoot when the hook exists
 * before they load. For the R3F root, fiberRoot.containerInfo is the zustand
 * store → getState().scene / .camera. Works in editor phase too.
 */
function installQaHooks() {
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
  /** Every live R3F store on the page (normally exactly one: the viewer). */
  globalThis.__bootsQaScenes = () => {
    const out = []
    for (const root of roots) {
      try {
        const store = root.containerInfo
        const s = store?.getState?.()
        if (s?.scene?.isScene) out.push(s)
      } catch {}
    }
    return out
  }
  /**
   * Remote avatars actually mounted in the scene graph (remote-players.tsx names
   * the root `boots-remote-<sessionId>`), with their world position and whether
   * that point is inside the current camera's frustum.
   */
  globalThis.__bootsQaAvatars = () => {
    const out = []
    for (const s of globalThis.__bootsQaScenes()) {
      const camera = s.camera
      camera?.updateMatrixWorld?.()
      s.scene.traverse((obj) => {
        if (typeof obj.name !== 'string' || !obj.name.startsWith('boots-remote-')) return
        let visible = true
        for (let o = obj; o; o = o.parent) if (o.visible === false) visible = false
        obj.updateWorldMatrix(true, false)
        const e = obj.matrixWorld.elements
        const pos = { x: e[12], y: e[13], z: e[14] }
        let ndc = null
        let onScreen = null
        if (camera) {
          // Manual project: world → camera view → clip, no THREE import needed.
          const v = { x: pos.x, y: pos.y + 0.9, z: pos.z } // chest height, not the feet
          const m = camera.matrixWorldInverse.elements
          const pm = camera.projectionMatrix.elements
          const vx = m[0] * v.x + m[4] * v.y + m[8] * v.z + m[12]
          const vy = m[1] * v.x + m[5] * v.y + m[9] * v.z + m[13]
          const vz = m[2] * v.x + m[6] * v.y + m[10] * v.z + m[14]
          const cx = pm[0] * vx + pm[4] * vy + pm[8] * vz + pm[12]
          const cy = pm[1] * vx + pm[5] * vy + pm[9] * vz + pm[13]
          const cz = pm[2] * vx + pm[6] * vy + pm[10] * vz + pm[14]
          const cw = pm[3] * vx + pm[7] * vy + pm[11] * vz + pm[15]
          if (cw !== 0) {
            ndc = { x: cx / cw, y: cy / cw, z: cz / cw }
            onScreen = vz < 0 && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1
            ndc = { x: +ndc.x.toFixed(3), y: +ndc.y.toFixed(3) }
          }
        }
        let meshes = 0
        obj.traverse((c) => {
          if (c.isMesh || c.isSkinnedMesh) meshes++
        })
        out.push({
          name: obj.name,
          sessionId: obj.userData?.__bootsRemote ?? null,
          visible,
          meshes,
          pos: { x: +pos.x.toFixed(2), y: +pos.y.toFixed(2), z: +pos.z.toFixed(2) },
          ndc,
          onScreen,
        })
      })
    }
    return out
  }
  /**
   * The first visible surface under the camera's centre (R3F's own Raycaster),
   * ignoring remote avatars. Where the spectator's camera is actually looking —
   * the only spot guaranteed not to be occluded from it.
   */
  globalThis.__bootsQaCenterHit = () => {
    const s = globalThis.__bootsQaScenes()[0]
    if (!s?.camera || !s.raycaster || !s.scene) return null
    const isAvatar = (o) => {
      for (let p = o; p; p = p.parent) if (typeof p.name === 'string' && p.name.startsWith('boots-remote-')) return true
      return false
    }
    const isVisible = (o) => {
      for (let p = o; p; p = p.parent) if (p.visible === false) return false
      return true
    }
    try {
      s.camera.updateMatrixWorld()
      s.raycaster.setFromCamera({ x: 0, y: 0 }, s.camera)
      const hits = s.raycaster.intersectObjects(s.scene.children, true)
      for (const h of hits) {
        if (!isVisible(h.object) || isAvatar(h.object)) continue
        return { x: h.point.x, y: h.point.y, z: h.point.z, distance: +h.distance.toFixed(2), name: h.object.name || h.object.type }
      }
    } catch {}
    return null
  }
  globalThis.__bootsQaCamera = () => {
    const s = globalThis.__bootsQaScenes()[0]
    if (!s?.camera) return null
    const c = s.camera
    c.updateMatrixWorld()
    const e = c.matrixWorld.elements
    // Forward = -Z of the camera's world matrix.
    return {
      pos: { x: e[12], y: e[13], z: e[14] },
      fwd: { x: -e[8], y: -e[9], z: -e[10] },
      fov: c.fov ?? null,
    }
  }
}

/**
 * WHY POINTER LOCK + FULLSCREEN ARE DISABLED IN THE PAGES. session.ts treats a
 * LOST pointer lock or fullscreen as Esc (exitGame). Two pages in one browser
 * share one focus: the moment the harness brings A to the front, B's lock drops
 * and B is thrown back to the editor (seen live: "JUMP BACK IN" pill on B,
 * remotes gone on A). Unlocked sessions are explicitly playable (input.ts:
 * keys/buttons/deltas flow regardless), and `fullscreenEnabled === false` makes
 * the session take its own CSS fake-fullscreen path, so nothing else changes.
 * ALLOW_CAPTURE=1 restores the native behaviour (single headful window only).
 */
function installQaCaptureGuard() {
  try {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
  } catch {}
  const denied = () =>
    Promise.reject(new DOMException('QA harness: pointer lock disabled (two pages, one focus)', 'NotAllowedError'))
  try {
    Element.prototype.requestPointerLock = denied
  } catch {}
  try {
    Element.prototype.requestFullscreen = denied
  } catch {}
}

// ── 3. page helpers ──────────────────────────────────────────────────────────
const NOISE = /pointer lock|PointerLock|favicon|Permissions policy|autoplay|Download the React DevTools|net::ERR_ABORTED/i
function watchConsole(page, label, sink) {
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' && !NOISE.test(t)) sink.push(`${label}: ${t.slice(0, 220)}`)
  })
  page.on('pageerror', (e) => sink.push(`${label} pageerror: ${String(e).slice(0, 220)}`))
}
const evalSafe = (page, fn, arg) => page.evaluate(fn, arg).catch(() => null)
const busLog = (page) => evalSafe(page, () => JSON.parse(JSON.stringify(globalThis.__bootsBusLog ?? [])))
const busStats = (page) => evalSafe(page, () => globalThis.__bootsQaBus?.() ?? null)
const presence = (page) => evalSafe(page, () => globalThis.__boots?.presence?.() ?? null)
const avatars = (page) => evalSafe(page, () => globalThis.__bootsQaAvatars?.() ?? [])
const voiceDump = (page) => evalSafe(page, () => globalThis.__boots?.voice?.() ?? null)
const voiceInternals = (page) => evalSafe(page, () => globalThis.__boots?.voiceInternals?.() ?? null)
const cameraPose = (page) => evalSafe(page, () => globalThis.__boots?.cameraPose?.() ?? null)
const hasBoots = (page) => evalSafe(page, () => !!globalThis.__boots)

/** Latest inbound 'pose' frame from `from` in a page's bus log (or null). */
function lastPoseFrom(logEntries, from) {
  for (let i = logEntries.length - 1; i >= 0; i--) {
    const e = logEntries[i]
    if (e.dir === 'in' && e.event === 'pose' && e.sessionId === from) return e
  }
  return null
}
const countPoseFrom = (logEntries, from) =>
  logEntries.filter((e) => e.dir === 'in' && e.event === 'pose' && e.sessionId === from).length
/** Wire envelope: {v:1, kind:'pose', seq, data:{v,ph,p:[x,y,z],yaw,pitch,w,s,g,st,f,nm}} */
const posOf = (entry) => {
  const p = entry?.data?.data?.p
  return Array.isArray(p) && p.length === 3 ? p : null
}
const dist2d = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : NaN)
/** playerRig yaw convention (shooting.ts aimDirection): forward = (-sin yaw, -cos yaw). */
const yawToward = (fromX, fromZ, toX, toZ) => Math.atan2(-(toX - fromX), -(toZ - fromZ))

/**
 * Make sure Boots is installed on this project. The `?boots=drop` veil (or the
 * panel's Jump in) appearing IS the proof. If neither shows, run the install
 * recipe through the Plugins panel — role/text selectors first, the old pixel
 * sweep on the left rail last.
 */
async function ensureInstalled(page, label) {
  const present = () =>
    page
      .waitForFunction(
        () => !!document.querySelector('[data-boots-drop-veil]') || /jump in/i.test(document.body.innerText),
        null,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false)
  if (await present()) return 'already-installed'
  log(`[${label}] no Jump in offer after 25 s — trying the install recipe`)
  await page.screenshot({ path: `${SHOT_PREFIX}-${label}-before-install.png` }).catch(() => {})
  const tryInstall = async () => {
    try {
      await page.getByText('Boots', { exact: true }).first().click({ timeout: 3000 })
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: /^install$/i }).first().click({ timeout: 3000 })
      return true
    } catch {
      return false
    }
  }
  let installed = false
  for (const opener of [
    () => page.getByRole('button', { name: /plugins?/i }).first().click({ timeout: 2500 }),
    () => page.getByRole('tab', { name: /plugins?/i }).first().click({ timeout: 2500 }),
    () => page.mouse.click(28, 331),
  ]) {
    try {
      await opener()
      await page.waitForTimeout(900)
    } catch {
      continue
    }
    if (await tryInstall()) {
      installed = true
      break
    }
  }
  if (!installed) {
    // Last resort: the rail sweep from /tmp/boots-damage-live3.mjs.
    for (const y of [283, 331, 379, 235, 174, 126, 79, 30]) {
      await page.mouse.click(28, y)
      await page.waitForTimeout(900)
      if (await tryInstall()) {
        installed = true
        break
      }
    }
  }
  log(`[${label}] install click ${installed ? 'landed' : 'NOT found'}`)
  await page.waitForTimeout(3000)
  return (await present()) ? 'installed-now' : 'NOT-INSTALLED'
}

/** Click Jump in: veil button if the drop veil is up, else the panel button. */
async function jumpIn(page, label, nick) {
  const nameInput = page.locator('[data-boots-name-input]')
  if ((await nameInput.count()) > 0) {
    await nameInput.first().fill(nick).catch(() => {})
  }
  const veilButton = page.locator('[data-boots-drop-veil] button', { hasText: /jump in/i })
  try {
    await veilButton.first().waitFor({ state: 'visible', timeout: 20000 })
    await veilButton.first().click()
  } catch {
    await page.getByRole('button', { name: /jump in/i }).first().click({ timeout: 8000 })
  }
  await page.waitForFunction(() => !!globalThis.__boots, null, { timeout: 45000 })
  log(`[${label}] in game (__boots present)`)
}

// ── 4. the run ───────────────────────────────────────────────────────────────
const summary = {
  ok: false,
  mode: MODE,
  scene: SCENE,
  install: null,
  framesAtoB: 0,
  framesBtoA: 0,
  positionsChanged: false,
  moved: null,
  avatarsSeenOnA: 0,
  avatarsSeenOnB: 0,
  avatars: { A: [], B: [] },
  presence: { A: null, B: null },
  voice: null,
  bus: { A: null, B: null },
  visibility: { A: null, B: null },
  consoleErrors: [],
  failures: [],
  screenshots: [`${SHOT_PREFIX}-A.png`, `${SHOT_PREFIX}-B.png`],
  durationMs: 0,
}
const consoleErrors = []

async function main() {
  await takeLock()
  log(`lock taken (pid ${process.pid}); MODE=${MODE} SCENE=${SCENE} headless=${!HEADFUL}`)
  browser = await chromium.launch({
    channel: 'chrome',
    headless: !HEADFUL,
    args: [
      '--disable-features=WebGPU',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Two live games in one browser: only one page is ever "in front", and
      // Chromium starves a backgrounded page's rAF/timers without these.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  await context.grantPermissions(['microphone'], { origin: BASE }).catch(() => {})

  const roster = [
    { userId: 'A-user', name: 'Alice', sessions: [{ sessionId: 'A-session', clientId: 'A-client' }] },
    { userId: 'B-user', name: 'Bob', sessions: [{ sessionId: 'B-session', clientId: 'B-client' }] },
  ]
  const mk = async (label) => {
    const page = await context.newPage()
    watchConsole(page, label, consoleErrors)
    await page.addInitScript(installQaHooks)
    if (process.env.ALLOW_CAPTURE !== '1') await page.addInitScript(installQaCaptureGuard)
    await page.addInitScript(installQaBus, {
      sessionId: `${label}-session`,
      clientId: `${label}-client`,
      userId: `${label}-user`,
      projectId: 'qa-project',
      roster,
      coalesce: BUS_COALESCE,
    })
    return page
  }
  const A = await mk('A')
  const B = await mk('B')

  // The spectator loads WITHOUT ?boots=drop: the drop veil would cover the
  // editor view it is supposed to be watching from.
  const urlA = `${BASE}/scene/${SCENE}?boots=drop`
  const urlB = MODE === 'spectate' ? `${BASE}/scene/${SCENE}` : urlA
  log('goto', urlA, '|', urlB)
  await Promise.all([
    A.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 120000 }),
    B.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 120000 }),
  ])
  await Promise.all([
    A.waitForSelector('canvas', { timeout: 90000 }),
    B.waitForSelector('canvas', { timeout: 90000 }),
  ])
  log('both canvases up')

  summary.install = await ensureInstalled(A, 'A')
  if (summary.install === 'NOT-INSTALLED') {
    summary.failures.push('Boots could not be installed on A — see ' + `${SHOT_PREFIX}-A-before-install.png`)
    return
  }
  if (MODE !== 'spectate') {
    const b = await ensureInstalled(B, 'B')
    if (b === 'NOT-INSTALLED') {
      summary.failures.push('Boots not offered on B')
      return
    }
  }

  await jumpIn(A, 'A', 'Alice')
  if (MODE !== 'spectate') await jumpIn(B, 'B', 'Bob')

  // Let the presence adapters meet: ~12 Hz frames, 150 ms interp cushion.
  await A.waitForTimeout(6000)
  summary.visibility.A = await evalSafe(A, () => document.visibilityState)
  summary.visibility.B = await evalSafe(B, () => document.visibilityState)

  // (a) frames actually received on each side
  let logA = (await busLog(A)) ?? []
  let logB = (await busLog(B)) ?? []
  summary.framesAtoB = countPoseFrom(logB, 'A-session')
  summary.framesBtoA = countPoseFrom(logA, 'B-session')
  log(`pose frames received: A→B ${summary.framesAtoB}, B→A ${summary.framesBtoA}`)

  // (b) A walks forward with W for 1.5 s; B's received poses must move.
  const before = posOf(lastPoseFrom(logB, 'A-session'))
  await A.bringToFront()
  await A.keyboard.down('KeyW')
  await A.waitForTimeout(1500)
  await A.keyboard.up('KeyW')
  await A.waitForTimeout(900)
  logB = (await busLog(B)) ?? []
  let after = posOf(lastPoseFrom(logB, 'A-session'))
  let meters = dist2d(before, after)
  let source = 'KeyW'
  if (!(meters > 0.2)) {
    // Walking did nothing observable (e.g. a wall right at spawn, or a starved
    // game loop). Fall back to the QA teleport so the WIRE is still proven —
    // and say so.
    const cam = await cameraPose(A)
    if (cam) {
      const [x, , z] = cam.position
      await evalSafe(A, ([nx, nz]) => globalThis.__boots.teleport(nx, nz, 0), [x + 2.5, z])
      await A.waitForTimeout(1200)
      logB = (await busLog(B)) ?? []
      after = posOf(lastPoseFrom(logB, 'A-session'))
      meters = dist2d(before, after)
      source = 'teleport-fallback'
    }
  }
  summary.moved = {
    source,
    meters: Number.isFinite(meters) ? +meters.toFixed(2) : null,
    before: before?.map((v) => +v.toFixed(2)) ?? null,
    after: after?.map((v) => +v.toFixed(2)) ?? null,
  }
  summary.positionsChanged = meters > 0.2
  log(`A moved ${summary.moved.meters} m as seen by B (${source})`)

  // (c)+(d) put the two in each other's view, then look.
  const camA = await cameraPose(A)
  if (camA) {
    const [ax, , az] = camA.position
    if (MODE === 'spectate') {
      // Drop A on the surface B's editor camera is looking at (centre-ray
      // hit, so it cannot be hidden behind a roof/wall from B). Fallback: the
      // ray meets A's feet plane, or 12 m along the ray.
      const camB = await evalSafe(B, () => globalThis.__bootsQaCamera?.() ?? null)
      const hit = await evalSafe(B, () => globalThis.__bootsQaCenterHit?.() ?? null)
      if (camB) {
        let tx
        let tz
        let ty = null
        if (hit) {
          tx = hit.x
          tz = hit.z
          ty = hit.y + 0.02
        } else {
          const feetY = camA.position[1] - 1.58
          let t = camB.fwd.y !== 0 ? (feetY - camB.pos.y) / camB.fwd.y : -1
          if (!(t > 1 && t < 120)) t = 12
          tx = camB.pos.x + camB.fwd.x * t
          tz = camB.pos.z + camB.fwd.z * t
        }
        await evalSafe(
          A,
          ([x, z, yaw, y]) => globalThis.__boots.teleport(x, z, yaw, 0, y ?? undefined),
          [tx, tz, yawToward(tx, tz, camB.pos.x, camB.pos.z), ty],
        )
        log(
          `A teleported into B's editor view at (${tx.toFixed(1)}, ${ty === null ? 'ground' : ty.toFixed(2)}, ${tz.toFixed(1)})` +
            (hit ? ` on '${hit.name}' ${hit.distance} m from B's camera` : ' (plane fallback)'),
        )
        summary.spectatorTarget = hit ? { ...hit, x: +hit.x.toFixed(2), y: +hit.y.toFixed(2), z: +hit.z.toFixed(2) } : 'plane-fallback'
      }
    } else {
      // Both spawn on the same pad: separate them by 3 m and face each other.
      const bx = ax + 3
      const bz = az
      await evalSafe(B, ([x, z, yaw]) => globalThis.__boots.teleport(x, z, yaw), [bx, bz, yawToward(bx, bz, ax, az)])
      await evalSafe(A, ([x, z, yaw]) => globalThis.__boots.teleport(x, z, yaw), [ax, az, yawToward(ax, az, bx, bz)])
      log('A and B teleported 3 m apart, facing each other')
    }
  }
  await A.waitForTimeout(1800)
  summary.avatars.A = (await avatars(A)) ?? []
  summary.avatars.B = (await avatars(B)) ?? []
  summary.avatarsSeenOnA = summary.avatars.A.length
  summary.avatarsSeenOnB = summary.avatars.B.length
  summary.presence.A = compactPresence(await presence(A))
  summary.presence.B = compactPresence(await presence(B))
  log(`avatars in scene: A sees ${summary.avatarsSeenOnA}, B sees ${summary.avatarsSeenOnB}`)

  await A.bringToFront()
  await A.waitForTimeout(250)
  await A.screenshot({ path: `${SHOT_PREFIX}-A.png` })
  await B.bringToFront()
  await B.waitForTimeout(250)
  await B.screenshot({ path: `${SHOT_PREFIX}-B.png` })

  // (6) voice
  if (MODE === 'voice') {
    summary.voice = await proveVoice(A, B)
  } else {
    const v = await voiceDump(A)
    summary.voice = v
      ? { A: { active: v.active, mic: v.mic, supported: v.supported, peers: v.peers.length } }
      : { note: 'no __boots.voice on A' }
  }

  summary.bus.A = await busStats(A)
  summary.bus.B = await busStats(B)
  logA = (await busLog(A)) ?? []
  logB = (await busLog(B)) ?? []
  summary.framesAtoB = countPoseFrom(logB, 'A-session')
  summary.framesBtoA = countPoseFrom(logA, 'B-session')

  // Verdict
  if (summary.framesAtoB === 0) summary.failures.push('B received no pose frames from A')
  if (MODE !== 'spectate' && summary.framesBtoA === 0) summary.failures.push('A received no pose frames from B')
  if (!summary.positionsChanged) summary.failures.push("A's position never changed in B's received poses")
  if (summary.avatarsSeenOnB < 1) summary.failures.push("no boots-remote-* avatar in B's scene")
  if (MODE !== 'spectate' && summary.avatarsSeenOnA < 1) summary.failures.push("no boots-remote-* avatar in A's scene")
  if (MODE === 'voice' && !summary.voice?.connectedBothWays) summary.failures.push('voice mesh not connected both ways')
}

function compactPresence(p) {
  if (!p) return null
  return {
    published: p.published,
    received: p.received,
    culled: p.culled,
    remotes: p.remotes.map((r) => ({
      sessionId: r.sessionId,
      name: r.name,
      p: r.p.map((v) => +v.toFixed(2)),
      w: r.w,
      ageMs: r.ageMs,
    })),
  }
}

/** Poll both voice layers until each holds a connected link to the other. */
async function proveVoice(A, B) {
  const pressM = async (page) => {
    await page.bringToFront()
    await page.keyboard.press('KeyM') // mic toggle (voice-controls.tsx) — a user gesture the mic needs
    await page.waitForTimeout(300)
  }
  const shape = (v) =>
    v
      ? {
          active: v.active,
          mic: v.mic,
          mode: v.mode,
          talking: v.talking,
          ticks: v.ticks,
          counters: v.counters,
          unreachable: v.unreachable,
          peers: v.peers.map((p) => ({
            sessionId: p.sessionId,
            state: p.state,
            connection: p.connection,
            ice: p.ice,
            step: p.step,
            owed: p.owed,
            acked: p.acked,
            hasTrack: p.hasTrack,
            attempts: p.attempts,
            error: p.error,
          })),
        }
      : null
  const connected = (v, peerId) =>
    !!v?.peers?.some((p) => p.sessionId === peerId && (p.state === 'connected' || p.connection === 'connected'))
  // Mic: fake device + granted permission → enableMicIfAlreadyPermitted should
  // have lit it; if not, M is the in-game toggle.
  let vA = await voiceDump(A)
  let vB = await voiceDump(B)
  if (vA && vA.mic !== 'live') await pressM(A)
  if (vB && vB.mic !== 'live') await pressM(B)
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    vA = await voiceDump(A)
    vB = await voiceDump(B)
    if (connected(vA, 'B-session') && connected(vB, 'A-session')) break
    await A.waitForTimeout(1000)
  }
  const out = {
    connectedBothWays: connected(vA, 'B-session') && connected(vB, 'A-session'),
    A: shape(vA),
    B: shape(vB),
    internals: { A: await voiceInternals(A), B: await voiceInternals(B) },
  }
  log(`voice: A→B ${connected(vA, 'B-session')}, B→A ${connected(vB, 'A-session')}; mic A=${vA?.mic} B=${vB?.mic}`)
  return out
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
  summary.consoleErrors = consoleErrors.slice(0, 6)
  summary.durationMs = Date.now() - T0
  console.log(JSON.stringify(summary))
  console.log(summary.ok ? 'PASS' : `FAIL: ${summary.failures.join(' | ')}`)
  if (KEEP_OPEN && browser) {
    log('KEEP_OPEN=1 — browser stays up; Ctrl-C to close and release the lock')
    await new Promise(() => {})
  }
  await shutdown(exitCode)
}
