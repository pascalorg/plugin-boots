/**
 * QA — THE DEPOT MIRROR: is it a REAL reflection?
 *
 * Owner ask (2026-08-31): "maybe somewhere in the depot with the guns you can
 * have a mirror so people check themselves". Second cut (2026-09-01): a genuine
 * planar reflection — a 1:1 body the main camera never sees, a mirrored camera
 * rendering the room into a target mapped on the glass, one pass, only while
 * someone stands in front of it. The optics are unit-tested (mirror-view.test.ts);
 * what a test cannot tell you is whether the pass actually runs in a live scene,
 * only when it should, whether the picture in the target is a picture of YOU,
 * and whether it hangs the right way up ON SCREEN — the first live run of this
 * cut photographed a perfect reflection upside down on the glass (three reads
 * render targets top-down; a plain plane's UVs run bottom-up). So this stands
 * the player in front of the mirror, reads the render target back, and then
 * reads the SCREEN back too.
 *
 * IT NEVER RE-DERIVES THE DEPOT'S PLACEMENT. The pane mesh is named
 * ('boots-mirror-pane') and registers as a collider, so the harness reads its
 * REAL matrixWorld out of world.colliders and works in that frame — position,
 * the pane's normal (its local +z) and its along-wall axis (its local +x).
 *
 * THE ONE-BROWSER RULE. Exactly one automation browser may run on this machine
 * at a time, behind the /tmp/boots-browser.lock mutex: taken before launch (with
 * stale-owner takeover), released on every exit path.
 *
 *   node docs/qa/qa-boots-mirror.mjs            # dev server on :3002, WebGL path
 *   WEBGPU=1 node docs/qa/qa-boots-mirror.mjs   # ask Chromium for WebGPU instead
 *   SCENE=<id> HEADED=1 node docs/qa/qa-boots-mirror.mjs
 *
 * A HEADED window is a real window: the physical mouse over it turns the
 * player. One headed run failed "turn your back" with a drifted eye position
 * while nothing else did — keep hands off the mouse during a headed run, and
 * treat a headed failure that a headless rerun does not reproduce as that.
 *
 * Shots: /tmp/boots-mirror-front.png, /tmp/boots-mirror-angle.png (the screen)
 * and /tmp/boots-mirror-target.png (the raw render target — pre-flip, so YOU
 * standing at pane +x appear LEFT of centre in it; the geometry's turned UVs
 * put that texel back at +x on the glass, which mirror-view.test.ts pins).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-mirror-profile'
const LOCK = '/tmp/boots-browser.lock'
const WANT_WEBGPU = Boolean(process.env.WEBGPU)
const VIEW = { height: 900, width: 1280 }
const log = (...a) => console.log(...a)

/** The 8 avatar tints (remote-players.AVATAR_PALETTE) — copied on purpose: the
 * check is "the glass shows OUR lot color", and a copy is what makes that an
 * independent assertion rather than a tautology. */
const PALETTE = ['d95d4e', '4d8fd1', '58b368', 'd8a13a', '9a6dd7', '45b8ac', 'd16fa8', '8a9a5b']

// ── the one-browser mutex ────────────────────────────────────────────────────
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const releaseLock = () => rmSync(LOCK, { force: true, recursive: true })
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
      releaseLock()
      continue
    }
    log('browser lock busy — waiting 20 s')
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
  log(`${name}: ${ok}  (${detail})`)
}

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: [
    WANT_WEBGPU ? '--enable-unsafe-webgpu' : '--disable-features=WebGPU',
    `--window-size=${VIEW.width},${VIEW.height}`,
  ],
  headless: !process.env.HEADED,
  viewport: VIEW,
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

const finish = async (code) => {
  log(`page errors: ${errors.length} ${errors.slice(0, 3).join(' | ')}`)
  await browser.close().catch(() => {})
  releaseLock()
  process.exit(code)
}

log(`goto ${URL}`)
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message))
await page.waitForTimeout(12000)
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')].find((b) => /jump in/i.test(b.textContent || ''))?.click()
})
await page.waitForTimeout(20000)
log(`phase: ${await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)}`)

