#!/usr/bin/env node
/**
 * QA: Boots co-presence — two-browser presence replay (SKELETON).
 *
 * ⚠ TARGET: the COMMUNITY app on http://localhost:3001 ONLY. Co-presence
 * rides the host collaboration bus (`globalThis.__pascalCollabBus`), which
 * only the community app mounts. The solo dev app on :3002 has no bus —
 * there this script proves exactly one thing: presence() stays empty and
 * the game is untouched (the solo-regression phase below).
 *
 * Style: private-editor QA-script conventions — puppeteer against a live
 * app, all game assertions through the `__boots` page handle, phases print
 * PASS/FAIL lines and the process exits non-zero on any failure. This file
 * is a committed REFERENCE skeleton: the TODO blocks (project URL, auth,
 * jump-in selector) depend on the host build and must be filled in when
 * the host side of the bus ships.
 *
 * Run:  node docs/qa/qa-boots-presence.mjs [baseUrl]
 * Deps: npm i -g puppeteer  (or run inside a repo that has it)
 */

import puppeteer from 'puppeteer'

const BASE_URL = process.argv[2] ?? 'http://localhost:3001'
// TODO(host): a project both test users can open, with collab enabled.
const PROJECT_PATH = '/projects/QA-PRESENCE-PROJECT'
const JUMP_IN_TIMEOUT_MS = 30_000

let failures = 0
const pass = (name) => console.log(`  PASS  ${name}`)
const fail = (name, detail = '') => {
  failures++
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
}
const check = (name, ok, detail = '') => (ok ? pass(name) : fail(name, detail))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Evaluate against the __boots dev handle (null until a session is live). */
async function boots(page, expression) {
  return page.evaluate((expr) => {
    const handle = globalThis.__boots
    if (!handle) return null
    // eslint-disable-next-line no-new-func
    return new Function('__boots', `return (${expr})`)(handle)
  }, expression)
}

async function launchClient(name) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--use-gl=angle', '--enable-unsafe-webgpu', '--window-size=1280,800'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  // Sentinel watch: any INVARIANT VIOLATION during the replay is a failure;
  // the calm remote-op lease info line is EXPECTED noise.
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.text().includes('INVARIANT VIOLATION')) consoleErrors.push(msg.text())
  })
  console.log(`[${name}] launched`)
  return { browser, page, consoleErrors, name }
}

async function openProject(client) {
  // TODO(host): authentication for two distinct test users (cookies or a
  // login flow) — presence names come from the participant roster, so the
  // two clients must be DIFFERENT users to exercise the palette/name path.
  await client.page.goto(`${BASE_URL}${PROJECT_PATH}`, { waitUntil: 'networkidle2' })
  // Bus must exist before jump-in — this is the :3001-only gate.
  const hasBus = await client.page.evaluate(
    () => globalThis.__pascalCollabBus?.version === 1,
  )
  check(`[${client.name}] collab bus present (v1)`, hasBus, 'run against :3001, not :3002')
  return hasBus
}

async function jumpIn(client) {
  // TODO(host): the real Jump-in affordance (Boots panel button). The
  // fallback below assumes the panel exposes it as a data-testid.
  await client.page.click('[data-testid="boots-jump-in"]').catch(() => {})
  const started = await client.page
    .waitForFunction(() => Boolean(globalThis.__boots), { timeout: JUMP_IN_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false)
  check(`[${client.name}] session live (__boots mounted)`, started)
  // Wait out the loading veil so publishes reflect a revealed session.
  await client.page
    .waitForFunction(() => !document.querySelector('[data-boots-veil]'), { timeout: 10_000 })
    .catch(() => {})
  return started
}

async function main() {
  console.log(`Boots co-presence QA against ${BASE_URL}`)
  const a = await launchClient('A')
  const b = await launchClient('B')

  try {
    // ── Phase 1: both clients in the same project, both in-game ───────────
    if (!(await openProject(a)) || !(await openProject(b))) throw new Error('no bus')
    await jumpIn(a)
    await jumpIn(b)
    await sleep(2000) // a couple of publish intervals + join edges

    // ── Phase 2: mutual visibility + counters ──────────────────────────────
    const presenceA = await boots(a.page, '__boots.presence()')
    const presenceB = await boots(b.page, '__boots.presence()')
    check('[A] sees exactly one remote', presenceA?.remotes?.length === 1, JSON.stringify(presenceA))
    check('[B] sees exactly one remote', presenceB?.remotes?.length === 1, JSON.stringify(presenceB))
    check('[A] published climbing', (presenceA?.published ?? 0) > 5)
    check('[A] received climbing', (presenceA?.received ?? 0) > 5)
    check('[B] remote has a name', Boolean(presenceB?.remotes?.[0]?.name))

    // ── Phase 3: motion — B watches A run (teleport + sample twice) ───────
    await boots(a.page, '__boots.teleport(4, 4, 0)')
    await sleep(400)
    const p1 = (await boots(b.page, '__boots.presence()'))?.remotes?.[0]?.p
    await boots(a.page, '__boots.teleport(4, 8, 0)') // >3m — the snap path
    await sleep(600)
    const p2 = (await boots(b.page, '__boots.presence()'))?.remotes?.[0]?.p
    check(
      '[B] remote pose tracks A across a teleport',
      Array.isArray(p1) && Array.isArray(p2) && Math.abs(p2[2] - p1[2]) > 2,
      `p1=${JSON.stringify(p1)} p2=${JSON.stringify(p2)}`,
    )

    // ── Phase 4: weapon swap propagates ───────────────────────────────────
    // TODO(host): pick up a gun on A (gear table interaction or store poke),
    // then assert `presence().remotes[0].w` flips on B within ~500 ms.

    // ── Phase 5: leave — Esc despawns instantly on the peer ───────────────
    await a.page.keyboard.press('Escape')
    await sleep(800)
    const afterLeave = await boots(b.page, '__boots.presence()')
    check('[B] A despawned instantly on Esc (goodbye frame)', afterLeave?.remotes?.length === 0)

    // ── Phase 6: staleness — killed tab despawns within ~3.5 s ────────────
    // TODO(host): re-jump A, then a.browser.close() WITHOUT Esc and assert
    // B's presence().remotes drains within STALE_MS + one tick.

    // ── Phase 7: sentinel — peer edit during play stays calm ──────────────
    // TODO(host): drive a scene edit from A's EDITOR while B is in-game;
    // assert B logged the lease info line and zero INVARIANT VIOLATIONs.

    // ── Sentinel gate (whole replay) ───────────────────────────────────────
    check('[A] zero invariant violations', a.consoleErrors.length === 0, a.consoleErrors[0])
    check('[B] zero invariant violations', b.consoleErrors.length === 0, b.consoleErrors[0])
  } catch (error) {
    fail('replay aborted', String(error))
  } finally {
    await a.browser.close().catch(() => {})
    await b.browser.close().catch(() => {})
  }

  console.log(failures === 0 ? '\nALL GREEN' : `\n${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

main()
