/**
 * QA — IS THERE A PREVIEW BEFORE YOU PLACE, AND CAN A FLOOR BE A CEILING?
 *
 * Owner report (2026-09-01): "problem placing floors as ceiling. in general
 * before placing slope, wall, floor, there should be a preview transparent."
 *
 * builder.tsx HAS a translucent slot ghost, so the report is either about a
 * ghost that never renders in a real session, or about one that renders
 * somewhere other than where the piece lands, or about a ceiling the grid
 * refuses. Those are three different bugs and reading the code cannot tell
 * them apart — so this drives the real game and asks it directly:
 *
 *   1. for each piece (wall / floor / stairs / roof), at several pitches:
 *      what slot does the builder resolve, is it valid, and what does the
 *      HUD say when it is not;
 *   2. THE CEILING FLOW: stand in the open, look up past the pitch band with
 *      the floor piece, and try to place. Then do it again standing next to
 *      a wall the player just built — the fort-builder answer to "put a lid
 *      on it" — and report which of the two the grid accepts;
 *   3. a screenshot per case, so the transparency is judged by looking.
 *
 * Pitch comes from __bootsPlayer.teleport(x, z, yaw, pitch), not the mouse:
 * headless Chromium never engages pointer lock, so a mouse sweep is the one
 * input this cannot trust.
 *
 *   SCENE=… node qa-boots-ghost.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-ghost-profile'
const SHOT = process.env.SHOT ?? '/tmp/boots-ghost'
const log = (...a) => console.log(...a)
const DEG = Math.PI / 180

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

const jumped = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /jump in/i.test(b.textContent || ''))
  if (!button) return false
  button.click()
  return true
})
log(`jump in clicked: ${jumped}`)
await page.waitForTimeout(20000)
log(`phase ${await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)}`)

// The builder, then the piece. Both go through the game's own key path.
await page.keyboard.press('Digit4')
await page.waitForTimeout(600)

const KEY = { wall: 'KeyZ', floor: 'KeyX', stairs: 'KeyC', roof: 'KeyV' }
const selectPiece = async (piece) => {
  await page.keyboard.press(KEY[piece])
  await page.waitForTimeout(400)
  return page.evaluate(() => globalThis.__boots?.state?.()?.buildPiece ?? null)
}

const ghost = () => page.evaluate(() => globalThis.__bootsBuilder?.ghost?.() ?? null)
const pieces = () => page.evaluate(() => globalThis.__boots?.pieces?.() ?? [])
const sample = () => page.evaluate(() => globalThis.__bootsPlayer?.sample?.() ?? null)
const look = async (pitchDeg, yaw = 0) => {
  const at = await sample()
  await page.evaluate(
    ([x, z, y, yawRad, pitchRad]) => globalThis.__bootsPlayer?.teleport?.(x, z, yawRad, pitchRad, y),
    [at?.x ?? 0, at?.z ?? 0, at?.y ?? 0, yaw, pitchDeg * DEG],
  )
  await page.waitForTimeout(500)
}
/** Hold the trigger through the builder's own dev stand-in for the LMB. */
const stamp = async (ms = 260) => {
  await page.evaluate(() => {
    if (globalThis.__bootsBuilder) globalThis.__bootsBuilder.holdFire = true
  })
  await page.waitForTimeout(ms)
  await page.evaluate(() => {
    if (globalThis.__bootsBuilder) globalThis.__bootsBuilder.holdFire = false
  })
  await page.waitForTimeout(500)
}
const shot = (name) => page.screenshot({ path: `${SHOT}-${name}.png` }).catch(() => {})

const at = await sample()
log(`spawn feet ${JSON.stringify(at && [round(at.x), round(at.y), round(at.z)])} yaw ${round(at?.yaw)}`)
function round(v) {
  return typeof v === 'number' ? Math.round(v * 100) / 100 : v
}

