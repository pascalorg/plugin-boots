/**
 * QA — DOES THE SIDEBAR SAY WHETHER ANYONE ELSE IS HERE?
 *
 * The report this closes is "so nothing really like joining a game together":
 * two people, one link, and no way to tell from either screen whether the other
 * one arrived. That single silence covers several unrelated failures — the link
 * never opened, it opened read-only, the bus was off, or both arrived and never
 * found each other in a big building — and the owner cannot tell which without a
 * devtools console.
 *
 * roster.test.ts pins the wording. What it cannot see is the wiring, and the
 * wiring is where the interesting failures are: whether the panel reads the HOST
 * bus (net.ts's copy is torn down between game sessions, which is exactly when
 * the sidebar is on screen and would wrongly read "just you"), whether a roster
 * change reaches the line without a reload, and whether our own window is
 * excluded while our own SECOND window still counts.
 *
 * THE BUS IS FAKED, ON PURPOSE — same reason as qa-boots-share.mjs: :3002 is
 * the standalone editor app and never installs one, and no real session can
 * produce a five-person roster on demand.
 *
 *   SCENE=… node qa-boots-roster.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
// `?boots=drop` because on a bare /scene the plugin is not loaded at all.
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-roster-profile'
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', '--window-size=1400,950'],
  headless: !process.env.HEADED,
  viewport: { height: 950, width: 1400 },
})

const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

// A v1 host bus whose roster the harness can rewrite, plus a v2 share bridge so
// the reach-aware intro next to the roster line can be checked in the same run.
await page.addInitScript(() => {
  const rosterHandlers = new Set()
  let participants = []
  globalThis.__pascalCollabBus = {
    clientId: 'client-mine',
    getParticipants: () => participants,
    onParticipants: (handler) => {
      rosterHandlers.add(handler)
      return () => rosterHandlers.delete(handler)
    },
    projectId: 'project_qa',
    publish: () => 'sent',
    sessionId: 'session-mine',
    subscribe: () => () => {},
    userId: 'user-mine',
    version: 1,
  }
  // Rewrite the roster and fire the host's event, the way a real join does.
  globalThis.__qaRoster = (next) => {
    participants = next
    for (const handler of rosterHandlers) handler(participants)
  }
  const shareHandlers = new Set()
  globalThis.__pascalProjectShare = {
    isOpenLobby: true,
    isPrivate: false,
    projectId: 'project_qa',
    setPublic: async () => ({ ok: true }),
    subscribe: (handler) => {
      shareHandlers.add(handler)
      return () => shareHandlers.delete(handler)
    },
    version: 2,
  }
  globalThis.__qaShare = (isOpenLobby) => {
    globalThis.__pascalProjectShare.isOpenLobby = isOpenLobby
    for (const handler of shareHandlers) handler()
  }
})

log(`goto ${URL}`)
await page
  .goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' })
  .catch((e) => log('goto:', e.message))
await page.waitForTimeout(15000)

/** Drop in and Esc back out — the route that mounts the panel. */
const enterThenLeave = async () => {
  const jumped = await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /jump in/i.test(b.textContent || ''),
    )
    if (!button) return false
    button.click()
    return true
  })
  log(`jump in clicked: ${jumped}`)
  await page.waitForTimeout(12000)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(4000)
}

/** The rail entry is an icon with no text and no aria-label. */
const openPanel = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await page.evaluate(() => !!document.querySelector('[data-boots-roster]'))
    if (found) return true
    await page.evaluate(() => {
      const icon = document.querySelector('img[src*="boots-icon"]')
      const clickable =
        icon?.closest('button, [role="button"], [role="tab"], a') ?? icon?.parentElement
      clickable?.click()
    })
    await page.waitForTimeout(4000)
  }
  return page.evaluate(() => !!document.querySelector('[data-boots-roster]'))
}

const readRoster = () =>
  page.evaluate(() => {
    const line = document.querySelector('[data-boots-roster]')
    if (!line) return null
    // The intro paragraph is the roster line's next sibling in the section.
    const intro = line.nextElementSibling
    return {
      dot: !!line.querySelector('span[aria-hidden="true"]'),
      emphasized: /text-sidebar-foreground\/80/.test(line.className),
      intro: (intro?.textContent || '').trim(),
      marker: line.getAttribute('data-boots-roster'),
      text: (line.textContent || '').trim(),
    }
  })

const setRoster = async (participants) => {
  await page.evaluate((next) => globalThis.__qaRoster(next), participants)
  await page.waitForTimeout(1200)
}

const sessions = (...ids) => ids.map((id) => ({ clientId: `client-${id}`, sessionId: id }))

await enterThenLeave()
const ready = await openPanel()
log(`roster line on screen: ${ready}`)
if (!ready) {
  const seen = await page.evaluate(() =>
    [...document.querySelectorAll('button')]
      .map((b) => (b.textContent || '').trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 40),
  )
  log('buttons seen:', JSON.stringify(seen, null, 1))
}

