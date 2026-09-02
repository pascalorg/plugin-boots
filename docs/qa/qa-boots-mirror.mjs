/**
 * QA — THE DEPOT MIRROR: does the reflection actually behave like one?
 *
 * Owner ask (2026-08-31): "maybe somewhere in the depot with the guns you can
 * have a mirror so people check themselves". The math is unit-tested
 * (depot-mirror.test.ts); what a test cannot tell you is whether the cabinet
 * landed where the depot really is, whether the dummy wakes up when you walk
 * over, and whether it turns the RIGHT way in a live scene. So this stands the
 * player in front of the glass and asks the scene graph.
 *
 * IT NEVER RE-DERIVES THE DEPOT'S PLACEMENT. The pane mesh is named
 * ('boots-mirror-pane') and registers as a collider, so the harness reads its
 * REAL matrixWorld out of world.colliders and works in that frame — position
 * and the pane's own normal (its local +z axis). A harness that recomputed
 * depotLocalToWorld could agree with itself while disagreeing with the game.
 *
 *   node docs/qa/qa-boots-mirror.mjs            # dev server on :3002
 *   SCENE=<id> HEADED=1 node docs/qa/qa-boots-mirror.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-mirror-profile'
const log = (...a) => console.log(...a)

/** The 8 avatar tints (remote-players.AVATAR_PALETTE) — copied on purpose: the
 * check is "the dummy wears one of the lot's colors", and a copy is what makes
 * that an independent assertion rather than a tautology. */
const PALETTE = ['d95d4e', '4d8fd1', '58b368', 'd8a13a', '9a6dd7', '45b8ac', 'd16fa8', '8a9a5b']

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', '--window-size=1280,900'],
  headless: !process.env.HEADED,
  viewport: { height: 900, width: 1280 },
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

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
  // Column 2 is the pane's local +z in world space: the direction it faces out.
  const n = [e[8], e[9], e[10]]
  const len = Math.hypot(n[0], n[1], n[2]) || 1
  return {
    at: [e[12], e[13], e[14]],
    normal: [n[0] / len, n[1] / len, n[2] / len],
    nodeId: entry.nodeId,
    nodeType: entry.nodeType,
  }
})
log(`PANE FOUND: ${pane !== null}  ${pane ? JSON.stringify(pane) : ''}`)
if (!pane) {
  log(`page errors: ${errors.length} ${errors.slice(0, 3).join(' | ')}`)
  await browser.close()
  process.exit(1)
}

/** How far the container's deck plate sits below the pane's center — teleport
 * takes FEET, and the feet belong on the deck. The first cut passed
 * `pane.y + 0.4`, which put the camera (feet + EYE_HEIGHT 1.58) at ~2.9 m: above
 * the 2.6 m roof, so both screenshots were of the container from on top of it.
 * MIRROR_SILL_Y + PANE_H/2 - 0.12, kept as one number because the harness works
 * in the pane's measured frame and derives nothing else about the depot. */
const DECK_BELOW_PANE = 1.05
/** Camera height above the deck (collision.EYE_HEIGHT). */
const EYE_HEIGHT = 1.58

/** Stand `d` metres out from the pane along its normal, looking back at it (and
 * at the right height, aimed at the middle of the glass), optionally slid `side`
 * metres along the wall. Player yaw convention: forward = (-sin yaw, -cos yaw),
 * so facing -normal is atan2(nx, nz); pitch is +up, so looking down is negative. */
const standAt = async (d, side = 0, turn = 0) => {
  const [px, py, pz] = pane.at
  const [nx, , nz] = pane.normal
  // Along-wall axis (perpendicular to the normal, in XZ).
  const ax = -nz
  const az = nx
  const yaw = Math.atan2(nx, nz) + turn
  const feetY = py - DECK_BELOW_PANE
  const pitch = Math.atan2(py - (feetY + EYE_HEIGHT), Math.max(d, 0.3))
  await page.evaluate(
    (p) => globalThis.__boots.teleport(p.x, p.z, p.yaw, p.pitch, p.y),
    { pitch, x: px + nx * d + ax * side, y: feetY, yaw, z: pz + nz * d + az * side },
  )
  await page.waitForTimeout(700)
}

/** Everything the scene knows about the dummy right now. */
const readDummy = () =>
  page.evaluate(() => {
    const world = globalThis.__boots?.world
    const entry = (world?.colliders ?? []).find((c) => c?.mesh?.name === 'boots-mirror-pane')
    const root = entry?.mesh?.parent
    const dummy = root?.children?.find((c) => c.name === 'boots-mirror-dummy')
    const player = globalThis.__bootsPlayer?.sample?.() ?? null
    if (!dummy) return null
    dummy.updateWorldMatrix(true, false)
    const e = dummy.matrixWorld.elements
    // The rig faces its own local -Z (remote-players' convention).
    const fwd = [-e[8], -e[9], -e[10]]
    const flen = Math.hypot(fwd[0], fwd[1], fwd[2]) || 1
    const tints = new Set()
    dummy.traverse((o) => {
      const c = o.material?.color
      if (c) tints.add(c.getHexString())
    })
    return {
      at: [e[12], e[13], e[14]],
      facing: [fwd[0] / flen, fwd[1] / flen, fwd[2] / flen],
      // AvatarRig's children, in order: left leg pivot, right leg pivot, torso.
      legSwing: dummy.children?.[0]?.rotation?.x ?? null,
      playerYaw: player?.yaw ?? null,
      speed: player?.speed ?? null,
      tints: [...tints],
      visible: dummy.visible,
      yaw: dummy.rotation.y,
    }
  })

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// ── 1. asleep across the lot, awake at the glass ─────────────────────────────
await standAt(30)
const far = await readDummy()
await standAt(1.4)
const near = await readDummy()
log(`DUMMY SLEEPS FAR / WAKES NEAR: ${far?.visible === false && near?.visible === true}  (far ${far?.visible}, near ${near?.visible})`)

