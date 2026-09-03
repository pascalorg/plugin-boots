#!/usr/bin/env node
/**
 * THE BUS IS NOT FOREVER — live check (lane "presence", 2026-09-02).
 * Run: `node scripts/qa/see-swap-harness.mjs` (knobs as see-harness.mjs: HEADFUL=1,
 * KEEP_OPEN=1, SHOT_PREFIX=/tmp/see-swap, SCENE, BASE, BUS_RAW=1).
 *
 * scripts/qa/see-harness.mjs (three pages, held/late bus, drop-in, Escape) with
 * ONE extra step, 3b, run on the SPECTATOR page B once it lists Alice — the
 * three things the host's awareness runtime does to `__pascalCollabBus` that
 * used to break the roster (use-project-awareness.ts + plugin-collab-bus.ts):
 *   (i)  SWAP   — `__bootsQaSwapBus()`: the bus object is uninstalled (its
 *        handler sets cleared, exactly like the host's uninstall()) and a NEW
 *        object with the same identity is installed. presence.ts must follow it
 *        by object identity on the next tick (transport + roster subscription),
 *        keep the registry (rosterVersion unchanged), hear fresh frames on it
 *        (remotes[].lastSeenMs advances) and report swaps/rebinds ≥ 1.
 *   (ii) ROSTER BLIP — `__bootsQaBlipRoster(400)`: an EMPTY participant list is
 *        pushed (the runtime's setParticipants([]) on every channel teardown),
 *        the real one 400 ms later. Nobody may despawn; rosterVersion holds.
 *   (iii) OUTAGE — `__bootsQaOutage(600)`: no bus at all for 600 ms, then a new
 *        one. presence().bound must read false meanwhile, Alice must stay
 *        listed, and frames must flow again after — no leave, no re-join.
 * Step 3c does the SWAP and the OUTAGE again on the PLAYER page A — the side
 * that PUBLISHES. The host keeps A's sessionId across a channel restart, so
 * B's ordered tracker for `A-session|pose` still sits at A's last seq: had A's
 * outbound counter restarted at 1 on the new bus, B would have dropped every
 * frame as a rewind until its 3 s staleness sweep despawned Alice, then
 * re-joined her on the first accepted frame (net.ts keeps the counter
 * page-monotonic). Asserted on B: Alice stays listed, rosterVersion holds,
 * lastSeenMs keeps advancing, netDropped does not climb; on A: swaps ≥ 1,
 * published keeps counting, bound false during / true after the outage.
 * Then the original steps 4-5 continue on the swapped buses (drop-in from the
 * pill, roster chips, Escape → despawn → A spectates Bob).
 *
 * Against the pre-fix presence.ts (git ef293af..728a75d) this reports, live:
 * "Boots is not subscribed on the NEW bus object", "the NEW bus has no roster
 * handler", "no fresh frames after the swap", "roster blip cost a leave/join
 * (names [])", "Alice despawned during a 600 ms outage" — and the pill is gone,
 * so the drop-in step cannot even click it. With the fix: PASS.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const PE_ROOT = process.env.PE_ROOT ?? path.join(os.homedir(), 'Documents/GitHub/private-editor')
const require = createRequire(path.join(PE_ROOT, 'package.json'))
const { chromium } = require('playwright')

const MODE = 'see-swap'
const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const BASE = process.env.BASE ?? 'http://localhost:3002'
const SHOT_PREFIX = process.env.SHOT_PREFIX ?? '/tmp/see-swap'
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
    if (browser) await browser.close()
  } catch {}
  browser = null
  releaseLock()
  process.exit(code)
}
process.on('exit', releaseLock)
process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))
// Whole-run watchdog: a hung dev server must not hold the mutex forever.
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS ?? 420000)
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
  /** Mirror of plugin-collab-bus.ts uninstall(): handlers die with the object. */
  const uninstall = () => {
    subscribers.clear()
    participantHandlers.clear()
    for (const p of pendingByKey.values()) clearTimeout(p.timer)
    pendingByKey.clear()
    channel.close()
    if (globalThis.__pascalCollabBus?.sessionId === sessionId) delete globalThis.__pascalCollabBus
  }
  const reinstall = (over) => installQaBus({ sessionId, clientId, userId, projectId, roster, coalesce, ...(over ?? {}) })
  /** Host channel restart: the old bus object is uninstalled and a NEW object
   * (same identity unless `over` re-keys it) is installed synchronously. */
  globalThis.__bootsQaSwapBus = (over) => {
    uninstall()
    reinstall(over)
    return globalThis.__pascalCollabBus.sessionId
  }
  /** Host teardown → later re-install: NO bus at all for `gapMs`. */
  globalThis.__bootsQaOutage = (gapMs) => {
    uninstall()
    setTimeout(() => reinstall(), gapMs)
    return true
  }
  /** The awareness reset (use-project-awareness setParticipants([])): an EMPTY
   * roster pushed to every handler now, the real one `laterMs` after. */
  globalThis.__bootsQaBlipRoster = (laterMs) => {
    for (const h of [...participantHandlers]) h([])
    setTimeout(() => {
      for (const h of [...participantHandlers]) h(participants())
    }, laterMs)
    return participantHandlers.size
  }
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

