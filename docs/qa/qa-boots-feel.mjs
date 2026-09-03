/**
 * FIRST-PERSON FEEL — compact trace check against the local dev server (:3002).
 *
 * The unit tests (feel.test.ts) pin the MATH; this is the one machine check that
 * the WIRING is right: the camera actually dips on landing, the strafe roll has
 * the intended sign on screen, footsteps reach the sample, the eye does not buzz
 * after a stop, a hit shakes the camera, a walkable slope is ridden with the
 * camera ON the true eye (no step-ease lag), and leaving the game rewinds the
 * R3F clock so the editor's first frame carries a small positive dt.
 *
 *   node docs/qa/qa-boots-feel.mjs            # headless, ~60 s
 *   HEADED=1 node docs/qa/qa-boots-feel.mjs   # watch it
 *   SCENE=<id> SHOT_PREFIX=/tmp/feel           # knobs
 *
 * Takes the machine-wide browser mutex /tmp/boots-browser.lock (waits if busy,
 * reclaims a dead owner), ONE browser, closed on every exit path. Pointer lock
 * and fullscreen are denied in the page (session.ts treats a LOST lock as Esc;
 * unlocked sessions are explicitly playable). Nothing under src/ is touched.
 *
 * Screenshots: <prefix>-1-run.png, -2-stop.png, -3-land.png, -4-hurt.png.
 * Exit code 0 = every check passed, 1 = a check failed, 2 = harness exception.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-feel-profile'
const LOCK = '/tmp/boots-browser.lock'
const SHOT = process.env.SHOT_PREFIX ?? '/tmp/feel'
/** Small on purpose: headless software WebGL on a loaded machine renders this
 * scene at a few fps at 1280×900; every check here is a trace, not a picture. */
const VIEW = { height: 600, width: 960 }
const EYE_HEIGHT = 1.58
const BOB_STRIDE = 2.3
const log = (...a) => console.log(...a)

// ── the one-browser mutex ────────────────────────────────────────────────────
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const releaseLock = () => {
  try {
    if (readFileSync(`${LOCK}/owner`, 'utf8').trim() === String(process.pid)) {
      rmSync(LOCK, { force: true, recursive: true })
    }
  } catch {}
}
for (;;) {
  try {
    mkdirSync(LOCK)
    writeFileSync(`${LOCK}/owner`, String(process.pid))
    break
  } catch {
    let owner = null
    try {
      owner = Number(readFileSync(`${LOCK}/owner`, 'utf8'))
    } catch {}
    if (owner && !alive(owner)) {
      log(`browser lock held by dead pid ${owner} — taking it over`)
      rmSync(LOCK, { force: true, recursive: true })
      continue
    }
    log(`browser lock busy (pid ${owner}) — waiting 20 s`)
    await new Promise((r) => setTimeout(r, 20000))
  }
}
process.on('exit', releaseLock)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// ── scoring ──────────────────────────────────────────────────────────────────
const results = []
const check = (name, ok, detail) => {
  results.push(ok === true)
  log(`${ok === true ? 'PASS' : 'FAIL'} ${name}  (${detail})`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── page-side hooks (init scripts) ───────────────────────────────────────────
/** Deny pointer lock + fullscreen: a lost lock reads as Esc in session.ts. */
function installCaptureGuard() {
  try {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true })
  } catch {}
  const denied = () => Promise.reject(new DOMException('QA: capture disabled', 'NotAllowedError'))
  try {
    Element.prototype.requestPointerLock = denied
  } catch {}
  try {
    Element.prototype.requestFullscreen = denied
  } catch {}
}

/** A devtools-hook stub that records R3F roots → `__feelStore()` = the viewer's zustand store. */
function installSceneHook() {
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
  globalThis.__feelStore = () => {
    for (const root of roots) {
      try {
        const store = root.containerInfo
        if (store?.getState?.()?.scene?.isScene) return store
      } catch {}
    }
    return null
  }
}

