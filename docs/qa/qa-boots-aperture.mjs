/**
 * QA — CAN THE PLAYER BUILD A DOOR AND A WINDOW, AND USE THEM WITH E?
 *
 * Owner report (2026-09-01): "In the build menu make sure I could place
 * windows and doors as well. In a way that makes sense. And that I could use
 * them by pressing E afterward. Also crossing the door there were still some
 * issues."
 *
 * The implementation makes an aperture a WALL whose middle column is pocketed
 * in the 9-bit cell mask that already existed, and derives the swinging leaf
 * from that mask (fittings.tsx). Unit tests cover the masks, the menu and the
 * plan; what they cannot cover is whether the whole chain lands in a real
 * session. So this drives the game and asks, in order:
 *
 *   1. THE MENU: does Z cycle wall → door → window, does Q walk the whole
 *      six-entry menu, and does the HUD name what is selected;
 *   2. THE PREVIEW: does the ghost carry the pocketed mask BEFORE the click
 *      (you must see the hole you are about to place);
 *   3. THE PLACEMENT: does the piece land with mask 493 / 495;
 *   4. THE E LANE: is a fitting registered for it, does the crosshair find it,
 *      does E swing it, and does opening a doorway clear a passage prism;
 *   5. THE CROSSING: blocked with the door shut, through with it open — the
 *      part the owner said still had issues;
 *   6. THE WINDOW: the sash swings too, and registers NO prism (nothing
 *      crosses a chest-high sash).
 *
 * Everything is read from the game's own dev handles (__boots.doors is
 * interact.tsx's, __bootsBuilder.ghost() is the builder's), and the pose comes
 * from teleport rather than the mouse: headless Chromium never engages pointer
 * lock, so a mouse sweep is the one input this cannot trust.
 *
 *   SCENE=… node qa-boots-aperture.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-aperture-profile'
const SHOT = process.env.SHOT ?? '/tmp/boots-aperture'
const log = (...a) => console.log(...a)
const r2 = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', '--window-size=1280,900'],
  headless: !process.env.HEADED,
  viewport: { height: 900, width: 1280 },
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

log(`goto ${URL}`)
await page
  .goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' })
  .catch((e) => log('goto:', e.message))
await page.waitForTimeout(12000)
const jumped = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /jump in/i.test(x.textContent || ''))
  if (!b) return false
  b.click()
  return true
})
log(`jump in clicked: ${jumped}`)
await page.waitForTimeout(20000)
log(`phase ${await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)}`)

// ── handles ─────────────────────────────────────────────────────────────────
const sel = () =>
  page.evaluate(() => {
    const s = globalThis.__boots?.state?.()
    return s ? { piece: s.buildPiece, opening: s.opening ?? s.buildOpening ?? null } : null
  })
const ghost = () => page.evaluate(() => globalThis.__bootsBuilder?.ghost?.() ?? null)
const pieces = () => page.evaluate(() => globalThis.__boots?.pieces?.() ?? [])
const sample = () => page.evaluate(() => globalThis.__bootsPlayer?.sample?.() ?? null)
const operables = () => page.evaluate(() => globalThis.__boots?.doors?.list?.() ?? [])
const aimed = () => page.evaluate(() => globalThis.__boots?.doors?.aimed?.() ?? null)
const passages = () => page.evaluate(() => globalThis.__boots?.doors?.passages?.() ?? [])
const hudLine = () =>
  page.evaluate(() => {
    const hit = [...document.querySelectorAll('div,span')].find((el) =>
      /\(Q\)$/.test((el.textContent || '').trim()),
    )
    return hit ? hit.textContent.trim() : null
  })
const shot = (name) => page.screenshot({ path: `${SHOT}-${name}.png` }).catch(() => {})
/** Stand at (x,z) looking along (dx,dz). yaw convention: forward is
 * (−sin yaw, −cos yaw), exactly what interact's aim ray uses. */