// ── see-lane additions ───────────────────────────────────────────────────────
/** Hold the stub bus back at init: `__pascalCollabBus` is removed until the
 * test releases it — the host's late realtime auth, reproduced. */
function installQaBusHold() {
  const held = globalThis.__pascalCollabBus
  delete globalThis.__pascalCollabBus
  globalThis.__bootsQaHeldBus = held
  globalThis.__bootsQaReleaseBus = () => {
    globalThis.__pascalCollabBus = globalThis.__bootsQaHeldBus
    return !!globalThis.__pascalCollabBus
  }
}

/** Per-page nickname: the two pages share one browser context (one
 * localStorage), and nickname.ts loads its override lazily from
 * 'boots.nick.1' — so B would inherit whatever A typed. Shim that ONE key to a
 * page-local value; everything else in storage behaves normally. */
function installQaNick(nick) {
  const KEY = 'boots.nick.1'
  const proto = Storage.prototype
  const get = proto.getItem
  const set = proto.setItem
  const rem = proto.removeItem
  let local = nick
  proto.getItem = function (k) {
    return this === globalThis.localStorage && k === KEY ? local : get.call(this, k)
  }
  proto.setItem = function (k, v) {
    if (this === globalThis.localStorage && k === KEY) {
      local = String(v)
      return
    }
    return set.call(this, k, v)
  }
  proto.removeItem = function (k) {
    if (this === globalThis.localStorage && k === KEY) {
      local = null
      return
    }
    return rem.call(this, k)
  }
}
/** A per-load stamp: a changed value later = the page fully reloaded. */
function installQaLoadStamp() {
  globalThis.__bootsQaLoadStamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
const loadStamp = (page) => evalSafe(page, () => globalThis.__bootsQaLoadStamp ?? null)

const spect = (page) => evalSafe(page, () => globalThis.__bootsSpectator?.snapshot?.() ?? null)
const pill = (page) =>
  evalSafe(page, () => {
    const el = document.querySelector('[data-boots-spectator-hint]')
    if (!el) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    return { text: el.textContent, display: cs.display, top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) }
  })
/** The in-game roster chip (hud.ts presenceChip): a leaf div whose text is the chip copy. */
const chipText = (page) =>
  evalSafe(page, () => {
    const re = /^(\d+ players?: .+|\d+ builders? here)$/
    for (const d of document.querySelectorAll('div')) {
      if (d.children.length !== 0) continue
      const t = (d.textContent ?? '').trim()
      if (re.test(t)) return t
    }
    return null
  })
async function waitFor(page, fn, arg, timeoutMs) {
  const t = Date.now()
  try {
    await page.waitForFunction(fn, arg, { timeout: timeoutMs, polling: 100 })
    return { ok: true, ms: Date.now() - t }
  } catch {
    return { ok: false, ms: Date.now() - t }
  }
}
async function shot(page, name) {
  await page.bringToFront()
  await page.waitForTimeout(300)
  const file = `${SHOT_PREFIX}-${name}.png`
  await page.screenshot({ path: file })
  summary.screenshots.push(file)
}

