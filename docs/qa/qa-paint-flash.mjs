/**
 * THE WHITE CIRCLE — pixel-trace the moment a spray lands.
 *
 * The report (owner, prod, 2026-08-31): "quand je spray paint, ca clignote en
 * blanc au niveau de la ou le spray touche le mur (cercle) au moment ou je
 * click. apres la couleur reste tout bien."
 *
 * Code reading could not settle it, because three separate lanes draw a circle
 * at the impact point and two of them deliberately prime an InstancedMesh's
 * colours WHITE before the first draw (the "a WebGPU pipeline compiled without
 * instanceColor ignores every later setColorAt" idiom — paint.tsx's sprite pool
 * and dust.tsx both do it). So this samples the pixels under the crosshair on
 * every animation frame across a spray pulse and prints the trace: a one-frame
 * flash is a bright row between the wall colour and the coat colour.
 *
 * Two hard-won rules are baked in, because breaking either produces a
 * confident-looking run that proves nothing:
 *
 *  1. AIM BY OUTCOME, NOT BY GEOMETRY. The editor's wireframe LineSegments sit
 *     in front of every surface, so identifyAim()[0] is never the wall; and
 *     paint only lands on nodes whose type is PAINTABLE. Three earlier attempts
 *     traced a perfectly steady pixel and concluded "no flash" while
 *     census() sat at all zeros — nothing had been sprayed at all. So the pose
 *     search here sprays each candidate and keeps the first one where
 *     census() actually GROWS.
 *
 *  2. GET OFF PALETTE INDEX 0. It is WHITE (#f4f4ef) and it is the default
 *     coat, so a trace taken on a fresh session cannot tell a white BUG from
 *     white PAINT. R cycles off it before the traced pulses.
 *
 * Standing 0.3 m from a surface also invalidates a run: the whole sampled patch
 * starts inside the coat, so there is no before-colour to flash away from.
 * Hence the ≥1.2 m standoff.
 *
 *   node docs/qa/qa-paint-flash.mjs                 # dev server on :3002
 *   SCENE=<id> HEADED=1 node docs/qa/qa-paint-flash.mjs
 *
 * WHAT IT COVERS. A pristine host wears solid-disc DecalGeometry stamps, so
 * this reaches the DECAL lane. The splat-SPRITE pool only draws on Boots-owned
 * voxels — i.e. on a wall that has already taken damage — and there is no QA
 * hook that fires a gun (paintDebug and builderDebug have holdFire; guns do
 * not), so the sprite lane is NOT exercised here. A clean run means the decal
 * lane is clean, and nothing more.
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? 'projectahyvrpvr3g1juxpr'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext('/tmp/boots-paint-flash-profile', {
  args: ['--window-size=1280,860'],
  headless: !process.env.HEADED,
  viewport: { height: 860, width: 1280 },
})
const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

log(`goto ${URL}`)
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log(e.message))
await page.waitForTimeout(18000)
await page.evaluate(() => {
  ;[...document.querySelectorAll('button')]
    .find((b) => /jump in/i.test(b.textContent || ''))
    ?.click()
})
await page.waitForTimeout(16000)
log(`phase: ${await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)}`)
// The backend matters: the host renders through WebGPURenderer, and the white
// priming the suspects share exists for a WebGPU pipeline quirk. Report it, so
// a clean run cannot be mistaken for a clean run on the wrong backend.
log(`webgpu adapter: ${await page.evaluate(async () => {
  try {
    return (await navigator.gpu?.requestAdapter()) ? 'yes' : 'none'
  } catch {
    return 'threw'
  }
})}`)

await page.keyboard.press('Digit7')
await page.waitForTimeout(1200)
log(`weapon: ${await page.evaluate(() => globalThis.__boots?.state?.()?.weapon ?? null)}`)
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('KeyR')
  await page.waitForTimeout(350)
}

const census = () => page.evaluate(() => globalThis.__bootsPaint?.census?.() ?? null)
const total = (c) => (c ? c.sprites + c.decals + c.chunks + c.bakedSprites + c.bakedDecals : 0)

// ── candidate poses: stand off each wall's midpoint and sweep yaw ────────────
const candidates = await page.evaluate(() => {
  const boots = globalThis.__boots
  const out = []
  for (const wall of boots.wallNodes().slice(0, 24)) {
    if (!wall?.start || !wall?.end) continue
    const mx = (wall.start[0] + wall.end[0]) / 2
    const mz = (wall.start[1] + wall.end[1]) / 2
    const dx = wall.end[0] - wall.start[0]
    const dz = wall.end[1] - wall.start[1]
    const len = Math.hypot(dx, dz) || 1
    const nx = -dz / len
    const nz = dx / len
    for (const side of [1, -1]) {
      const x = mx + nx * 2.2 * side
      const z = mz + nz * 2.2 * side
      for (let step = 0; step < 24; step++) {
        const yaw = (step / 24) * Math.PI * 2
        boots.teleport(x, z, yaw, 0)
        // Walk the hit chain: the wireframe LineSegments are always first.
        const hit = (boots.identifyAim(6) ?? []).find((h) => h?.type === 'Mesh')
        if (hit && hit.distance > 1.2 && hit.distance < 6) {
          out.push({ boots: hit.boots, d: hit.distance, wall: wall.id, x, yaw, z })
          break
        }
      }
    }
    if (out.length >= 14) break
  }
  return out
})
log(`candidate poses: ${candidates.length}`)

let pose = null
for (const c of candidates) {
  await page.evaluate((p) => globalThis.__boots.teleport(p.x, p.z, p.yaw, 0), c)
  await page.waitForTimeout(250)
  const before = total(await census())
  await page.evaluate(() => {
    globalThis.__bootsPaint.holdFire = true
  })
  await page.waitForTimeout(600)
  await page.evaluate(() => {
    globalThis.__bootsPaint.holdFire = false
  })
  await page.waitForTimeout(500)
  const after = await census()
  log(`  probe ${c.wall} d=${c.d.toFixed(1)} → census ${before} -> ${total(after)} (decals ${after?.decals}, sprites ${after?.sprites})`)
  if (total(after) > before) {
    pose = c
    break
  }
}
if (!pose) {
  log('NO POSE PAINTS — a trace here would be noise, not evidence. Stopping.')
  log(`census: ${JSON.stringify(await census())}   page errors: ${errors.length}`)
  await browser.close()
  process.exit(0)
}
log(`painting pose: ${JSON.stringify(pose)}`)

const installed = await page.evaluate(() => {
  const canvas = [...document.querySelectorAll('canvas')].sort(
    (a, b) => b.width * b.height - a.width * a.height,
  )[0]
  if (!canvas) return false
  const probe = document.createElement('canvas')
  probe.width = 6
  probe.height = 6
  const ctx = probe.getContext('2d', { willReadFrequently: true })
  globalThis.__samples = []
  globalThis.__sampling = true
  const cx = Math.round(canvas.width / 2)
  const cy = Math.round(canvas.height / 2)
  const tick = () => {
    if (!globalThis.__sampling) return
    try {
      ctx.clearRect(0, 0, 6, 6)
      ctx.drawImage(canvas, cx - 3, cy - 3, 6, 6, 0, 0, 6, 6)
      const d = ctx.getImageData(0, 0, 6, 6).data
      let r = 0
      let g = 0
      let b = 0
      for (let i = 0; i < d.length; i += 4) {
        r += d[i]
        g += d[i + 1]
        b += d[i + 2]
      }
      const n = d.length / 4
      globalThis.__samples.push([Math.round(r / n), Math.round(g / n), Math.round(b / n)])
    } catch {
      // A blank readback (all zeros) has to be visible in the trace, never
      // silently counted as "no flash".
      globalThis.__samples.push([-1, -1, -1])
    }
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return true
})
log(`sampler: ${installed}`)
await page.waitForTimeout(600)

/** Bright and near-grey — what a white stamp over any coat would read as. */
const brightNeutral = (s) =>
  Math.min(s[0], s[1], s[2]) > 150 && Math.max(s[0], s[1], s[2]) - Math.min(s[0], s[1], s[2]) < 30