// ── the pane's real frame, out of the live collider set ──────────────────────
const pane = await page.evaluate(() => {
  const world = globalThis.__boots?.world
  const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
  if (!entry) return null
  const mesh = entry.mesh
  mesh.updateWorldMatrix(true, false)
  const e = mesh.matrixWorld.elements
  const unit = (v) => {
    const len = Math.hypot(v[0], v[1], v[2]) || 1
    return [v[0] / len, v[1] / len, v[2] / len]
  }
  return {
    at: [e[12], e[13], e[14]],
    // Column 2 is the pane's local +z in world space: the direction it faces.
    normal: unit([e[8], e[9], e[10]]),
    // Column 0 is its local +x: along the wall, the glass's own "right".
    right: unit([e[0], e[1], e[2]]),
    geometry: mesh.geometry?.type ?? null,
    size: [mesh.geometry?.parameters?.width ?? null, mesh.geometry?.parameters?.height ?? null],
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
  }
})
log(`PANE FOUND: ${pane !== null}  ${pane ? JSON.stringify(pane) : ''}`)
if (!pane) await finish(1)

// The mirror's QA handle is new with the real reflection: its absence means the
// dev server is still serving the previous plugin build (bun file: deps are
// copies — rsync src/ into the editor's node_modules and reload).
const mirror = () => page.evaluate(() => globalThis.__boots?.mirror?.() ?? null)
const m0 = await mirror()
if (!m0) {
  log('STALE DEV SERVER: __boots.mirror() is missing — the editor is not running this plugin build')
  await finish(2)
}
const OUR_TINT = PALETTE[m0.paletteIndex % PALETTE.length]
const PANE_W = pane.size[0] ?? 1.04

/** How far the container's deck plate sits below the pane's centre — teleport
 * takes FEET, and the feet belong on the deck. MIRROR_SILL_Y + PANE_H/2 − 0.12,
 * kept as one number because the harness works in the pane's measured frame
 * and derives nothing else about the depot. */
const DECK_BELOW_PANE = 1.055
/** Camera height above the deck (collision.EYE_HEIGHT). */
const EYE_HEIGHT = 1.58

/** Stand `d` metres out from the pane along its normal, facing it (at the right
 * height, aimed at the middle of the glass), slid `side` metres along the
 * pane's own +x, turned `turn` radians off square. Player yaw convention:
 * forward = (-sin yaw, -cos yaw), so facing -normal is atan2(nx, nz). */
const standAt = async (d, side = 0, turn = 0) => {
  const [px, py, pz] = pane.at
  const [nx, , nz] = pane.normal
  const [rx, , rz] = pane.right
  const yaw = Math.atan2(nx, nz) + turn
  const feetY = py - DECK_BELOW_PANE
  const pitch = Math.atan2(py - (feetY + EYE_HEIGHT), Math.max(d, 0.3))
  await page.evaluate(
    (p) => globalThis.__boots.teleport(p.x, p.z, p.yaw, p.pitch, p.y),
    { pitch, x: px + nx * d + rx * side, y: feetY, yaw, z: pz + nz * d + rz * side },
  )
  await page.waitForTimeout(700)
}

/** The glass's current face: is the live reflection mapped on it right now? */
const glassShowsReflection = () =>
  page.evaluate(() => {
    const world = globalThis.__boots?.world
    const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
    const map = entry?.mesh?.material?.map ?? null
    return map ? map.isRenderTargetTexture === true : false
  })

/** Everything the scene knows about the 1:1 body right now. */
const readSelf = () =>
  page.evaluate(() => {
    const world = globalThis.__boots?.world
    const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
    const root = entry?.mesh?.parent
    const self = root?.children?.find((c) => c.name === 'boots-mirror-self')
    // __bootsPlayer.sample(): x/y/z are the FEET (collision capsule base).
    const player = globalThis.__bootsPlayer?.sample?.() ?? null
    if (!self) return null
    self.updateWorldMatrix(true, false)
    const e = self.matrixWorld.elements
    // The rig faces its own local -Z (remote-players' convention).
    const fwd = [-e[8], -e[9], -e[10]]
    const flen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1
    return {
      at: [e[12], e[13], e[14]],
      facing: [fwd[0] / flen, fwd[1] / flen, fwd[2] / flen],
      // The left leg's pivot: named on the model body (pascaline-model.ts), the
      // first child on the primitive fallback rig.
      legSwing: (self.getObjectByName('pivot-legL') ?? self.children?.[0])?.rotation?.x ?? null,
      body: self.getObjectByName('pivot-legL') ? 'model' : 'primitive',
      playerFeet: player ? [player.x, player.y, player.z] : null,
      speed: player?.speed ?? null,
      visible: self.visible,
    }
  })