// ── 1. one ghost per piece per pitch ────────────────────────────────────────
log('\n=== 1. what the builder resolves (piece × pitch) ===')
for (const piece of ['wall', 'floor', 'stairs', 'roof']) {
  const chosen = await selectPiece(piece)
  for (const pitch of [-50, -20, 0, 20, 50]) {
    await look(pitch)
    const g = await ghost()
    log(
      `  ${piece.padEnd(6)} (store=${chosen}) pitch ${String(pitch).padStart(3)}°  ` +
        `slot ${String(g?.slotId).padEnd(12)} valid ${String(g?.valid).padEnd(5)} ` +
        `reason ${String(g?.reason).padEnd(13)} y ${round(g?.y)}`,
    )
    if (pitch === 50 || pitch === 0) await shot(`1-${piece}-${pitch}`)
  }
}

// ── 2. the ceiling flow ─────────────────────────────────────────────────────
log('\n=== 2. floor as ceiling ===')
await selectPiece('floor')
await look(50)
let g = await ghost()
const before = (await pieces()).length
log(`  open ground, +50°: slot ${g?.slotId} valid ${g?.valid} reason ${g?.reason}`)
await stamp()
log(`  placed ${before} → ${(await pieces()).length}`)
await shot('2-ceiling-open')

// Now the real flow: a wall first, then the lid over it.
log('\n  --- with a wall under it ---')
await selectPiece('wall')
await look(0)
g = await ghost()
log(`  wall ghost: slot ${g?.slotId} valid ${g?.valid} reason ${g?.reason}`)
const beforeWall = (await pieces()).length
await stamp()
const afterWall = await pieces()
log(`  placed ${beforeWall} → ${afterWall.length}  ${JSON.stringify(afterWall.slice(-1).map((p) => p.slotId))}`)
await selectPiece('floor')
for (const pitch of [30, 45, 60, 75]) {
  await look(pitch)
  g = await ghost()
  log(`  floor at +${pitch}°: slot ${String(g?.slotId).padEnd(12)} valid ${String(g?.valid).padEnd(5)} reason ${g?.reason}`)
}
await look(50)
const beforeLid = (await pieces()).length
await stamp()
const afterLid = await pieces()
log(`  lid: placed ${beforeLid} → ${afterLid.length}  ${JSON.stringify(afterLid.slice(-1).map((p) => `${p.piece}@${p.slotId}`))}`)
await shot('2-ceiling-wall')

// ── 3. is the ghost mesh actually in the scene? ─────────────────────────────
// The readout above is the builder's own state; this asks three.js what it is
// drawing, so a ghost that resolves but never renders is visible as a bug.
log('\n=== 3. the ghost in the render tree ===')
await selectPiece('wall')
await look(0)
const drawn = await page.evaluate(() => {
  // Climb from any collected wall root to the canvas scene, then look for the
  // plugin's own transparent objects (userData.__boots marks every one).
  const world = globalThis.__boots?.world
  const anyRoot = world?.walls?.values?.().next?.().value?.root ?? null
  let scene = anyRoot
  while (scene?.parent) scene = scene.parent
  if (!scene) return { hasScene: false, drawn: [] }
  const seen = []
  const visibleUp = (o) => {
    for (let n = o; n; n = n.parent) if (!n.visible) return false
    return true
  }
  scene.traverse((child) => {
    const material = child.material
    if (!material || Array.isArray(material) || !material.transparent) return
    if (!child.userData?.__boots && !child.parent?.userData?.__boots) return
    if (!visibleUp(child)) return
    const p = child.getWorldPosition
      ? child.getWorldPosition(new (child.position.constructor)())
      : child.position
    seen.push({
      type: child.type,
      opacity: material.opacity,
      color: material.color?.getHexString?.() ?? null,
      depthWrite: material.depthWrite,
      at: [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100),
    })
  })
  return { hasScene: true, drawn: seen.slice(0, 12) }
})
log(`  ${JSON.stringify(drawn).slice(0, 1200)}`)

log(`\npage errors: ${errors.length}`)
for (const e of errors.slice(0, 6)) log(`   ${e}`)
await browser.close()
