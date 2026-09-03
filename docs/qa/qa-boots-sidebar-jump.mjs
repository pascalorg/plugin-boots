#!/usr/bin/env node
// Sidebar "⏵ Jump in" runs through the mic gate: with mic permission at 'prompt',
// click 1 must NOT enter (it becomes the prompt, label → ALLOW THE MIC ↑ → ⏵ PLAY);
// click 2 enters with the mic live. One browser, behind /tmp/boots-browser.lock.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const PE_ROOT = process.env.PE_ROOT ?? path.join(os.homedir(), 'Documents/GitHub/private-editor')
const { chromium } = createRequire(path.join(PE_ROOT, 'package.json'))('playwright')
const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const BASE = process.env.BASE ?? 'http://localhost:3002'
const LOCK = '/tmp/boots-browser.lock'
const T0 = Date.now()
const log = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let holding = false
async function takeLock() {
  for (;;) {
    try { fs.mkdirSync(LOCK); fs.writeFileSync(path.join(LOCK, 'owner'), String(process.pid)); holding = true; return } catch {}
    let owner = NaN
    try { owner = Number(fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim()) } catch {}
    if (Number.isFinite(owner) && owner > 0) {
      let alive = true
      try { process.kill(owner, 0) } catch { alive = false }
      if (!alive) { log(`stale lock (pid ${owner}) — reclaiming`); fs.rmSync(LOCK, { recursive: true, force: true }); continue }
      log(`lock held by ${owner}; waiting 20 s`)
    } else log('lock present, no live owner file; waiting 20 s')
    await sleep(20000)
  }
}
function releaseLock() {
  if (!holding) return
  try { if (fs.readFileSync(path.join(LOCK, 'owner'), 'utf8').trim() === String(process.pid)) fs.rmSync(LOCK, { recursive: true, force: true }) } catch {}
  holding = false
}
let browser = null
async function shutdown(code) { try { if (browser) await browser.close() } catch {} browser = null; releaseLock(); process.exit(code) }
process.on('exit', releaseLock)
process.on('SIGINT', () => void shutdown(130))
process.on('SIGTERM', () => void shutdown(143))
const watchdog = setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'watchdog' })); void shutdown(3) }, Number(process.env.WATCHDOG_MS ?? 600000))
watchdog.unref()

function installStubBus() {
  // Minimal v1 bus so voicePossible() is true (a bus, WebRTC, a mic API): the
  // gate then has a reason to ask. Nobody else is on it.
  globalThis.__pascalCollabBus = {
    version: 1, projectId: 'qa-project', sessionId: 'S-session', clientId: 'S-client', userId: 'S-user',
    publish: () => 'sent', subscribe: () => () => {}, getParticipants: () => [], onParticipants: () => () => {},
  }
  try { Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false, configurable: true }) } catch {}
  const denied = () => Promise.reject(new DOMException('QA: disabled', 'NotAllowedError'))
  try { Element.prototype.requestPointerLock = denied } catch {}
  try { Element.prototype.requestFullscreen = denied } catch {}
  // Count getUserMedia calls and slow the grant a little so the ASK label is observable.
  const md = navigator.mediaDevices
  if (md) {
    md.__gum = 0
    const real = md.getUserMedia.bind(md)
    md.getUserMedia = async (...args) => { md.__gum++; await new Promise((r) => setTimeout(r, 1200)); return real(...args) }
  }
  // Chrome's --use-fake-ui-for-media-stream reports the mic as ALREADY GRANTED,
  // which is the one-click path. The branch under test is the one where the
  // browser has to ask, so the permission READ says 'prompt' (the real
  // getUserMedia above still resolves — a dialog answered instantly).
  if (navigator.permissions) {
    const realQuery = navigator.permissions.query.bind(navigator.permissions)
    navigator.permissions.query = async (descriptor) =>
      descriptor?.name === 'microphone' ? { state: 'prompt', onchange: null } : realQuery(descriptor)
  }
}