/**
 * Read the live render target back and look at it: is it a picture (many
 * colors, real contrast), does it contain OUR tint, and where (median texel,
 * chest band). Pixels come back
 * linear (renderers tone-map only the output target) so they are gamma-encoded
 * before hue/luma and before the PNG. Row order is the backend's: bottom-up on
 * WebGL, top-down on WebGPU — `v` below is always measured UP from the sill.
 *
 * The tint match is deliberately tight (hue within 14°, saturation > 0.45,
 * chest band only): the first cut of this check used ±28° over the whole image
 * and the build bench's orange wood pulled the "vest" centroid a third of the
 * way across the glass.
 */
const analyze = (tintHex) =>
  page.evaluate(
    async ({ tintHex }) => {
      const px = await globalThis.__boots.mirrorPixels()
      const { size, backend } = globalThis.__boots.mirror()
      const [w, h] = size
      if (!px || px.length < w * h * 4) return null
      const rowsBottomUp = backend !== 'webgpu'
      const isByte = px instanceof Uint8Array || px instanceof Uint8ClampedArray
      const raw = (i) => (isByte ? px[i] / 255 : Math.min(1, Math.max(0, px[i])))
      const enc = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
      const hsv = (r, g, b) => {
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const d = max - min
        let hue = 0
        if (d > 1e-6) {
          if (max === r) hue = ((g - b) / d) % 6
          else if (max === g) hue = (b - r) / d + 2
          else hue = (r - g) / d + 4
          hue = (hue * 60 + 360) % 360
        }
        return [hue, max > 0 ? d / max : 0, max]
      }
      const t = Number.parseInt(tintHex, 16)
      const [tintHue] = hsv(((t >> 16) & 255) / 255, ((t >> 8) & 255) / 255, (t & 255) / 255)

      const distinct = new Set()
      let sum = 0
      let sumSq = 0
      let n = 0
      const tintUs = []
      const tintVs = []
      for (let row = 0; row < h; row += 2) {
        // v: 0 at the sill, 1 at the top of the glass, whatever the row order.
        const v = rowsBottomUp ? row / h : 1 - row / h
        const inChestBand = v > 0.55 && v < 0.85
        for (let x = 0; x < w; x += 2) {
          const i = (row * w + x) * 4
          const r = enc(raw(i))
          const g = enc(raw(i + 1))
          const b = enc(raw(i + 2))
          distinct.add((((r * 7) | 0) << 6) | (((g * 7) | 0) << 3) | ((b * 7) | 0))
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
          sum += luma
          sumSq += luma * luma
          n++
          if (!inChestBand) continue
          const [hue, s, val] = hsv(r, g, b)
          if (s > 0.45 && val > 0.15) {
            const dh = Math.abs(((hue - tintHue + 540) % 360) - 180)
            if (dh < 14) {
              tintUs.push(x / w)
              tintVs.push(v)
            }
          }
        }
      }
      const mean = sum / n
      const sd = Math.sqrt(Math.max(0, sumSq / n - mean * mean))
      // MEDIAN, not mean: the yard's red fence posts show in the glass too, a
      // few dozen texels that would drag a mean a hand's width off the vest.
      const median = (arr) => {
        if (!arr.length) return null
        const sorted = [...arr].sort((a, b) => a - b)
        return sorted[sorted.length >> 1]
      }
      const tintCount = tintUs.length

      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const img = ctx.createImageData(w, h)
      for (let row = 0; row < h; row++) {
        const outRow = rowsBottomUp ? h - 1 - row : row
        for (let x = 0; x < w; x++) {
          const s = (row * w + x) * 4
          const d = (outRow * w + x) * 4
          img.data[d] = Math.round(enc(raw(s)) * 255)
          img.data[d + 1] = Math.round(enc(raw(s + 1)) * 255)
          img.data[d + 2] = Math.round(enc(raw(s + 2)) * 255)
          img.data[d + 3] = 255
        }
      }
      ctx.putImageData(img, 0, 0)
      return {
        backend,
        distinct: distinct.size,
        isByte,
        mean,
        png: canvas.toDataURL('image/png'),
        sd,
        tintCount,
        tintU: median(tintUs),
        tintV: median(tintVs),
      }
    },
    { tintHex },
  )