const pulse = async (label, ms) => {
  const before = await census()
  await page.evaluate(() => {
    globalThis.__samples = []
    globalThis.__bootsPaint.holdFire = true
  })
  await page.waitForTimeout(ms)
  await page.evaluate(() => {
    globalThis.__bootsPaint.holdFire = false
  })
  await page.waitForTimeout(2000)
  const samples = await page.evaluate(() => globalThis.__samples.slice(0, 400))
  const after = await census()
  const runs = []
  for (const s of samples) {
    const key = s.join(',')
    if (runs.length && runs[runs.length - 1].key === key) runs[runs.length - 1].n++
    else runs.push({ key, n: 1 })
  }
  const bright = samples.filter(brightNeutral)
  log(`\n=== ${label} ===`)
  log(`  decals ${before?.decals}->${after?.decals}   sprites ${before?.sprites}->${after?.sprites}`)
  log(`  frames ${samples.length}   bright-neutral ${bright.length}`)
  log(`  runs  : ${runs.map((r) => `${r.key}×${r.n}`).join(' | ')}`)
  return { after, before, samples }
}

const one = await pulse('pulse 1 — first coloured coat on this wall', 800)
await page.waitForTimeout(1500)
const two = await pulse('pulse 2 — same spot, second click', 800)

log('\n=== VERDICT ===')
const grew = (r) => (r.after?.decals ?? 0) + (r.after?.sprites ?? 0) > (r.before?.decals ?? 0) + (r.before?.sprites ?? 0)
log(`  paint landed in both pulses : ${grew(one) && grew(two)}`)
log(`  flash frames p1 / p2       : ${one.samples.filter(brightNeutral).length} / ${two.samples.filter(brightNeutral).length}`)
log(`  sprite lane exercised      : ${(two.after?.sprites ?? 0) > 0}`)
log(`  page errors                : ${errors.length}`)
for (const e of errors.slice(0, 4)) log(`     ${e}`)
await page.screenshot({ path: '/tmp/boots-paint-flash.png' }).catch(() => {})
await browser.close()