const stand = async (x, z, dx, dz, pitch = 0) => {
  const yaw = Math.atan2(-dx, -dz)
  await page.evaluate(
    ([px, pz, y, p]) => globalThis.__bootsPlayer?.teleport?.(px, pz, y, p),
    [x, z, yaw, pitch],
  )
  await page.waitForTimeout(500)
}
/** Hold the trigger through the builder's dev stand-in for the LMB. */
const stamp = async (ms = 260) => {
  await page.evaluate(() => {
    if (globalThis.__bootsBuilder) globalThis.__bootsBuilder.holdFire = true
  })
  await page.waitForTimeout(ms)
  await page.evaluate(() => {
    if (globalThis.__bootsBuilder) globalThis.__bootsBuilder.holdFire = false
  })
  await page.waitForTimeout(600)
}
/**
 * Hold W until the player either passes `done(sample)` or genuinely stops
 * advancing — never for a fixed stretch of wall time.
 *
 * WHY (the finding that made run 2 of this script lie): headless Chromium
 * renders this scene at ~3 fps, and every frame clamps its delta to 1/30 s
 * (player.tsx `dt = Math.min(rawDt, 1/30)`, the standard tunnelling guard). So
 * game time runs ~10× slower than the clock: at the 6.5 m/s run speed each
 * frame advances ~0.22 m, and a 1.8 s hold buys 4 frames — 0.8 m. That is
 * SHORTER than the 1.15 m the player stands back from the wall, so a perfectly
 * open doorway reads as "blocked" and a bug gets written up that isn't there.
 * Polling for real displacement is frame-rate blind.
 */
/** Wait for the passage-prism count to reach `want` (the swing's settle, in
 * game time — see walkUntil for why the clock is the wrong ruler). Returns
 * whatever it ended on, so the caller prints the truth either way. */
const settlePassages = async (want, budgetMs = 12000) => {
  const started = Date.now()
  let n = (await passages()).length
  while (n !== want && Date.now() - started < budgetMs) {
    await page.waitForTimeout(250)
    n = (await passages()).length
  }
  return n
}
const walkUntil = async (done, budgetMs = 20000) => {
  const trace = []
  await page.keyboard.down('KeyW')
  let last = await sample()
  let still = 0
  const started = Date.now()
  while (Date.now() - started < budgetMs) {
    await page.waitForTimeout(250)
    const now = await sample()
    const moved = Math.hypot(now.x - last.x, now.z - last.z)
    trace.push(`${r2(moved)}`)
    last = now
    if (done(now)) break
    // Three polls (~0.75 s, ≥2 rendered frames) without 2 cm of travel while
    // the key is down: something is holding the capsule.
    still = moved < 0.02 ? still + 1 : 0
    if (still >= 3) break
  }
  await page.keyboard.up('KeyW')
  await page.waitForTimeout(300)
  return trace
}

await page.keyboard.press('Digit4')
await page.waitForTimeout(700)
log(`weapon ${await page.evaluate(() => globalThis.__boots?.state?.()?.weapon)}`)

// FLAT GROUND FIRST. This lot is sloped: at the spawn the storey rung the grid
// resolves (ghost baseY) sits 1.2 m BELOW the ground the player stands on, so a
// wall placed there is half buried and its doorway is underground — nothing to
// aim at and nothing to walk through. Walk out to where the rung and the ground
// agree and do the door work there. (Separate finding, separate fix: the rung
// choice on a sloped lot. Noted in NIGHTLOG, not this harness's subject.)
const spawn = await sample()
let flat = null
for (const [dx, dz] of [[12, 0], [6, 0], [10, 10], [0, 0]]) {
  await page.evaluate(([x, z]) => globalThis.__bootsPlayer?.teleport?.(x, z, 0, 0), [
    spawn.x + dx,
    spawn.z + dz,
  ])
  await page.waitForTimeout(700)
  const s = await sample()
  const g = await ghost()
  const gap = Math.abs((g?.y ?? 0) - s.y)
  log(`  probe ${dx},${dz}: feet y ${r2(s.y)} vs ghost baseY ${r2(g?.y)} → gap ${r2(gap)}`)
  if (gap < 0.25) {
    flat = { x: spawn.x + dx, z: spawn.z + dz }
    break
  }
}
if (!flat) flat = { x: spawn.x, z: spawn.z } // report it anyway rather than crash
log(`  building at ${JSON.stringify(flat)}`)