// ── 2. it stands inside the cabinet, behind the glass ────────────────────────
const rel = [near.at[0] - pane.at[0], near.at[1] - pane.at[1], near.at[2] - pane.at[2]]
const along = dot(rel, pane.normal)
const depth = -along // positive = behind the pane
// What is left of the offset once the depth is taken out: the slide along the
// wall (y included, though the dummy only ever moves on it by the stride bob).
const lateral = Math.hypot(
  rel[0] - pane.normal[0] * along,
  rel[2] - pane.normal[2] * along,
)
log(`BEHIND THE GLASS, INSIDE THE BOX: ${depth > 0.05 && depth < 0.5 && lateral < 0.46}  (depth ${depth.toFixed(3)} m, lateral ${lateral.toFixed(3)} m)`)

// ── 3. it looks back at you ──────────────────────────────────────────────────
log(`IT FACES YOU: ${dot(near.facing, pane.normal) > 0.9}  (facing·normal ${dot(near.facing, pane.normal).toFixed(3)})`)

// ── 4. turn left, it turns right ─────────────────────────────────────────────
const TURN = 0.5
await standAt(1.4, 0, TURN)
const turned = await readDummy()
const swing = Math.atan2(Math.sin(turned.yaw - near.yaw), Math.cos(turned.yaw - near.yaw))
log(`MIRRORED TURN: ${Math.abs(swing + TURN) < 0.05}  (player +${TURN} rad → dummy ${swing.toFixed(3)} rad)`)

// ── 5. it walks when you walk, and stops when you stop ───────────────────────
// A SPREAD, not one sample. The gait is a sine: a single reading can catch it
// at any phase, and headless runs at ~3 fps with dt capped to 1/30, so the
// phase crawls — the first cut of this check read 0.003 rad mid-stride and
// called it frozen. What separates striding from standing is that the swing
// MOVES: sample across a walk (approaching the glass at full speed, which is
// also the honest way anyone meets a mirror), then across a standstill.
const swingSpread = async (samples, gapMs) => {
  const swings = []
  const speeds = []
  for (let i = 0; i < samples; i++) {
    const d = await readDummy()
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
// And it FREEZES when you stop. ASSERT ON A FRAME THE GAME ITSELF CALLS STILL,
// not on a wall-clock sleep: dt is capped at 1/30 s and headless renders ~3 fps,
// so deceleration takes seconds in here, and the depot can be seated on a slope
// where the deck never lets you fully stop (two fixed sleeps caught the rig
// coasting — 0.053 rad at 1.5 s, 0.435 off a sprint at 6 s). articulate scales
// the whole gait by speed, so on any frame the player reads stopped the swing
// must be EXACTLY zero — one such frame is proof, and hunting for one is immune
// to how long the sim takes to get there.
await page.evaluate(() => globalThis.__boots.teleport(0, 0, 0)) // vel := 0
await standAt(1.6)
let stillFrame = null
let slowest = Infinity
for (let i = 0; i < 40; i++) {
  const d = await readDummy()
  if (typeof d?.speed === 'number') {
    slowest = Math.min(slowest, d.speed)
    if (d.speed < 0.02) {
      stillFrame = d
      break
    }
  }
  await page.waitForTimeout(250)
}
const froze = stillFrame ? Math.abs(stillFrame.legSwing) < 1e-6 : false
log(
  `IT STRIDES WITH YOU: ${walk.spread > 0.03 && froze}  (walking swing spread ${walk.spread.toFixed(3)} rad at up to ${walk.topSpeed.toFixed(1)} m/s → ` +
    (stillFrame
      ? `stopped at ${stillFrame.speed.toFixed(3)} m/s with swing ${stillFrame.legSwing.toFixed(6)} rad)`
      : `NEVER STOPPED, slowest ${slowest.toFixed(3)} m/s — standstill not observed)`),
)

// ── 6. it wears one of the lot's tints ───────────────────────────────────────
const worn = (near.tints ?? []).filter((t) => PALETTE.includes(t))
log(`WEARS A LOT TINT: ${worn.length > 0}  (${worn.join(',') || 'none'} of ${near.tints?.length} colors on the rig)`)

// ── 7. the eyeball check ─────────────────────────────────────────────────────
await standAt(1.3)
await page.screenshot({ path: '/tmp/boots-mirror-front.png' })
await standAt(2.2, 0.6)
await page.screenshot({ path: '/tmp/boots-mirror-angle.png' })
log('shots: /tmp/boots-mirror-front.png /tmp/boots-mirror-angle.png')
log(`page errors: ${errors.length} ${errors.slice(0, 3).join(' | ')}`)
await browser.close()