const summary = {
  ok: false,
  mode: MODE,
  scene: SCENE,
  install: null,
  steps: {},
  bus: {},
  consoleErrors: [],
  failures: [],
  screenshots: [],
  durationMs: 0,
}
const consoleErrors = []
const fail = (msg) => {
  summary.failures.push(msg)
  log('FAIL', msg)
}

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
  const mk = async (label, { bus, hold, nick }) => {
    const page = await context.newPage()
    watchConsole(page, label, consoleErrors)
    await page.addInitScript(installQaHooks)
    await page.addInitScript(installQaCaptureGuard)
    await page.addInitScript(installQaLoadStamp)
    if (nick) await page.addInitScript(installQaNick, nick)
    if (bus) {
      await page.addInitScript(installQaBus, {
        sessionId: `${label}-session`,
        clientId: `${label}-client`,
        userId: `${label}-user`,
        projectId: 'qa-project',
        roster,
        coalesce: BUS_COALESCE,
      })
    }
    if (hold) await page.addInitScript(installQaBusHold)
    return page
  }
  const A = await mk('A', { bus: true, hold: true, nick: 'Alice' })
  const B = await mk('B', { bus: true, hold: true, nick: 'Bob' })
  const C = await mk('C', { bus: false, hold: false, nick: null })
  const urlA = `${BASE}/scene/${SCENE}?boots=drop`
  const urlB = `${BASE}/scene/${SCENE}`
  log('goto', urlA, '|', urlB, '| C (no bus)', urlB)
  await Promise.all([
    A.goto(urlA, { waitUntil: 'domcontentloaded', timeout: 120000 }),
    B.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 120000 }),
    C.goto(urlB, { waitUntil: 'domcontentloaded', timeout: 120000 }),
  ])
  await Promise.all([
    A.waitForSelector('canvas', { timeout: 90000 }),
    B.waitForSelector('canvas', { timeout: 90000 }),
    C.waitForSelector('canvas', { timeout: 90000 }),
  ])
  log('three canvases up')
  const stamps = { A: await loadStamp(A), B: await loadStamp(B) }

  // ── 1. spectator bind RETRY on B (bus held → released) ─────────────────────
  const mountedB = await waitFor(B, () => !!globalThis.__bootsSpectator, null, 60000)
  if (!mountedB.ok) fail('B: __bootsSpectator never appeared (plugin not mounted in editor phase?)')
  await sleep(2500)
  let sB = await spect(B)
  summary.steps.spectatorWhileBusHeld = sB
  if (!sB || sB.bound !== false) fail(`B: expected bound:false while the bus is held, got ${JSON.stringify(sB)}`)
  if (await pill(B)) fail('B: a pill while the bus is held')
  await evalSafe(B, () => globalThis.__bootsQaReleaseBus())
  const boundB = await waitFor(B, () => globalThis.__bootsSpectator?.bound === true, null, 4000)
  summary.steps.spectatorBoundAfterBusMs = boundB.ms
  log(`B bound ${boundB.ok ? boundB.ms + ' ms' : 'NEVER'} after the bus landed`)
  if (!boundB.ok) fail('B: did not bind within 4 s of the bus arriving (spectator retry)')
  sB = await spect(B)
  if (sB?.names?.length) fail(`B: names before anyone plays: ${JSON.stringify(sB.names)}`)
  if (await pill(B)) fail('B: pill present with nobody playing')

  // ── 2. the negative: C has no bus at all ───────────────────────────────────
  await waitFor(C, () => !!globalThis.__bootsSpectator, null, 60000)
  await sleep(3000)
  const sC = await spect(C)
  const pillC = await pill(C)
  summary.steps.negativeNoBus = { handle: !!sC, bound: sC?.bound ?? null, names: sC?.names ?? null, pill: pillC }
  if (sC && sC.bound !== false) fail('C: bound without a bus')
  if (pillC) fail('C: a pill without a bus')

  // ── 3. game-root bind RETRY on A (jump in with the bus held, then release) ──
  summary.install = await ensureInstalled(A, 'A')
  if (summary.install === 'NOT-INSTALLED') {
    fail(`Boots could not be installed on A — see ${SHOT_PREFIX}-A-before-install.png`)
    return
  }
  await jumpIn(A, 'A', 'Alice')
  await sleep(2500)
  let pA = await presence(A)
  summary.steps.aSoloWhileBusHeld = { published: pA?.published ?? null, remotes: pA?.remotes?.length ?? null }
  if (!pA || pA.published !== 0) fail(`A: expected published 0 while solo (bus held), got ${pA?.published}`)
  sB = await spect(B)
  if (sB?.names?.length) fail('B: listed a player while A had no bus')
  await evalSafe(A, () => globalThis.__bootsQaReleaseBus())
  const pubA = await waitFor(A, () => (globalThis.__boots?.presence?.().published ?? 0) > 0, null, 4000)
  summary.steps.gameBoundAfterBusMs = pubA.ms
  log(`A published ${pubA.ok ? pubA.ms + ' ms' : 'NEVER'} after the bus landed`)
  if (!pubA.ok) fail('A: never published after the bus arrived (game-root retry)')
  const seesB = await waitFor(
    B,
    () => {
      const s = globalThis.__bootsSpectator?.snapshot?.()
      return !!s && s.names.includes('Alice') && s.remotes.length === 1
    },
    null,
    5000,
  )
  summary.steps.spectatorListedAliceMs = seesB.ms
  log(`B listed Alice ${seesB.ok ? seesB.ms + ' ms' : 'NEVER'} after A's bus landed`)
  if (!seesB.ok) fail('B: never listed Alice within 5 s of her bus arriving')
  await sleep(700)
  const pillB1 = await pill(B)
  summary.steps.pill = pillB1
  if (!pillB1 || !/Alice is playing/.test(pillB1.text ?? '')) fail(`B: pill text wrong: ${JSON.stringify(pillB1)}`)
  if (pillB1 && pillB1.display === 'none') fail('B: pill hidden on a plain editor page')
  const avB = (await avatars(B)) ?? []
  if (!avB.some((a) => a.sessionId === 'A-session')) fail("B: no boots-remote-A-session object in the spectator's scene")
  summary.steps.spectatorSnapshot = await spect(B)

  // ── 3b. THE BUS IS NOT FOREVER (presence lane): swap / roster blip / outage on B ──
  const presOf = (page) => evalSafe(page, () => globalThis.__bootsSpectator?.presence?.() ?? null)
  const rosterV = (await spect(B))?.rosterVersion
  const p0 = await presOf(B)
  const seen0 = p0?.remotes?.[0]?.lastSeenMs ?? 0
  if (!p0?.bound) fail('B: presence().bound false before the swap scenario')
  // (i) host channel restart: a NEW bus object, same identity.
  const swappedId = await evalSafe(B, () => globalThis.__bootsQaSwapBus())
  await sleep(1500)
  let sS = await spect(B)
  let pS = await presOf(B)
  let stS = await busStats(B)
  summary.steps.busSwap = {
    swappedId,
    names: sS?.names ?? null,
    rosterVersion: sS?.rosterVersion ?? null,
    swaps: pS?.swaps ?? null,
    rebinds: pS?.rebinds ?? null,
    bound: pS?.bound ?? null,
    lastSeenAdvancedMs: (pS?.remotes?.[0]?.lastSeenMs ?? 0) - seen0,
    nick: pS?.remotes?.[0]?.nick ?? null,
    subscribersOnNewBus: stS?.subscribers ?? null,
  }
  if (!sS?.names?.includes('Alice')) fail(`B: lost Alice across a bus swap (names ${JSON.stringify(sS?.names)})`)
  if (sS?.rosterVersion !== rosterV) fail(`B: rosterVersion moved across the bus swap (${rosterV} → ${sS?.rosterVersion}): Alice left/re-joined`)
  if (!(pS?.swaps >= 1 && pS?.rebinds >= 1)) fail(`B: presence did not record the swap (swaps ${pS?.swaps}, rebinds ${pS?.rebinds})`)
  if (!pS?.bound) fail('B: presence().bound false after the swap')
  if (!((pS?.remotes?.[0]?.lastSeenMs ?? 0) > seen0 + 700)) fail('B: no fresh frames from Alice after the swap — deaf on the new bus')
  if (!stS?.subscribers?.includes('pascal:boots')) fail('B: Boots is not subscribed on the NEW bus object')
  if (pS?.remotes?.[0]?.nick !== 'Alice') fail(`B: presence nick should be 'Alice', got ${JSON.stringify(pS?.remotes?.[0]?.nick)}`)
  log(`B swap: names ${JSON.stringify(sS?.names)} swaps ${pS?.swaps} rebinds ${pS?.rebinds} fresh +${summary.steps.busSwap.lastSeenAdvancedMs} ms`)
  // (ii) the awareness reset: an EMPTY roster pushed, the real one 400 ms later.
  const seen1 = pS?.remotes?.[0]?.lastSeenMs ?? 0
  const handlers = await evalSafe(B, () => globalThis.__bootsQaBlipRoster(400))
  await sleep(150)
  const mid = await spect(B)
  const pMid = await presOf(B)
  await sleep(1500)
  sS = await spect(B)
  pS = await presOf(B)
  summary.steps.rosterBlip = {
    rosterHandlersOnBus: handlers,
    namesDuring: mid?.names ?? null,
    rosterMissingMsDuring: pMid?.remotes?.[0]?.rosterMissingMs ?? null,
    namesAfter: sS?.names ?? null,
    rosterVersion: sS?.rosterVersion ?? null,
    rosterMissingMsAfter: pS?.remotes?.[0]?.rosterMissingMs ?? null,
  }
  if (!(handlers >= 1)) fail('B: the NEW bus has no roster handler — presence never re-subscribed onParticipants')
  if (!mid?.names?.includes('Alice')) fail('B: Alice vanished on an EMPTY roster push')
  if (!sS?.names?.includes('Alice') || sS?.rosterVersion !== rosterV) fail(`B: roster blip cost a leave/join (names ${JSON.stringify(sS?.names)}, rosterVersion ${sS?.rosterVersion})`)
  log(`B roster blip: during ${JSON.stringify(mid?.names)} after ${JSON.stringify(sS?.names)}`)
  // (iii) outage: no bus at all for 600 ms, then a new one.
  await evalSafe(B, () => globalThis.__bootsQaOutage(600))
  await sleep(300)
  const dark = await presOf(B)
  const darkS = await spect(B)
  await sleep(1800)
  sS = await spect(B)
  pS = await presOf(B)
  summary.steps.busOutage = {
    boundDuring: dark?.bound ?? null,
    namesDuring: darkS?.names ?? null,
    namesAfter: sS?.names ?? null,
    rosterVersion: sS?.rosterVersion ?? null,
    boundAfter: pS?.bound ?? null,
    rebinds: pS?.rebinds ?? null,
    lastSeenAdvancedMs: (pS?.remotes?.[0]?.lastSeenMs ?? 0) - seen1,
  }
  if (dark?.bound !== false) fail(`B: presence still claims bound during the outage (${JSON.stringify(dark?.bound)})`)
  if (!darkS?.names?.includes('Alice')) fail('B: Alice despawned during a 600 ms outage')
  if (!sS?.names?.includes('Alice') || sS?.rosterVersion !== rosterV) fail(`B: outage cost a leave/join (names ${JSON.stringify(sS?.names)}, rosterVersion ${sS?.rosterVersion})`)
  if (!pS?.bound) fail('B: not bound after the bus returned')
  if (!((pS?.remotes?.[0]?.lastSeenMs ?? 0) > seen1 + 1200)) fail('B: no fresh frames after the outage')
  log(`B outage: bound during ${dark?.bound} → after ${pS?.bound}, names ${JSON.stringify(sS?.names)}, rebinds ${pS?.rebinds}`)
  await shot(B, 'B-after-swaps')

  // ── 3c. THE SAME ON THE PLAYER (A): a restart must not rewind her sequence ──
  // B never swapped here, so its transport still holds A-session|pose at Alice's
  // last seq. Only a page-monotonic outbound counter on A keeps B accepting her.
  const rosterV2 = (await spect(B))?.rosterVersion
  const pA0 = await presence(A)
  const pB0 = await presOf(B)
  const seenA0 = pB0?.remotes?.[0]?.lastSeenMs ?? 0
  const droppedB0 = pB0?.netDropped ?? 0
  const swappedA = await evalSafe(A, () => globalThis.__bootsQaSwapBus())
  await sleep(3800) // > STALE_MS: a rewound stream would have despawned Alice on B by now
  let sB2 = await spect(B)
  let pB2 = await presOf(B)
  let pA2 = await presence(A)
  summary.steps.playerBusSwap = {
    swappedId: swappedA,
    aSwaps: pA2?.swaps ?? null,
    aRebinds: pA2?.rebinds ?? null,
    aPublishedDelta: (pA2?.published ?? 0) - (pA0?.published ?? 0),
    namesOnB: sB2?.names ?? null,
    rosterVersionOnB: sB2?.rosterVersion ?? null,
    lastSeenAdvancedMs: (pB2?.remotes?.[0]?.lastSeenMs ?? 0) - seenA0,
    bNetDroppedDelta: (pB2?.netDropped ?? 0) - droppedB0,
  }
  if (!(pA2?.swaps >= 1)) fail(`A: presence did not record its own bus swap (swaps ${pA2?.swaps})`)
  if (!((pA2?.published ?? 0) > (pA0?.published ?? 0))) fail('A: stopped publishing after its bus swap')
  if (!sB2?.names?.includes('Alice')) fail(`B: lost Alice when A's bus was swapped (names ${JSON.stringify(sB2?.names)})`)
  if (sB2?.rosterVersion !== rosterV2) fail(`B: rosterVersion moved when A's bus was swapped (${rosterV2} → ${sB2?.rosterVersion}): Alice left/re-joined`)
  if (!((pB2?.remotes?.[0]?.lastSeenMs ?? 0) > seenA0 + 2500)) fail("B: no fresh frames from Alice after HER bus swap — B's ordered tracker refused the new stream (sequence rewound?)")
  if ((pB2?.netDropped ?? 0) - droppedB0 > 2) fail(`B: transport dropped ${(pB2?.netDropped ?? 0) - droppedB0} frames after Alice's swap (sequence rewound?)`)
  log(`A swap: A published +${summary.steps.playerBusSwap.aPublishedDelta}, B names ${JSON.stringify(sB2?.names)} fresh +${summary.steps.playerBusSwap.lastSeenAdvancedMs} ms dropped +${summary.steps.playerBusSwap.bNetDroppedDelta}`)
  // Outage on the player: no bus for 600 ms. B holds Alice (staleness is 3 s),
  // and A's numbering continues when the bus returns (nothing was spent meanwhile).
  const seenA1 = pB2?.remotes?.[0]?.lastSeenMs ?? 0
  const droppedB1 = pB2?.netDropped ?? 0
  await evalSafe(A, () => globalThis.__bootsQaOutage(600))
  await sleep(300)
  const darkA = await presence(A)
  await sleep(3500)
  sB2 = await spect(B)
  pB2 = await presOf(B)
  pA2 = await presence(A)
  summary.steps.playerBusOutage = {
    aBoundDuring: darkA?.bound ?? null,
    aBoundAfter: pA2?.bound ?? null,
    aRebinds: pA2?.rebinds ?? null,
    namesOnB: sB2?.names ?? null,
    rosterVersionOnB: sB2?.rosterVersion ?? null,
    lastSeenAdvancedMs: (pB2?.remotes?.[0]?.lastSeenMs ?? 0) - seenA1,
    bNetDroppedDelta: (pB2?.netDropped ?? 0) - droppedB1,
  }
  if (darkA?.bound !== false) fail(`A: presence still claims bound during its own outage (${JSON.stringify(darkA?.bound)})`)
  if (!pA2?.bound) fail('A: not bound after its bus returned')
  if (!sB2?.names?.includes('Alice') || sB2?.rosterVersion !== rosterV2) fail(`B: A's outage cost a leave/join (names ${JSON.stringify(sB2?.names)}, rosterVersion ${sB2?.rosterVersion})`)
  if (!((pB2?.remotes?.[0]?.lastSeenMs ?? 0) > seenA1 + 2500)) fail("B: no fresh frames from Alice after HER outage")
  if ((pB2?.netDropped ?? 0) - droppedB1 > 2) fail(`B: transport dropped ${(pB2?.netDropped ?? 0) - droppedB1} frames after Alice's outage`)
  log(`A outage: bound during ${darkA?.bound} → after ${pA2?.bound}, B names ${JSON.stringify(sB2?.names)} fresh +${summary.steps.playerBusOutage.lastSeenAdvancedMs} ms dropped +${summary.steps.playerBusOutage.bNetDroppedDelta}`)

  // Photo: drop A on the surface B's editor camera is looking at (harness recipe).
  const camA = await cameraPose(A)
  const camB = await evalSafe(B, () => globalThis.__bootsQaCamera?.() ?? null)
  const hit = await evalSafe(B, () => globalThis.__bootsQaCenterHit?.() ?? null)
  if (camA && camB) {
    let tx, tz, ty = null
    if (hit) {
      tx = hit.x; tz = hit.z; ty = hit.y + 0.02
    } else {
      const feetY = camA.position[1] - 1.58
      let t = camB.fwd.y !== 0 ? (feetY - camB.pos.y) / camB.fwd.y : -1
      if (!(t > 1 && t < 120)) t = 12
      tx = camB.pos.x + camB.fwd.x * t
      tz = camB.pos.z + camB.fwd.z * t
    }
    await evalSafe(A, ([x, z, yaw, y]) => globalThis.__boots.teleport(x, z, yaw, 0, y ?? undefined), [tx, tz, yawToward(tx, tz, camB.pos.x, camB.pos.z), ty])
    summary.steps.spectatorTarget = hit ? { name: hit.name, distance: hit.distance } : 'plane-fallback'
    log(`A teleported into B's editor view${hit ? ` on '${hit.name}' ${hit.distance} m from B's camera` : ' (plane fallback)'}`)
  }
  await sleep(1800)
  summary.steps.avatarsOnBForPhoto = (await avatars(B)) ?? []
  await shot(B, 'B-spectating')

  // ── 4. seamless drop-in from the pill ──────────────────────────────────────
  const before = await spect(B)
  await B.bringToFront()
  await B.click('[data-boots-spectator-hint]', { timeout: 5000 }).catch((e) => fail(`B: pill click failed: ${String(e).slice(0, 120)}`))
  const inB = await waitFor(B, () => !!globalThis.__boots, null, 45000)
  if (!inB.ok) fail('B: pill click did not enter the game')
  await sleep(2500)
  const after = await spect(B)
  summary.steps.dropIn = {
    rosterVersionBefore: before?.rosterVersion ?? null,
    rosterVersionAfter: after?.rosterVersion ?? null,
    handleAliveAcrossFlip: !!after,
    enteredMs: inB.ms,
  }
  if (after && before && after.rosterVersion !== before.rosterVersion) {
    fail(`B: rosterVersion moved across the drop-in (${before.rosterVersion} → ${after.rosterVersion}): the registry was rebuilt`)
  }
  const pB = await presence(B)
  if (!pB?.remotes?.some((r) => r.sessionId === 'A-session')) fail("B: after the drop-in Alice is not in B's presence")
  const seesA = await waitFor(A, () => !!globalThis.__boots?.presence?.().remotes?.some((r) => r.sessionId === 'B-session'), null, 5000)
  summary.steps.aSawBobMs = seesA.ms
  if (!seesA.ok) fail('A: never saw Bob after his drop-in')
  if (await pill(B)) fail('B: spectator pill still in the DOM in game phase')
  await sleep(900)
  const chips = { A: await chipText(A), B: await chipText(B) }
  summary.steps.rosterChips = chips
  if (chips.A !== '1 player: Bob') fail(`A: roster chip should read '1 player: Bob', got ${JSON.stringify(chips.A)}`)
  if (chips.B !== '1 player: Alice') fail(`B: roster chip should read '1 player: Alice', got ${JSON.stringify(chips.B)}`)
  // Face each other for the in-game photos.
  const camA2 = await cameraPose(A)
  if (camA2) {
    const [ax, , az] = camA2.position
    const bx = ax + 3, bz = az
    await evalSafe(B, ([x, z, yaw]) => globalThis.__boots.teleport(x, z, yaw), [bx, bz, yawToward(bx, bz, ax, az)])
    await evalSafe(A, ([x, z, yaw]) => globalThis.__boots.teleport(x, z, yaw), [ax, az, yawToward(ax, az, bx, bz)])
  }
  await sleep(1800)
  await shot(A, 'A-game')
  await shot(B, 'B-game')

  // ── 5. A leaves: B despawns Alice; A becomes a spectator who sees Bob ──────
  await A.bringToFront()
  await A.keyboard.press('Escape')
  const outA = await waitFor(A, () => !globalThis.__boots, null, 10000)
  if (!outA.ok) fail('A: Escape did not exit the game')
  await sleep(1200)
  const env = {
    aReloaded: (await loadStamp(A)) !== stamps.A,
    bReloaded: (await loadStamp(B)) !== stamps.B,
    // A re-armed drop veil after a consumed gate = module state reset = HMR
    // (other lanes hot-deploying into the dev copy mid-run).
    aVeilRearmed: !!(await evalSafe(A, () => document.querySelector('[data-boots-drop-veil]'))),
  }
  summary.steps.environment = env
  if (env.aReloaded || env.bReloaded || env.aVeilRearmed) {
    fail(`ENVIRONMENT: a page reloaded / HMR re-evaluated modules mid-run (${JSON.stringify(env)}) — concurrent hot-deploy; rerun`)
  }
  const gone = await waitFor(B, () => (globalThis.__boots?.presence?.().remotes?.length ?? -1) === 0, null, 4000)
  summary.steps.aliceDespawnedOnBMs = gone.ms
  if (!gone.ok) fail('B: Alice did not despawn within 4 s of A leaving')
  const aSpect = await waitFor(
    A,
    () => {
      const s = globalThis.__bootsSpectator?.snapshot?.()
      return !!s && s.bound && s.names.includes('Bob')
    },
    null,
    6000,
  )
  summary.steps.aSpectatesBobMs = aSpect.ms
  summary.steps.aSpectatorSnapshot = await spect(A)
  if (!aSpect.ok) fail('A: after Escape did not spectate Bob within 6 s')
  await sleep(700)
  const pillA = await pill(A)
  const reentry = await evalSafe(A, () => !!document.querySelector('[data-boots-reentry]'))
  summary.steps.suppressionOnA = { reentryPill: reentry, spectatorPill: pillA }
  if (reentry && pillA && pillA.display !== 'none') fail('A: spectator pill shown next to the reentry pill (two Jump-in buttons)')
  if (!reentry && (!pillA || pillA.display === 'none')) fail('A: no reentry pill and no spectator pill — no way back in')
  const chipB2 = await chipText(B)
  summary.steps.chipOnBAlone = chipB2
  if (chipB2 !== null) fail(`B: chip should be hidden when alone, got ${JSON.stringify(chipB2)}`)
  await shot(A, 'A-spectating')

  summary.bus = { A: await busStats(A), B: await busStats(B) }
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
  summary.consoleErrors = consoleErrors.slice(0, 8)
  summary.durationMs = Date.now() - T0
  console.log(JSON.stringify(summary))
  console.log(summary.ok ? 'PASS' : `FAIL: ${summary.failures.join(' | ')}`)
  if (KEEP_OPEN && browser) {
    log('KEEP_OPEN=1 — browser stays up; Ctrl-C to close and release the lock')
    await new Promise(() => {})
  }
  await shutdown(exitCode)
}
