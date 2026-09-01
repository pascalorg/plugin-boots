/**
 * QA — WHERE DOES THE BUILD LATTICE THINK THE GROUND IS?
 *
 * The ghost QA showed every storey-0 piece resolving a base of y = 0 while the
 * player stands on grass at y ≈ 1.23: a ground wall is half buried and its top
 * (the ceiling slot) lands at chest height instead of overhead. That is either
 *   (a) the storey ladder rooted at the building's own level 0, which really
 *       does sit below the grass the player is standing on, or
 *   (b) the terrain probe under the grid anchor returning the lot plane.
 * Only the live scene can say which, so ask it: the ladder, the anchor, the
 * terrain the lattice measured itself from, and the ground under the player.
 *
 *   SCENE=… node qa-boots-ladder.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-ladder-profile'
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', '--window-size=1280,900'],
  headless: !process.env.HEADED,
  viewport: { height: 900, width: 1280 },
})
const page = browser.pages()[0] ?? (await browser.newPage())
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message))
await page.waitForTimeout(12000)
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) => /jump in/i.test(b.textContent || ''))
  button?.click()
})
await page.waitForTimeout(20000)

const out = await page.evaluate(() => {
  const boots = globalThis.__boots
  const builder = globalThis.__bootsBuilder
  const player = globalThis.__bootsPlayer?.sample?.() ?? null
  const world = boots?.world
  // Every collected wall root's world Y — the building's REAL floor heights,
  // independent of anything the grid computed.
  const wallYs = []
  for (const entry of world?.walls?.values?.() ?? []) {
    const root = entry?.root
    if (!root) continue
    const p = root.getWorldPosition(new root.position.constructor())
    wallYs.push(Math.round(p.y * 100) / 100)
  }
  return {
    anchor: builder?.anchor?.() ?? null,
    feet: player && { x: player.x, y: player.y, z: player.z },
    gridTerrainY: builder?.terrainY?.() ?? null,
    ladder: builder?.ladder?.() ?? null,
    siteMinY: world?.siteAabb ? world.siteAabb.min.y : null,
    storeyLadderFromWorld: world?.storeyLadder ?? null,
    wallRootYs: [...new Set(wallYs)].sort((a, b) => a - b).slice(0, 14),
  }
})
log(JSON.stringify(out, null, 2))
await browser.close()