// ── the run ──────────────────────────────────────────────────────────────────
const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', `--window-size=${VIEW.width},${VIEW.height}`],
  headless: !process.env.HEADED,
  viewport: VIEW,
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
// Network 404s (a host asset, a favicon) are console noise, not page errors —
// the check is for exceptions and the frame guard's '[boots] frame crash' lines.
const NOISE = /pointer lock|PointerLock|favicon|Permissions policy|autoplay|React DevTools|ERR_ABORTED|Failed to load resource/i
page.on('pageerror', (e) => errors.push(String(e).slice(0, 240)))
page.on('console', (m) => {
  const t = m.text()
  if (m.type() === 'error' && !NOISE.test(t)) errors.push(t.slice(0, 240))
})

const finish = async (code) => {
  log(`page errors: ${errors.length}${errors.length ? ` — ${errors.slice(0, 4).join(' | ')}` : ''}`)
  await browser.close().catch(() => {})
  releaseLock()
  process.exit(code)
}

const evalSafe = (fn, arg) => page.evaluate(fn, arg).catch((e) => (log('eval:', e.message), null))
const sample = () => evalSafe(() => globalThis.__bootsPlayer?.sample?.() ?? null)
const startTrace = () =>
  evalSafe(() => {
    globalThis.__feelTrace = []
    globalThis.__feelRecording = true
    const loop = () => {
      if (!globalThis.__feelRecording) return
      const s = globalThis.__bootsPlayer?.sample?.()
      if (s) globalThis.__feelTrace.push({ t: performance.now(), ...s })
      requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
  })
const stopTrace = () =>
  evalSafe(() => {
    globalThis.__feelRecording = false
    const out = globalThis.__feelTrace ?? []
    globalThis.__feelTrace = []
    return out
  })
const teleport = (x, z, yaw) => evalSafe(([x, z, yaw]) => globalThis.__boots?.teleport?.(x, z, yaw), [x, z, yaw])
const dist = (a, b) => Math.hypot(b.x - a.x, b.z - a.z)
const eyeOffset = (s) => s.camY - (s.y + EYE_HEIGHT)
/**
 * GAME time, not wall time: a slow headless page (software GL, a loaded
 * machine) runs the loop at a few fps and the game clamps dt to 1/30, so one
 * wall second can be 0.2 s of game. Every hold/record below is paced on the
 * session clock the sample carries; `maxWallMs` is only a watchdog.
 */
const gameClock = async () => (await sample())?.clock ?? 0
const waitGameSeconds = async (seconds, maxWallMs = 20000) => {
  const start = await gameClock()
  const t0 = Date.now()
  while ((await gameClock()) - start < seconds) {
    if (Date.now() - t0 > maxWallMs) {
      const s = await sample()
      const st = await evalSafe(() => globalThis.__feelDtStats?.() ?? null)
      log(
        `  (watchdog: ${seconds} s of game time took > ${maxWallMs} ms wall) sample=${JSON.stringify(
          s && {
            clock: +s.clock.toFixed(2),
            loopCalls: s.loopCalls,
            loopNoSession: s.loopNoSession,
            speed: +s.speed.toFixed(2),
            grounded: s.grounded,
            health: s.health,
          },
        )} r3f=${JSON.stringify(st)}`,
      )
      break
    }
    await sleep(25)
  }
}

try {
  await page.addInitScript(installCaptureGuard)
  await page.addInitScript(installSceneHook)
  log(`goto ${URL}`)
  await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message))
  await page
    .waitForFunction(() => !!document.querySelector('[data-boots-drop-veil]') || /jump in/i.test(document.body.innerText), null, {
      timeout: 90000,
    })
    .catch(() => log('no drop veil / Jump in offer within 90 s'))
  const nameInput = page.locator('[data-boots-name-input]')
  if ((await nameInput.count()) > 0) await nameInput.first().fill('Feel').catch(() => {})
  const veilButton = page.locator('[data-boots-drop-veil] button', { hasText: /jump in/i })
  try {
    await veilButton.first().waitFor({ state: 'visible', timeout: 20000 })
    await veilButton.first().click()
  } catch {
    await page.getByRole('button', { name: /jump in/i }).first().click({ timeout: 8000 })
  }
  await page.waitForFunction(() => !!globalThis.__bootsPlayer?.sample?.(), null, { timeout: 60000 })
  log('in game (__bootsPlayer.sample present) — settling 3 s')
  await page.bringToFront()
  // Whole-session R3F delta probe (same internal subscription useFrame takes):
  // tells a frozen game clock apart from a starved rAF — `__feelDts` holds the
  // last 4000 deltas, `__feelDtStats()` summarizes them.
  const probe = await evalSafe(() => {
    const store = globalThis.__feelStore?.()
    if (!store) return 'no-store'
    const s = store.getState()
    globalThis.__feelDts = []
    globalThis.__feelDtNeg = 0
    globalThis.__feelDtNaN = 0
    globalThis.__feelDtCount = 0
    const ref = {
      current: (_st, delta) => {
        globalThis.__feelDtCount++
        if (Number.isNaN(delta)) globalThis.__feelDtNaN++
        else if (delta <= 0) globalThis.__feelDtNeg++
        globalThis.__feelDts.push(delta)
        if (globalThis.__feelDts.length > 4000) globalThis.__feelDts.shift()
      },
    }
    s.internal.subscribe(ref, 0, store)
    globalThis.__feelDtStats = () => {
      const d = globalThis.__feelDts
      return {
        frames: globalThis.__feelDtCount,
        neg: globalThis.__feelDtNeg,
        nan: globalThis.__feelDtNaN,
        min: d.length ? Math.min(...d) : null,
        max: d.length ? Math.max(...d) : null,
        last: d.slice(-6).map((x) => +x.toFixed(4)),
        clock: s.clock.elapsedTime,
        renderPaused: globalThis.__feelViewerPaused?.() ?? 'n/a',
      }
    }
    return 'ok'
  })
  log(`R3F delta probe: ${probe}`)
  await sleep(3000)

  const start = await sample()
  if (!start) throw new Error('no player sample')
  const yaw0 = start.yaw
  log(`spawn (${start.x.toFixed(2)}, ${start.y.toFixed(2)}, ${start.z.toFixed(2)}) yaw ${yaw0.toFixed(2)} footsteps ${start.footsteps}`)

  // ── (1) run 2 s, stop, record 1 s more ──────────────────────────────────────
  const fpsT0 = Date.now()
  const fpsC0 = await gameClock()
  await startTrace()
  await page.keyboard.down('KeyW')
  await waitGameSeconds(1.2)
  await page.screenshot({ path: `${SHOT}-1-run.png` })
  await waitGameSeconds(0.8)
  await page.keyboard.up('KeyW')
  await waitGameSeconds(1.0)
  await page.screenshot({ path: `${SHOT}-2-stop.png` })
  const runTrace = await stopTrace()
  {
    const s = await sample()
    log(
      `  pace: ${((await gameClock()) - fpsC0).toFixed(2)} s of game in ${((Date.now() - fpsT0) / 1000).toFixed(1)} s wall, ${runTrace.length} frames; loop calls ${s?.loopCalls} (no-session returns ${s?.loopNoSession})`,
    )
  }
  {
    const first = runTrace[0]
    const last = runTrace[runTrace.length - 1]
    const travel = first && last ? dist(first, last) : 0
    const steps = first && last ? last.footsteps - first.footsteps : -1
    const expected = Math.round(travel / BOB_STRIDE)
    const topSpeed = Math.max(...runTrace.map((s) => s.speed))
    check(
      '1a footsteps track travel (±1 of travel/2.3)',
      travel > 2 && Math.abs(steps - expected) <= 1,
      `travel ${travel.toFixed(2)} m, steps ${steps}, expected ${expected}, top speed ${topSpeed.toFixed(2)}, frames ${runTrace.length}`,
    )
    // After the key-up: once speed < 0.5 the eye offset must release monotonically
    // (no alternating jumps) and never move more than 10 mm per frame.
    let worst = 0
    let reversals = 0
    let stopped = -1
    for (let i = 1; i < runTrace.length; i++) {
      const s = runTrace[i]
      if (stopped < 0 && s.speed < 0.5 && i > runTrace.length / 2) stopped = i
      if (stopped < 0) continue
      const d = eyeOffset(s) - eyeOffset(runTrace[i - 1])
      worst = Math.max(worst, Math.abs(d))
      if (d > 5e-4) reversals++
    }
    const settled = runTrace.slice(-10).every((s) => Math.abs(eyeOffset(s)) < 0.002)
    check(
      '1b no eye buzz after the stop (≤ 10 mm/frame, monotone release, settles)',
      stopped > 0 && worst <= 0.01 && reversals === 0 && settled,
      `stop frame ${stopped}/${runTrace.length}, worst ${(worst * 1000).toFixed(2)} mm, reversals ${reversals}, settled ${settled}`,
    )
    const bobPeak = Math.max(...runTrace.filter((s) => s.speed > 5).map((s) => eyeOffset(s)), 0)
    check('1c the camera bobs while running (peak eye offset 1.5–4 cm)', bobPeak > 0.015 && bobPeak < 0.04, `peak ${(bobPeak * 1000).toFixed(1)} mm`)
  }

  // ── (2) jump: camera dips ≥ 3 cm on landing, back to 0 within 0.5 s ────────
  await waitGameSeconds(0.5)
  await startTrace()
  await page.keyboard.down('Space')
  await waitGameSeconds(0.12)
  await page.keyboard.up('Space')
  // Airtime at jumpSpeed 5.4 / gravity 16 is 0.675 s; the dip peaks 0.16 s later.
  await waitGameSeconds(0.72)
  await page.screenshot({ path: `${SHOT}-3-land.png` })
  await waitGameSeconds(0.7)
  const jumpTrace = await stopTrace()
  {
    let landAt = -1
    for (let i = 1; i < jumpTrace.length; i++) {
      if (!jumpTrace[i - 1].grounded && jumpTrace[i].grounded) {
        landAt = i
        break
      }
    }
    const left = jumpTrace.some((s) => !s.grounded)
    let minOff = 0
    let dipZeroAt = -1
    let maxDip = 0
    if (landAt >= 0) {
      const tLand = jumpTrace[landAt].clock
      for (let i = landAt; i < jumpTrace.length; i++) {
        const s = jumpTrace[i]
        const since = (s.clock - tLand) * 1000 // game ms since touchdown
        if (since <= 350) minOff = Math.min(minOff, eyeOffset(s))
        maxDip = Math.max(maxDip, s.dip)
        if (since > 100 && s.dip === 0 && dipZeroAt < 0) dipZeroAt = since
      }
    }
    check(
      '2 landing dip: eye sinks ≥ 3 cm within 0.35 s of touchdown, dip back to 0 within 0.5 s',
      left && landAt >= 0 && minOff <= -0.03 && dipZeroAt > 0 && dipZeroAt <= 500,
      `airborne ${left}, land frame ${landAt}, min eye offset ${(minOff * 1000).toFixed(1)} mm, max dip ${(maxDip * 1000).toFixed(1)} mm, dip→0 at ${dipZeroAt.toFixed(0)} game-ms`,
    )
  }

  // ── (3) right strafe: roll < 0 (leans right), back to 0 after release ──────
  // Face so that "right" is the direction the walk just proved has room.
  await teleport(start.x, start.z, yaw0 + Math.PI / 2)
  await waitGameSeconds(0.4)
  await startTrace()
  await page.keyboard.down('KeyD')
  await waitGameSeconds(1.0)
  const midStrafe = await sample()
  await page.keyboard.up('KeyD')
  await waitGameSeconds(0.6)
  const strafeTrace = await stopTrace()
  {
    const held = strafeTrace.filter((s, i) => i > strafeTrace.length * 0.35 && s.speed > 3)
    const rollHeld = held.length ? held.reduce((a, s) => a + s.roll, 0) / held.length : 0
    const tail = strafeTrace.slice(-5)
    const rollTail = Math.max(...tail.map((s) => Math.abs(s.roll)))
    const lateral = midStrafe ? midStrafe.speed : 0
    check(
      '3 right strafe leans RIGHT (roll ≤ −0.01) and releases to |roll| < 1e-3',
      rollHeld <= -0.01 && rollTail < 1e-3,
      `mean roll while held ${rollHeld.toFixed(4)} (speed ${lateral.toFixed(2)}, ${held.length} frames), tail |roll| ${rollTail.toExponential(2)}`,
    )
  }

  // ── (4) being hit: shake ≥ 1, head knocked away, both decay ────────────────
  await waitGameSeconds(0.3)
  await startTrace()
  await evalSafe(() => globalThis.__bootsPlayer.damage(10, { x: 1, z: 0 }))
  await waitGameSeconds(0.05, 2000)
  await page.screenshot({ path: `${SHOT}-4-hurt.png` })
  await waitGameSeconds(1.1)
  const hurtTrace = await stopTrace()
  {
    const early = hurtTrace.slice(0, 4)
    const shakeNow = Math.max(...early.map((s) => s.shake), 0)
    const rollNow = early.find((s) => Math.abs(s.hurtRoll) > 1e-4)
    const last = hurtTrace[hurtTrace.length - 1]
    // Push +x → attacker at −x; with yaw0+π/2 the bearing is what the game
    // computes — we only pin "non-zero then decays", the SIGN is pinned by the
    // unit tests against the same bearing formula.
    check(
      '4 hit: shake ≥ 1.0 within 2 frames, hurtRoll ≠ 0, both < 1e-3 after 1 s',
      shakeNow >= 1.0 && !!rollNow && last && last.shake < 1e-3 && Math.abs(last.hurtRoll) < 1e-3,
      `shake ${shakeNow.toFixed(2)}, hurtRoll ${rollNow ? rollNow.hurtRoll.toFixed(4) : 'none'}, after 1 s shake ${last?.shake} roll ${last ? Math.abs(last.hurtRoll).toExponential(2) : '?'}`,
    )
  }

  // ── (7) slopes: the camera rides the TRUE eye on a walkable slope ──────────
  // Review fix (2026-09-02): smoothEyeY used to ease the slope's per-frame rise
  // like a step-offset lift — 24 cm below the true eye on a 43° stairs sprint at
  // 60 Hz, 14 cm at 30 Hz. Find the biggest upward-facing 16–49° faces in the
  // scene geometry, stand on one, sprint "uphill" then the other way, and pin
  // the DIP-CORRECTED camera offset (camY − true eye + landing dip) on STEADY
  // slope frames (contact normal unchanged, speed > 5) to the bob band: the
  // bob is 0…28 mm above the eye, nothing else may show. A face with no
  // collider under it (the player drops through to a floor) yields no slope
  // frames and the next candidate is tried; none usable = SKIP, not FAIL.
  const slopes = await evalSafe(() => {
    const store = globalThis.__feelStore?.()
    const scene = store?.getState?.()?.scene
    if (!scene) return null
    const V = scene.position.constructor
    const a = new V()
    const b = new V()
    const c = new V()
    const n = new V()
    const ab = new V()
    const ac = new V()
    const out = []
    let meshes = 0
    const shown = (o) => {
      for (let p = o; p; p = p.parent) if (p.visible === false) return false
      return true
    }
    scene.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position || o.isInstancedMesh) return
      if (o.userData?.__boots || !shown(o)) return
      const pos = o.geometry.attributes.position
      const idx = o.geometry.index
      const tris = Math.floor((idx ? idx.count : pos.count) / 3)
      if (tris < 1 || tris > 40000) return
      meshes++
      const acc = new Map()
      for (let t = 0; t < tris; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2
        a.fromBufferAttribute(pos, i0).applyMatrix4(o.matrixWorld)
        b.fromBufferAttribute(pos, i1).applyMatrix4(o.matrixWorld)
        c.fromBufferAttribute(pos, i2).applyMatrix4(o.matrixWorld)
        ab.subVectors(b, a)
        ac.subVectors(c, a)
        n.crossVectors(ab, ac)
        const twice = n.length()
        if (twice < 1e-6) continue
        n.divideScalar(twice)
        if (n.y < 0.66 || n.y > 0.96) continue
        const key = `${n.x.toFixed(2)},${n.y.toFixed(2)},${n.z.toFixed(2)}`
        const e = acc.get(key) ?? { area: 0, cx: 0, cy: 0, cz: 0, nx: n.x, ny: n.y, nz: n.z }
        const w = twice / 2
        e.area += w
        e.cx += (w * (a.x + b.x + c.x)) / 3
        e.cy += (w * (a.y + b.y + c.y)) / 3
        e.cz += (w * (a.z + b.z + c.z)) / 3
        acc.set(key, e)
      }
      for (const e of acc.values()) {
        if (e.area < 1.5) continue
        out.push({
          name: `${o.name || o.type}/${o.parent?.name ?? ''}`.slice(0, 60),
          area: e.area,
          x: e.cx / e.area,
          y: e.cy / e.area,
          z: e.cz / e.area,
          nx: e.nx,
          ny: e.ny,
          nz: e.nz,
          deg: (Math.acos(e.ny) * 180) / Math.PI,
        })
      }
    })
    out.sort((p, q) => q.area - p.area)
    return { meshes, slopes: out.slice(0, 3) }
  })
  log(
    `  slope scan: ${slopes?.meshes ?? '?'} meshes, candidates ${JSON.stringify(
      slopes?.slopes?.map((s) => ({ deg: +s.deg.toFixed(0), x: +s.x.toFixed(1), y: +s.y.toFixed(1), z: +s.z.toFixed(1), area: +s.area.toFixed(0) })) ?? [],
    )}`,
  )
  {
    let slopeDetail = 'no walkable slope face (16–49°, ≥ 1.5 m²) with a collider under it'
    let slopeOk = null
    for (const cand of slopes?.slopes ?? []) {
      const h = Math.hypot(cand.nx, cand.nz)
      if (h < 1e-4) continue
      // Uphill on the plane = away from the normal's horizontal lean; the
      // player's forward is (−sin yaw, −cos yaw).
      const dx = -cand.nx / h
      const dz = -cand.nz / h
      const yawUp = Math.atan2(-dx, -dz)
      const legs = []
      for (const [label, yaw] of [['up', yawUp], ['down', yawUp + Math.PI]]) {
        await evalSafe(([x, z, yaw, y]) => globalThis.__boots?.teleport?.(x, z, yaw, 0, y), [cand.x, cand.z, yaw, cand.y + 0.05])
        await waitGameSeconds(0.4)
        await startTrace()
        await page.keyboard.down('KeyW')
        await waitGameSeconds(0.7)
        await page.keyboard.up('KeyW')
        const tr = await stopTrace()
        const steady = tr.filter(
          (s, i) => i > 0 && s.grounded && tr[i - 1].grounded && s.groundNy < 0.985 && Math.abs(s.groundNy - tr[i - 1].groundNy) < 0.02 && s.speed > 5,
        )
        const corr = steady.map((s) => eyeOffset(s) + s.dip)
        legs.push({
          label,
          frames: steady.length,
          total: tr.length,
          min: corr.length ? Math.min(...corr) : Number.NaN,
          max: corr.length ? Math.max(...corr) : Number.NaN,
          ny: steady.length ? steady.reduce((acc, s) => acc + s.groundNy, 0) / steady.length : Number.NaN,
          rise: steady.length > 1 ? (steady[steady.length - 1].y - steady[0].y) / Math.max(1e-3, steady[steady.length - 1].clock - steady[0].clock) : 0,
        })
      }
      log(
        `  slope ${cand.deg.toFixed(0)}° @ (${cand.x.toFixed(1)}, ${cand.z.toFixed(1)}): ${legs
          .map((l) => `${l.label} ${l.frames}/${l.total} steady slope frames, corrected offset ${(l.min * 1000).toFixed(0)}…${(l.max * 1000).toFixed(0)} mm, ny ${l.ny.toFixed(3)}, rise ${l.rise.toFixed(2)} m/s`)
          .join(' | ')}`,
      )
      const usable = legs.filter((l) => l.frames >= 6)
      if (usable.length === 0) continue
      // Bob band 0…28 mm; the OLD ease sat ≥ 34 mm low (up) / high (down) at
      // 30 Hz even on a gentle 1.5 m/s rise, 140–240 mm on a 43° sprint.
      slopeOk = usable.every((l) => l.min > -0.02 && l.max < 0.045)
      slopeDetail = `${cand.deg.toFixed(0)}° face: ${usable.map((l) => `${l.label} ${(l.min * 1000).toFixed(0)}…${(l.max * 1000).toFixed(0)} mm over ${l.frames} frames (rise ${l.rise.toFixed(2)} m/s)`).join(', ')}`
      break
    }
    if (slopeOk === null) log(`SKIP 7 slope ride (${slopeDetail})`)
    else check('7 riding a walkable slope keeps the camera on the true eye (dip-corrected offset within the 0…28 mm bob band)', slopeOk, slopeDetail)
  }
  // Back to the spawn for the exit probe.
  await teleport(start.x, start.z, yaw0)
  await waitGameSeconds(0.3)

  // ── (5) exit: the editor's first frames after the booster carry dt > 0 ─────
  const inGame = await evalSafe(() => globalThis.__feelDtStats?.() ?? null)
  const dtProbe = probe
  await evalSafe(() => {
    globalThis.__feelDts = []
    globalThis.__feelDtNeg = 0
    globalThis.__feelDtNaN = 0
  })
  await page.keyboard.press('Escape')
  await page
    .waitForFunction(() => !globalThis.__bootsPlayer && (globalThis.__feelDts?.length ?? 0) >= 8, null, { timeout: 15000 })
    .catch(() => log('  (fewer than 8 editor frames within 15 s)'))
  const exited = await evalSafe(() => !globalThis.__bootsPlayer)
  const dts = (await evalSafe(() => globalThis.__feelDts ?? [])) ?? []
  const after = await evalSafe(() => globalThis.__feelStore?.()?.getState()?.clock?.elapsedTime ?? null)
  {
    const minDt = dts.length ? Math.min(...dts) : Number.NaN
    const maxDt = dts.length ? Math.max(...dts) : Number.NaN
    // Bounded on BOTH sides. The clock has exactly two wrong states: never
    // rewound → the first resumed frame carries −span (negative dt), or
    // resumed from a different epoch → +span. So the bound is RELATIVE to the
    // R3F session span (the booster advances the clock ≤ 50 ms per rAF), not
    // an absolute few hundred ms: the host limiter (createFrameClock) resumes
    // from where it paused and every delta is a WALL gap between rAFs — on a
    // 1.5 fps software-GL page at load 6.5 a single editor re-render stalled
    // 2.2–2.8 s (frame 4 after Esc, with frames 1–3 at 0.05/0.05/0.04), which
    // is a stall, not an epoch error. Half the span catches both epoch
    // failures and tolerates any stall shorter than half the session.
    const span = inGame?.clock != null && after != null ? inGame.clock - after : Number.NaN
    log(`  editor dts after Esc: ${dts.map((d) => +d.toFixed(3)).join(' ')} (R3F session span ${span.toFixed(2)} s)`)
    check(
      '5 Esc exits cleanly; the first editor frame and every later one carry 0 ≤ dt < span/2 (clock epoch restored)',
      exited === true && dtProbe === 'ok' && dts.length > 5 && minDt >= 0 && span > 2 && maxDt < 0.5 * span,
      `exited ${exited}, probe ${dtProbe}, editor frames ${dts.length}, dt min ${minDt.toFixed(4)} max ${maxDt.toFixed(4)}, clock ${inGame?.clock?.toFixed?.(2)} → ${after?.toFixed?.(2)}; in-game frames ${inGame?.frames}, non-positive ${inGame?.neg}, NaN ${inGame?.nan}`,
    )
  }
  check('6 no page errors during the run', errors.length === 0, `${errors.length} error(s)`)

  const passed = results.filter(Boolean).length
  log(`\n${passed}/${results.length} checks passed — screenshots ${SHOT}-1-run.png … ${SHOT}-4-hurt.png`)
  await finish(passed === results.length ? 0 : 1)
} catch (e) {
  log('harness exception:', e?.stack ?? e)
  await finish(2)
}