// ── 1. the menu ─────────────────────────────────────────────────────────────
log('\n=== 1. the build menu ===')
log(`  start        ${JSON.stringify(await sel())}   hud "${await hudLine()}"`)
for (let i = 1; i <= 3; i++) {
  await page.keyboard.press('KeyZ')
  await page.waitForTimeout(700)
  log(`  Z ×${i}         ${JSON.stringify(await sel())}   hud "${await hudLine()}"`)
}
for (let i = 1; i <= 7; i++) {
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(700)
  log(`  Q ×${i}         ${JSON.stringify(await sel())}   hud "${await hudLine()}"`)
}

// ── 2. the preview ──────────────────────────────────────────────────────────
log('\n=== 2. the ghost previews the pocket ===')
// Back to the wall family, then Z once for the door.
await page.keyboard.press('KeyZ')
await page.waitForTimeout(300)
let cur = await sel()
while (cur?.piece !== 'wall' || cur?.opening !== 'door') {
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(700)
  cur = await sel()
}
await stand(flat.x, flat.z, 0, -1, 0)
let g = await ghost()
log(`  door selected: ghost mask ${g?.mask} (expect 493) slot ${g?.slotId} valid ${g?.valid} reason ${g?.reason}`)
await shot('2-ghost-door')
await page.keyboard.press('KeyZ')
await page.waitForTimeout(700)
g = await ghost()
log(`  window:        ghost mask ${g?.mask} (expect 495) slot ${g?.slotId} valid ${g?.valid}`)
await shot('2-ghost-window')
await page.keyboard.press('KeyZ')
await page.waitForTimeout(700)
g = await ghost()
log(`  plain wall:    ghost mask ${g?.mask} (expect 511)`)

// ── 3./4./5. the door: place it, open it, cross it ──────────────────────────
log('\n=== 3. place a door wall ===')
await page.keyboard.press('KeyZ') // wall → door
await page.waitForTimeout(700)
log(`  selection ${JSON.stringify(await sel())}`)
const before = (await pieces()).length
await stamp()
const after = await pieces()
const wall = after.at(-1)
log(`  placed ${before} → ${after.length}`)
log(
  `  piece: ${wall?.piece} mask ${wall?.mask} slot ${wall?.slotId} ` +
    `pos ${JSON.stringify(wall?.position.map(r2))} yaw ${r2(wall?.yaw)} height ${r2(wall?.height)}`,
)
await shot('3-door-placed')

log('\n=== 4. the E lane ===')
let ops = await operables()
const fitting = ops.find((o) => o.nodeId === `__boots-fitting-${wall?.id}`)
log(`  operables ${ops.length}; ours ${JSON.stringify(fitting ?? null)}`)

// Stand on the wall's +Z side (local +Z = (sin yaw, cos yaw)) looking at it.
const nx = Math.sin(wall.yaw)
const nz = Math.cos(wall.yaw)
const cx = wall.position[0]
const cz = wall.position[2]
// Along the wall (its local +X) — where the next slot on the same rung is.
const tx = Math.cos(wall.yaw)
const tz = -Math.sin(wall.yaw)
const STAND = 1.15
await stand(cx + nx * STAND, cz + nz * STAND, -nx, -nz, 0)
log(`  aimed: ${JSON.stringify(await aimed())}`)
log(`  passages before E: ${(await passages()).length}`)