const out = { ok: false, permissionBefore: null, labels: [], enteredOnFirstClick: null, gumCalls: null, micAfterEntry: null, inGame: false, failures: [] }
try {
  await takeLock()
  log('lock taken')
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-features=WebGPU', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] })
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
  // NO grantPermissions: the permission stays 'prompt' until the fake UI answers the real dialog.
  const page = await context.newPage()
  await page.addInitScript(installStubBus)
  await page.goto(`${BASE}/scene/${SCENE}`, { waitUntil: 'domcontentloaded', timeout: 120000 })
  await page.waitForSelector('canvas', { timeout: 90000 })
  const button = page.getByRole('button', { name: /jump in/i }).first()
  let visible = await button.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
  if (!visible) {
    log('no sidebar Jump in yet — opening the Boots rail entry')
    for (const opener of [
      () => page.getByRole('button', { name: /boots/i }).first().click({ timeout: 2500 }),
      () => page.locator('img[alt=""]').first().click({ timeout: 2500 }),
      () => page.mouse.click(28, 331), () => page.mouse.click(28, 283), () => page.mouse.click(28, 379), () => page.mouse.click(28, 235), () => page.mouse.click(28, 187),
    ]) {
      try { await opener(); await page.waitForTimeout(900) } catch { continue }
      if (await button.isVisible().catch(() => false)) { visible = true; break }
    }
  }
  if (!visible) { out.failures.push('sidebar Jump in button not found'); await page.screenshot({ path: '/tmp/sidebar-nobutton.png' }); throw new Error('no button') }
  out.permissionBefore = await page.evaluate(async () => { try { return (await navigator.permissions.query({ name: 'microphone' })).state } catch { return 'n/a' } })
  // A HANDLE, not a text locator: the whole point of the gate is that the label
  // stops saying "Jump in" ('ALLOW THE MIC ↑', then '⏵ PLAY'), so a role/name
  // locator would stop matching the very button under test.
  const handle = await button.elementHandle()
  out.labelBefore = ((await handle.textContent()) ?? '').trim()
  log(`permission before: ${out.permissionBefore}; label '${out.labelBefore}'`)
  await page.waitForTimeout(1500) // let primeMicPermission settle so the plan is ask-first
  await handle.click()
  const t1 = Date.now()
  const seen = new Set()
  while (Date.now() - t1 < 8000) {
    const label = ((await handle.textContent().catch(() => '')) ?? '').trim()
    if (label && !seen.has(label)) { seen.add(label); out.labels.push(label); log(`label -> '${label}'`) }
    if (label.includes('PLAY')) break
    await page.waitForTimeout(80)
  }
  out.disabledWhileAsking = out.labels.some((l) => l.includes('ALLOW THE MIC'))
  out.enteredOnFirstClick = await page
    .waitForFunction(() => !!globalThis.__boots, null, { timeout: 8000 })
    .then(() => true)
    .catch(() => false)
  out.gumCalls = await page.evaluate(() => navigator.mediaDevices?.__gum ?? null)
  await page.screenshot({ path: '/tmp/sidebar-play.png' })
  if (out.enteredOnFirstClick) out.failures.push('the first click entered the game while the browser still had to ask')
  if (!out.labels.some((l) => l.includes('ALLOW THE MIC'))) out.failures.push(`never showed ALLOW THE MIC (labels: ${out.labels.join(' | ')})`)
  if (!out.labels.some((l) => l.includes('PLAY'))) out.failures.push(`never relabelled to PLAY (labels: ${out.labels.join(' | ')})`)
  if (out.gumCalls !== 1) out.failures.push(`getUserMedia called ${out.gumCalls} times on the first click (want 1)`)
  // click 2 -> enters, with the mic already live (no second dialog)
  await handle.click()
  out.inGame = await page.waitForFunction(() => !!globalThis.__boots, null, { timeout: 60000 }).then(() => true).catch(() => false)
  if (!out.inGame) out.failures.push('second click did not enter the game')
  else {
    await page.waitForTimeout(2500)
    out.micAfterEntry = await page.evaluate(() => globalThis.__boots?.voice?.()?.mic ?? null)
    out.gumCallsAfter = await page.evaluate(() => navigator.mediaDevices?.__gum ?? null)
    if (out.micAfterEntry !== 'live') out.failures.push(`mic after entry is '${out.micAfterEntry}', want live`)
    if (out.gumCallsAfter !== 1) out.failures.push(`getUserMedia called ${out.gumCallsAfter} times overall (want 1 — the second click must reuse the track)`)
    await page.screenshot({ path: '/tmp/sidebar-ingame.png' })
  }
  out.ok = out.failures.length === 0
} catch (e) {
  out.failures.push(String(e?.stack ?? e).slice(0, 400))
} finally {
  console.log(JSON.stringify(out))
  console.log(out.ok ? 'PASS' : `FAIL: ${out.failures.join(' | ')}`)
  await shutdown(out.ok ? 0 : 1)
}