/**
 * THE SCREEN, not the target: decode a screenshot in-page, project the pane's
 * corners through the live camera pose to find the glass on screen, and inside
 * that rectangle locate OUR tint (the vest) and the deep-tan leather (belt and
 * boots — saturation > 0.5 keeps skin out). Upright means the vest sits ABOVE
 * the leather. This is the check that would have caught the upside-down glass.
 */
const screenCheck = (pngBase64, tintHex) =>
  page.evaluate(
    async ({ pngBase64, tintHex }) => {
      const world = globalThis.__boots?.world
      const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
      const mesh = entry?.mesh
      if (!mesh) return null
      const V3 = mesh.position.constructor
      const Q = mesh.quaternion.constructor
      const { width: pw, height: ph } = mesh.geometry.parameters
      mesh.updateWorldMatrix(true, false)
      const pose = globalThis.__boots.cameraPose()
      const P = new V3(...pose.position)
      const qi = new Q(...pose.quaternion).invert()
      const W = innerWidth
      const H = innerHeight
      const tanHalf = Math.tan(((pose.fov / 2) * Math.PI) / 180)
      const aspect = W / H
      const toScreen = (local) => {
        const v = mesh.localToWorld(new V3(...local)).sub(P).applyQuaternion(qi)
        const ndcX = v.x / -v.z / (tanHalf * aspect)
        const ndcY = v.y / -v.z / tanHalf
        return [((ndcX + 1) / 2) * W, ((1 - ndcY) / 2) * H]
      }
      const corners = [
        toScreen([-pw / 2, -ph / 2, 0]),
        toScreen([pw / 2, -ph / 2, 0]),
        toScreen([pw / 2, ph / 2, 0]),
        toScreen([-pw / 2, ph / 2, 0]),
      ]
      const xs = corners.map((c) => c[0])
      const ys = corners.map((c) => c[1])
      const rect = {
        left: Math.max(0, Math.min(...xs) + 6),
        right: Math.min(W, Math.max(...xs) - 6),
        top: Math.max(0, Math.min(...ys) + 6),
        bottom: Math.min(H, Math.max(...ys) - 6),
      }

      const img = new Image()
      img.src = `data:image/png;base64,${pngBase64}`
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const data = ctx.getImageData(0, 0, img.width, img.height).data
      const sx = img.width / W
      const sy = img.height / H

      const hsv = (r, g, b) => {
        const max = Math.max(r, g, b)
        const min = Math.min(r, g, b)
        const d = max - min
        let hue = 0
        if (d > 1e-6) {
          if (max === r) hue = ((g - b) / d) % 6
          else if (max === g) hue = (b - r) / d + 2
          else hue = (r - g) / d + 4
          hue = (hue * 60 + 360) % 360
        }
        return [hue, max > 0 ? d / max : 0, max]
      }
      const t = Number.parseInt(tintHex, 16)
      const [tintHue] = hsv(((t >> 16) & 255) / 255, ((t >> 8) & 255) / 255, (t & 255) / 255)
      let vestN = 0
      let vestY = 0
      let leatherN = 0
      let leatherY = 0
      for (let y = Math.floor(rect.top); y < rect.bottom; y++) {
        for (let x = Math.floor(rect.left); x < rect.right; x++) {
          const i = (Math.floor(y * sy) * img.width + Math.floor(x * sx)) * 4
          const [hue, s, val] = hsv(data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
          if (val < 0.15) continue
          const dTint = Math.abs(((hue - tintHue + 540) % 360) - 180)
          if (s > 0.45 && dTint < 14) {
            vestN++
            vestY += y
          } else if (s > 0.5 && hue > 18 && hue < 40) {
            leatherN++
            leatherY += y
          }
        }
      }
      return {
        rect,
        vestN,
        vestY: vestN ? vestY / vestN : null,
        leatherN,
        leatherY: leatherN ? leatherY / leatherN : null,
      }
    },
    { pngBase64, tintHex },
  )

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const fmt = (v, d = 3) => (typeof v === 'number' ? v.toFixed(d) : String(v))

// ── 0. which renderer path are we actually on? ──────────────────────────────
await standAt(1.4)
const m1 = await mirror()
log(`mirror handle: ${JSON.stringify(m1)}`)
check(
  WANT_WEBGPU ? 'RUNNING ON WEBGPU (as asked)' : 'RUNNING ON THE WEBGL FALLBACK (as asked)',
  m1.backend === (WANT_WEBGPU ? 'webgpu' : 'webgl'),
  `backend '${m1.backend}'`,
)

// ── 1. no one at the glass: no pass ──────────────────────────────────────────
await standAt(30)
const farA = await mirror()
await page.waitForTimeout(1500)
const farB = await mirror()
check(
  'NO ONE AT THE GLASS, NO PASS',
  farB.engaged === false && farB.passes === farA.passes && (await glassShowsReflection()) === false,
  `engaged ${farB.engaged}, passes ${farA.passes} → ${farB.passes}, glass idle`,
)
// The first REAL pass used to hitch (pipelines for the target's format, the
// skinned body's first draw). The mirror now compiles into the target and runs
// one pass during the loading beat — so by the time anyone can walk up, at
// least one pass has already happened.
check('WARMED AT SESSION START', farA.passes >= 1, `${farA.passes} pass(es) before anyone approached`)

// ── 2. someone at the glass: the pass runs, every frame ──────────────────────
await standAt(1.4)
const nearA = await mirror()
await page.waitForTimeout(1000)
const nearB = await mirror()
check(
  'SOMEONE AT THE GLASS, THE PASS RUNS',
  nearB.engaged === true && nearB.passes > nearA.passes && (await glassShowsReflection()) === true,
  `engaged ${nearB.engaged}, passes ${nearA.passes} → ${nearB.passes}, glass live`,
)

// ── 3. turn your back and it stops (the pane is off screen) ──────────────────
await standAt(1.4, 0, Math.PI)
const awayA = await mirror()
await page.waitForTimeout(1000)
const awayB = await mirror()
check(
  'TURN YOUR BACK AND IT STOPS',
  awayB.engaged === false && awayB.passes === awayA.passes,
  `engaged ${awayB.engaged}, passes ${awayA.passes} → ${awayB.passes}`,
)

// ── 4. the picture: a picture, of you, centred when you stand square ─────────
await standAt(1.4)
const square = await analyze(OUR_TINT)
if (!square) {
  log('READBACK FAILED: mirrorPixels() returned nothing')
  await finish(1)
}
writeFileSync('/tmp/boots-mirror-target.png', Buffer.from(square.png.split(',')[1], 'base64'))
check(
  'THE GLASS SHOWS A PICTURE, NOT A COLOR',
  square.distinct > 24 && square.sd > 0.03,
  `${square.distinct} distinct colors, luma mean ${fmt(square.mean)} sd ${fmt(square.sd)}, ${square.isByte ? 'RGBA8' : 'float'}`,
)
check(
  'IT WEARS OUR LOT TINT, AT CHEST HEIGHT',
  square.tintCount > 30,
  `#${OUR_TINT} (slot ${m0.paletteIndex}) on ${square.tintCount} sampled texels in the chest band`,
)
check(
  'STAND SQUARE: YOUR VEST IS CENTRED',
  square.tintU !== null && Math.abs(square.tintU - 0.5) < 0.1,
  `vest centroid u ${fmt(square.tintU)} v ${fmt(square.tintV)} (v up from the sill)`,
)

// ── 5. handedness: step along the wall, the picture moves the OTHER way ──────
// The virtual camera's right is the pane's −x, so a player at +x lands LEFT of
// centre in the raw target (u = 0.5 − x/PANE_W); the turned UVs put that texel
// back at +x on the glass — exactly where the player stands. Checked both ways
// so a sign error cannot pass by luck.
const SIDE = 0.3
await standAt(1.4, SIDE)
const stepRight = await analyze(OUR_TINT)
await standAt(1.4, -SIDE)
const stepLeft = await analyze(OUR_TINT)
const expectRight = 0.5 - SIDE / PANE_W
const expectLeft = 0.5 + SIDE / PANE_W
check(
  'STEP ALONG THE WALL: THE PICTURE PUTS YOU WHERE A MIRROR WOULD',
  stepRight?.tintU != null &&
    stepLeft?.tintU != null &&
    Math.abs(stepRight.tintU - expectRight) < 0.1 &&
    Math.abs(stepLeft.tintU - expectLeft) < 0.1,
  `+${SIDE} m → u ${fmt(stepRight?.tintU)} (expect ${fmt(expectRight)}); −${SIDE} m → u ${fmt(stepLeft?.tintU)} (expect ${fmt(expectLeft)})`,
)

// ── 6. the body: full size, on the deck, facing the glass ────────────────────
await standAt(1.4)
const self = await readSelf()
check(
  'THE BODY IS THERE, AND HIDDEN FROM THE MAIN CAMERA',
  self !== null && self.visible === false,
  `visible ${self?.visible}, body: ${self?.body}`,
)
check('IT IS THE MASCOT MODEL, NOT THE BOX FALLBACK', self?.body === 'model', `body '${self?.body}'`)
if (self) {
  const rel = [self.at[0] - pane.at[0], self.at[1] - pane.at[1], self.at[2] - pane.at[2]]
  const standoff = dot(rel, pane.normal)
  // The rig's origin is its feet (a peer's root is planted on the ground), so
  // it must sit ON the player's feet — not scaled, not lifted onto a plinth.
  const feetGap = self.playerFeet
    ? Math.hypot(self.at[0] - self.playerFeet[0], self.at[1] - self.playerFeet[1], self.at[2] - self.playerFeet[2])
    : null
  check(
    'IT STANDS WHERE YOU STAND, AT 1:1',
    Math.abs(standoff - 1.4) < 0.15 && feetGap !== null && feetGap < 0.08,
    `standoff ${fmt(standoff)} m (you: 1.4), rig origin ${fmt(feetGap)} m from your feet`,
  )
  check(
    'IT FACES THE GLASS (SO THE GLASS SHOWS ITS FACE)',
    dot(self.facing, pane.normal) < -0.9,
    `facing·normal ${fmt(dot(self.facing, pane.normal))}`,
  )
}

// ── 7. it walks when you walk, and stops when you stop ───────────────────────
// A SPREAD, not one sample: the gait is a sine and headless runs at ~3 fps with
// dt capped to 1/30, so the phase crawls. Then a STANDSTILL FRAME the game
// itself calls still (speed < 0.02): articulate scales the gait by speed, so on
// that frame the swing must be exactly zero — never assert this on a wall clock.
const swingSpread = async (samples, gapMs) => {
  const swings = []
  const speeds = []
  for (let i = 0; i < samples; i++) {
    const d = await readSelf()
    if (typeof d?.legSwing === 'number') swings.push(d.legSwing)
    if (typeof d?.speed === 'number') speeds.push(d.speed)
    await page.waitForTimeout(gapMs)
  }
  return {
    spread: swings.length ? Math.max(...swings) - Math.min(...swings) : 0,
    topSpeed: speeds.length ? Math.max(...speeds) : 0,
  }
}
await standAt(4.0)
await page.keyboard.down('KeyW')
const walk = await swingSpread(12, 120)
await page.keyboard.up('KeyW')
await page.evaluate(() => globalThis.__boots.teleport(0, 0, 0)) // vel := 0
await standAt(1.6)
let stillFrame = null
let slowest = Number.POSITIVE_INFINITY
for (let i = 0; i < 40; i++) {
  const d = await readSelf()
  if (typeof d?.speed === 'number') {
    slowest = Math.min(slowest, d.speed)
    if (d.speed < 0.02) {
      stillFrame = d
      break
    }
  }
  await page.waitForTimeout(250)
}
// The live pose EASES toward its target (blendArticulation): on the very frame
// the game first calls the player still, the legs are still settling. The
// target has been zero since that frame, so HUNT for the frame where the ease
// has arrived — never wait a fixed time: headless game time crawls (dt capped
// at 1/30 at a few fps, slower still while the pass renders the scene twice).
let settled = null
if (stillFrame) {
  for (let i = 0; i < 40; i++) {
    const d = await readSelf()
    if (typeof d?.legSwing === 'number' && Math.abs(d.legSwing) < 5e-3 && d.speed < 0.02) {
      settled = d
      break
    }
    await page.waitForTimeout(250)
  }
}
const froze = settled !== null
check(
  'IT STRIDES WITH YOU, AND STOPS WHEN YOU STOP',
  walk.spread > 0.03 && froze,
  `walking swing spread ${fmt(walk.spread)} rad at up to ${fmt(walk.topSpeed, 1)} m/s → ` +
    (stillFrame
      ? `stopped at ${fmt(stillFrame.speed)} m/s (swing ${stillFrame.legSwing.toFixed(4)} rad, settling) → ${settled ? `settled at ${settled.legSwing.toFixed(5)} rad` : 'NEVER SETTLED within 10 s'}`
      : `NEVER STOPPED, slowest ${fmt(slowest)} m/s`),
)

// ── 8. the pass has a handle on the first-person gun ─────────────────────────
const gunNamed = await page.evaluate(() => {
  const world = globalThis.__boots?.world
  const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
  let root = entry?.mesh ?? null
  while (root?.parent) root = root.parent
  return root?.getObjectByName?.('boots-viewmodel') != null
})
check('THE PASS CAN FIND THE GUN TO HIDE IT', gunNamed, `scene.getObjectByName('boots-viewmodel') ${gunNamed ? 'found' : 'MISSING'}`)

// ── 9. the screen: the glass hangs the right way up ──────────────────────────
// Headless Chromium does not composite a WebGPU canvas into screenshots (the
// capture is black under the DOM HUD), so on that path this check needs a real
// window: HEADED=1 WEBGPU=1. Reported as skipped, never as green.
await standAt(1.4)
const front = await page.screenshot({ path: '/tmp/boots-mirror-front.png' })
const screen = await screenCheck(front.toString('base64'), OUR_TINT)
if (m1.backend === 'webgpu' && !process.env.HEADED) {
  log(
    `ON SCREEN, THE REFLECTION IS UPRIGHT: skipped  (headless WebGPU canvases do not composite into screenshots — rerun with HEADED=1 WEBGPU=1; saw vest ${screen?.vestN ?? 0} px)`,
  )
} else {
  check(
    'ON SCREEN, THE REFLECTION IS UPRIGHT: VEST ABOVE BELT AND BOOTS',
    screen !== null &&
      screen.vestN > 40 &&
      screen.leatherN > 40 &&
      screen.vestY < screen.leatherY &&
      screen.vestY > screen.rect.top &&
      screen.vestY < screen.rect.bottom,
    screen
      ? `glass on screen y ${fmt(screen.rect.top, 0)}–${fmt(screen.rect.bottom, 0)}; vest ${screen.vestN} px at y ${fmt(screen.vestY, 0)}, leather ${screen.leatherN} px at y ${fmt(screen.leatherY, 0)}`
      : 'no pane / no pose',
  )
}

// ── 10. the eyeball check ────────────────────────────────────────────────────
// The three grips, square in the glass at a stride and a half: a long gun
// (two hands, forearm level), a pistol (both hands out), a tool (one relaxed
// hand). And the walk: a mid-stride frame with the rifle. These are for a
// human to read — the articulation is unit-tested; how it LOOKS is not.
const shotWith = async (weapon, name) => {
  await page.evaluate((w) => {
    const st = globalThis.__boots.state()
    st.giveWeapon?.(w)
    st.setWeapon(w)
  }, weapon)
  await page.waitForTimeout(400)
  await page.screenshot({ path: `/tmp/boots-mirror-${name}.png` })
}
await standAt(1.6)
await shotWith('rifle', 'rifle')
await shotWith('pistol', 'pistol')
await shotWith('knife', 'knife')
// Mid-stride: walk at the glass from 3 m and shoot when the leg swing is large.
await page.evaluate(() => globalThis.__boots.state().setWeapon('rifle'))
await standAt(3.0)
await page.keyboard.down('KeyW')
for (let i = 0; i < 25; i++) {
  const d = await readSelf()
  if (typeof d?.legSwing === 'number' && Math.abs(d.legSwing) > 0.3) break
  await page.waitForTimeout(80)
}
await page.screenshot({ path: '/tmp/boots-mirror-stride.png' })
await page.keyboard.up('KeyW')
// Knife in hand for the angle shot: the builder paints its blue placement
// ghost over whatever wall you look at, which is the game working, not the
// mirror — but it hides the picture this shot exists for.
await page.evaluate(() => globalThis.__boots.state().setWeapon('knife'))
await standAt(2.2, 0.6)
await page.screenshot({ path: '/tmp/boots-mirror-angle.png' })
log(
  'shots: /tmp/boots-mirror-front.png /tmp/boots-mirror-angle.png /tmp/boots-mirror-target.png ' +
    '/tmp/boots-mirror-{rifle,pistol,knife,stride}.png',
)

const passed = results.filter(Boolean).length
log(`RESULT: ${passed}/${results.length} checks green  [${m1.backend}]`)
await finish(passed === results.length ? 0 : 1)