let failures = 0
const fail = (why) => {
  failures++
  log(`  ✗ ${why}`)
}

const CASES = [
  {
    name: 'only my own session — alone, but joinable',
    participants: [{ name: 'Julien', sessions: sessions('session-mine'), userId: 'user-mine' }],
    marker: '0',
    require: [/just you in here right now/i],
    reject: [/nobody can join/i],
    emphasized: false,
  },
  {
    name: 'one other person arrived — the answer the owner is looking for',
    participants: [
      { name: 'Julien', sessions: sessions('session-mine'), userId: 'user-mine' },
      { name: 'Anna', sessions: sessions('session-anna'), userId: 'user-anna' },
    ],
    marker: '1',
    require: [/Anna is in here with you/],
    reject: [/just you/i, /in the game/i],
    emphasized: true,
  },
  {
    name: 'my own SECOND window counts — same account, two devices',
    participants: [
      { name: 'Julien', sessions: sessions('session-mine', 'session-phone'), userId: 'user-mine' },
    ],
    marker: '1',
    require: [/Julien is in here with you/],
    reject: [/just you/i],
    emphasized: true,
  },
  {
    name: 'two others read as a pair',
    participants: [
      { name: 'Julien', sessions: sessions('session-mine'), userId: 'user-mine' },
      { name: 'Anna', sessions: sessions('session-anna'), userId: 'user-anna' },
      { name: 'Bob', sessions: sessions('session-bob'), userId: 'user-bob' },
    ],
    marker: '2',
    require: [/Anna and Bob are in here with you/],
    reject: [],
    emphasized: true,
  },
  {
    name: 'a crowd names three and prints the remainder',
    participants: [
      { name: 'Julien', sessions: sessions('session-mine'), userId: 'user-mine' },
      ...['Anna', 'Bob', 'Cleo', 'Dan', 'Eve'].map((name, index) => ({
        name,
        sessions: sessions(`s${index}`),
        userId: `user-${name}`,
      })),
    ],
    marker: '5',
    require: [/\+2 more are in here with you/],
    reject: [],
    emphasized: true,
  },
  {
    name: 'everyone left again — back to alone, live, with no reload',
    participants: [{ name: 'Julien', sessions: sessions('session-mine'), userId: 'user-mine' }],
    marker: '0',
    require: [/just you in here right now/i],
    reject: [/Anna/],
    emphasized: false,
  },
]

for (const testCase of CASES) {
  log(`\n=== ${testCase.name} ===`)
  await setRoster(testCase.participants)
  const seen = await readRoster()
  if (!seen) {
    fail('the roster line disappeared')
    continue
  }
  log(`  says       : ${seen.text}`)
  log(`  marker     : ${seen.marker}   emphasized: ${seen.emphasized}   dot: ${seen.dot}`)
  for (const pattern of testCase.require) {
    if (!pattern.test(seen.text)) fail(`missing ${pattern}`)
  }
  for (const pattern of testCase.reject) {
    if (pattern.test(seen.text)) fail(`must not say ${pattern}`)
  }
  if (seen.marker !== testCase.marker) {
    fail(`marker ${seen.marker} but expected ${testCase.marker}`)
  }
  if (seen.emphasized !== testCase.emphasized) {
    fail(`emphasized ${seen.emphasized} but expected ${testCase.emphasized}`)
  }
  if (!seen.dot) fail('no presence dot rendered')
}

// ── the intro above the share button obeys reach too ─────────────────────────
// Fixing the after-click message and leaving the standing blurb promising a
// drop-in is not a fix: whichever the owner reads first is the one he acts on.
log('\n=== the intro next to the roster follows reach ===')
const lobbyIntro = (await readRoster())?.intro ?? ''
log(`  lobby     : ${lobbyIntro}`)
if (!/drop straight into the game/i.test(lobbyIntro)) {
  fail('an open lobby did not promise the drop-in')
}
await page.evaluate(() => globalThis.__qaShare(false))
await page.waitForTimeout(1200)
const nonLobbyIntro = (await readRoster())?.intro ?? ''
log(`  non-lobby : ${nonLobbyIntro}`)
if (/drop straight into the game/i.test(nonLobbyIntro)) {
  fail('a non-lobby still promised the friend drops in')
}
if (!/not an open lobby/i.test(nonLobbyIntro)) {
  fail('a non-lobby did not say nobody can jump in')
}

log('\n=== VERDICT ===')
log(`  roster line reachable : ${ready}`)
log(`  page errors           : ${errors.length}`)
for (const error of errors.slice(0, 5)) log(`     ${error}`)
log(`  failed assertions     : ${failures}`)
log(`  SIDEBAR SAYS WHO IS HERE: ${ready && failures === 0 && errors.length === 0}`)

await page.screenshot({ path: '/tmp/boots-roster.png' }).catch(() => {})
await browser.close()