await page.keyboard.press('KeyE')
await page.waitForTimeout(1400)
ops = await operables()
const prisms = await passages()
log(`  after E: ${JSON.stringify(ops.find((o) => o.nodeId === fitting?.nodeId) ?? null)}`)
log(`  passages ${prisms.length}: ${JSON.stringify(prisms.map((p) => ({ maxY: r2(p.max?.[1] ?? p.max?.y) })))}`)
log(`  wall top should be ${r2(wall.position[1] + (wall.height ?? 2.8))}`)
await shot('4-door-open')

log('\n=== 5. crossing ===')
/** Signed distance along the wall normal: positive = still on the near side. */
const normalOffset = (s) => (s.x - cx) * nx + (s.z - cz) * nz
const crossed = async (label) => {
  await stand(cx + nx * STAND, cz + nz * STAND, -nx, -nz, 0)
  const from = await sample()
  await page.evaluate(() => globalThis.__boots?.doors?.resetReliefStats?.())
  // Walk until well clear of the far face, or until the capsule stops.
  const trace = await walkUntil((s) => normalOffset(s) < -0.6)
  const to = await sample()
  const sBefore = normalOffset(from)
  const sAfter = normalOffset(to)
  log(
    `  ${label}: normal offset ${r2(sBefore)} → ${r2(sAfter)}  ` +
      `${sAfter < -0.2 ? 'CROSSED' : 'blocked'}  feet ${JSON.stringify([r2(to.x), r2(to.y), r2(to.z)])}`,
  )
  log(`    per-poll travel: ${trace.join(' ')}`)
  return { through: sAfter < -0.2, at: to }
}
const openWalk = await crossed('door OPEN ')
await shot('5-after-open-walk')
const wentThroughOpen = openWalk.through

// WHAT is standing in the doorway? Only asked when the crossing failed, and
// asked of the three lanes that can each hold the capsule back on their own:
// the voxel replicas (alive cells inside the opening — the piece is clad the
// moment it is placed, so the wall the player walks through is a grid, not the
// mesh), the mesh colliders the crosshair can name, and the relief bookkeeping
// (was the voxel lane even consulted about this prism?).
if (!wentThroughOpen) {
  const span = wall.height ?? 2.8
  // The CLEAR volume only: inside the pocket's 1 m width and under its lintel,
  // pulled in by a cell so the jamb columns and the lintel course — which are
  // supposed to be solid — cannot be mistaken for blockers. Any cell reported
  // here is standing in the walk line.
  const doorway = [
    [cx - 0.35, wall.position[1] + 0.2, cz - 0.55],
    [cx + 0.35, wall.position[1] + (2 * span) / 3 - 0.25, cz + 0.55],
  ]
  const occ = await page.evaluate(
    ([min, max]) => globalThis.__boots?.doors?.occupancy?.(min, max) ?? null,
    doorway,
  )
  log(`  occupancy of the CLEAR opening ${JSON.stringify(doorway.map((v) => v.map(r2)))}:`)
  for (const o of occ ?? []) {
    log(
      `    ${o.nodeId} ${o.kind}${o.dormant ? ' dormant' : ''} cells ${o.cells} cell ${r2(o.cell)} ` +
        `box ${JSON.stringify(o.box.min.map(r2))}→${JSON.stringify(o.box.max.map(r2))}`,
    )
  }
  if (!occ?.length) log('    (no alive voxel cells stand in the opening)')
  log(`  relief stats: ${JSON.stringify(await page.evaluate(() => globalThis.__boots?.doors?.reliefStats?.() ?? null))}`)
  // Level, then 25° down: a threshold blocker sits under the crosshair. Only
  // the naming fields — the raw handle returns whole object dumps.
  const surfaces = async (pitch) => {
    await stand(openWalk.at.x, openWalk.at.z, -nx, -nz, pitch)
    const hits = await page.evaluate(() => globalThis.__boots?.identifyAim?.(6) ?? [])
    return (hits ?? [])
      .map((h) => `${h.nodeId ?? h.name ?? h.type}@${r2(h.distance)}${h.boots ? ' (boots)' : ''}`)
      .join(', ')
  }
  log(`  identifyAim level: ${await surfaces(0)}`)
  log(`  identifyAim down:  ${await surfaces(-0.45)}`)
  await shot('5-blocked-view')
}
// Shut it and try again — the leaf must stop the player.
await stand(cx + nx * STAND, cz + nz * STAND, -nx, -nz, 0)
log(`  aimed (to close): ${JSON.stringify(await aimed())}`)
await page.keyboard.press('KeyE')
await page.waitForTimeout(1400)
log(`  after E: ${JSON.stringify((await operables()).find((o) => o.nodeId === fitting?.nodeId) ?? null)}`)
// The prism retires on the close SETTLE, and a settle is measured in GAME
// seconds — which run ~10× slower than the clock here (see walkUntil). Poll.
log(`  passages ${await settlePassages(0)} (expect 0)`)
const wentThroughShut = (await crossed('door SHUT ')).through
await shot('5-after-shut-walk')

// ── 6. the window ───────────────────────────────────────────────────────────
log('\n=== 6. the window sash ===')
// One slot ALONG the wall (same rung, same flat ground), facing the same way.
await stand(cx + tx * 3 + nx * STAND, cz + tz * 3 + nz * STAND, -nx, -nz, 0)
cur = await sel()
while (cur?.piece !== 'wall' || cur?.opening !== 'window') {
  await page.keyboard.press('KeyQ')
  await page.waitForTimeout(700)
  cur = await sel()
}
const beforeW = (await pieces()).length
await stamp()
const afterW = await pieces()
const sash = afterW.at(-1)
log(`  placed ${beforeW} → ${afterW.length}: mask ${sash?.mask} (expect 495) slot ${sash?.slotId}`)
const sashNode = `__boots-fitting-${sash?.id}`
log(`  operable ${JSON.stringify((await operables()).find((o) => o.nodeId === sashNode) ?? null)}`)
const sx = Math.sin(sash.yaw)
const sz = Math.cos(sash.yaw)
// A sash fills the wall's MIDDLE cell, so its centre is exactly half the
// storey up — 1.25 m on this lot, half a metre BELOW the 1.58 m eye. Aim at
// it rather than at a guessed pitch: the first run of this script tilted 0.18
// rad UP and sailed over the sash, which reads exactly like a broken E lane.
const sashY = sash.position[1] + (sash.height ?? 2.8) / 2
const SASH_STAND = 1.1
await stand(sash.position[0] + sx * SASH_STAND, sash.position[2] + sz * SASH_STAND, -sx, -sz, 0)
const eye = await sample()
const sashPitch = Math.atan2(sashY - (eye.y + 1.58), SASH_STAND)
await stand(
  sash.position[0] + sx * SASH_STAND,
  sash.position[2] + sz * SASH_STAND,
  -sx,
  -sz,
  sashPitch,
)
log(`  sash centre y ${r2(sashY)} vs eye ${r2(eye.y + 1.58)} → pitch ${r2(sashPitch)}`)
log(`  aimed: ${JSON.stringify(await aimed())}`)
const prismsBeforeSash = (await passages()).length
await page.keyboard.press('KeyE')
await page.waitForTimeout(1400)
log(`  after E: ${JSON.stringify((await operables()).find((o) => o.nodeId === sashNode) ?? null)}`)
log(`  passages ${prismsBeforeSash} → ${(await passages()).length} (a sash must add none)`)
await shot('6-window-open')

log('\n=== verdict ===')
log(`  door crossed while OPEN: ${wentThroughOpen}   crossed while SHUT: ${wentThroughShut}`)
log(`page errors: ${errors.length}`)
for (const e of errors.slice(0, 6)) log(`   ${e}`)
await browser.close()
