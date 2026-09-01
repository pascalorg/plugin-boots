/**
 * QA — DOES THE SHARE BUTTON TELL THE TRUTH?
 *
 * The sentence under "🔗 Share link" is the only thing that tells the owner
 * whether the link they just copied will actually put a friend in the game with
 * them, and for a while it lied: it promised "anyone with it signs in and drops
 * straight into your game" for every PUBLIC project, when dropping in also
 * requires the project to be an open lobby — a separate host decision that
 * visibility deliberately does not imply. A public non-lobby link renders the
 * building read-only. That is the "nothing really like joining a game together"
 * report, and the copy was part of why nobody caught it sooner.
 *
 * share-link.test.ts pins the pure function. What it cannot see is the wiring:
 * whether the panel reads the bridge at all, whether it reads it at CLICK time
 * (the owner can flip visibility from the host navbar between two clicks), and
 * whether the amber caveat styling actually lands on the caveat. So this drives
 * the real panel in a real browser against a real host bridge and reads the
 * sentence off the DOM.
 *
 * THE BRIDGE IS FAKED, ON PURPOSE. The host installs
 * `window.__pascalProjectShare` from `plugin-project-share.tsx`, and the local
 * dev server at :3002 is the standalone editor app, which has no projects table
 * and never installs one. Faking it is also the only way to drive the four
 * combinations that matter — the host would need four differently-configured
 * projects to do the same, one of them a lobby, and the whole point of the
 * bridge is that the plugin's behaviour depends on nothing but those fields.
 *
 *   SCENE=… node qa-boots-share.mjs
 */
import { chromium } from './qa-playwright.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
// `?boots=drop` is not decoration: on a bare /scene the plugin is not loaded at
// all (`globalThis.__boots` is absent and no rail entry exists yet), so there is
// no panel to read. The drop marker is also the exact route the owner arrives
// by — he reported reaching the sidebar this way: "i went on /play/... and boots
// started. now out of it i see this how do i click share link".
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-share-profile'
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: ['--disable-features=WebGPU', '--window-size=1400,950'],
  headless: !process.env.HEADED,
  permissions: ['clipboard-read', 'clipboard-write'],
  viewport: { height: 950, width: 1400 },
})

const page = browser.pages()[0] ?? (await browser.newPage())
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))

// A v2 bridge, installed before the app runs so the panel's mount-time
// `subscribe` finds it. The two fields are mutated per case from the harness.
await page.addInitScript(() => {
  const listeners = new Set()
  globalThis.__pascalProjectShare = {
    isOpenLobby: false,
    isPrivate: true,
    projectId: 'project_qa',
    setPublic: async () => {
      globalThis.__pascalProjectShare.isPrivate = false
      for (const listener of listeners) listener()
      return { ok: true }
    },
    subscribe: (handler) => {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
    version: 2,
  }
  globalThis.__qaNotify = () => {
    for (const listener of listeners) listener()
  }
})

log(`goto ${URL}`)
await page.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log('goto:', e.message))
await page.waitForTimeout(15000)

/**
 * Get to the sidebar the owner sees. The plugin mounts its panel once the game
 * has been entered, so the honest route is the one he took: drop in, then Esc
 * back out to the editor — which is also the moment the panel is on screen and
 * the Share link button is the thing he is looking for.
 */
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
  const phase = await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)
  log(`phase in game: ${phase}`)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(4000)
  log(`phase after Esc: ${await page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)}`)
}

/** The rail collapses the plugin panels; open Boots if it is not already. */
const findShareButton = async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await page.evaluate(() =>
      [...document.querySelectorAll('button')].some((b) => /share link/i.test(b.textContent || '')),
    )
    if (found) return true
    // The rail entry for a plugin is an ICON, with no text and no aria-label:
    // the only thing that names Boots is the image source. So find the icon and
    // click whatever wraps it.
    const opened = await page.evaluate(() => {
      const icon = document.querySelector('img[src*="boots-icon"]')
      const clickable =
        icon?.closest('button, [role="button"], [role="tab"], a') ?? icon?.parentElement
      if (!clickable) return false
      clickable.click()
      return true
    })
    log(`  share button not found yet; clicked the Boots rail icon: ${opened}`)
    await page.waitForTimeout(4000)
  }
  return page.evaluate(() =>
    [...document.querySelectorAll('button')].some((b) => /share link/i.test(b.textContent || '')),
  )
}

await enterThenLeave()
const ready = await findShareButton()
log(`share button on screen: ${ready}`)
if (!ready) {
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim().slice(0, 40)).filter(Boolean).slice(0, 40),
  )
  log('buttons seen:', JSON.stringify(buttons, null, 1))
}

/** Click the first Share link button and read back what the panel says. */
const clickShare = async () => {
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /share link/i.test(b.textContent || ''),
    )
    button?.click()
  })
  await page.waitForTimeout(1500)
  return page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /share link/i.test(b.textContent || ''),
    )
    const panel = button?.parentElement
    const paragraphs = [...(panel?.querySelectorAll('p') ?? [])].map((p) => ({
      amber: /amber/.test(p.className),
      text: (p.textContent || '').trim(),
    }))
    return {
      link: panel?.querySelector('input')?.value ?? null,
      makePublic: [...(panel?.querySelectorAll('button') ?? [])].some((b) =>
        /make it public/i.test(b.textContent || ''),
      ),
      paragraphs,
    }
  })
}

const setBridge = async (isPrivate, isOpenLobby) => {
  await page.evaluate(
    ([priv, lobby]) => {
      globalThis.__pascalProjectShare.isPrivate = priv
      globalThis.__pascalProjectShare.isOpenLobby = lobby
      globalThis.__qaNotify()
    },
    [isPrivate, isOpenLobby],
  )
  await page.waitForTimeout(600)
}

const CASES = [
  {
    isOpenLobby: false,
    isPrivate: true,
    name: 'private, not a lobby',
    wantWarning: true,
    reject: [/drops straight into your game/i],
    require: [],
  },
  {
    isOpenLobby: true,
    isPrivate: true,
    name: 'private, IS a lobby — private still wins',
    wantWarning: true,
    reject: [/drops straight into your game/i, /anyone/i],
    require: [],
  },
  {
    isOpenLobby: false,
    isPrivate: false,
    name: 'public, not a lobby — the sentence that used to lie',
    wantWarning: false,
    reject: [/drops straight into your game/i],
    require: [/read-only/i, /not an open lobby/i],
    wantAmber: true,
  },
  {
    isOpenLobby: true,
    isPrivate: false,
    name: 'public AND a lobby — the only case that gets the promise',
    wantWarning: false,
    reject: [],
    require: [/drops straight into your game/i],
    wantAmber: false,
  },
]

let failures = 0
for (const testCase of CASES) {
  log(`\n=== ${testCase.name} ===`)
  await setBridge(testCase.isPrivate, testCase.isOpenLobby)
  const seen = await clickShare()
  const text = seen.paragraphs.map((p) => p.text).join(' ⏎ ')
  const amber = seen.paragraphs.some((p) => p.amber && !/only you can join/i.test(p.text))
  log(`  link       : ${seen.link ?? '(copied to clipboard)'}`)
  log(`  says       : ${text || '(nothing)'}`)
  log(`  amber      : ${amber}   make-it-public button: ${seen.makePublic}`)

  const fail = (why) => {
    failures++
    log(`  ✗ ${why}`)
  }
  for (const pattern of testCase.require) {
    if (!pattern.test(text)) fail(`missing ${pattern}`)
  }
  for (const pattern of testCase.reject) {
    if (pattern.test(text)) fail(`must not say ${pattern}`)
  }
  if (seen.makePublic !== testCase.wantWarning) {
    fail(`private warning ${seen.makePublic} but expected ${testCase.wantWarning}`)
  }
  if (testCase.wantAmber !== undefined && amber !== testCase.wantAmber) {
    fail(`amber ${amber} but expected ${testCase.wantAmber}`)
  }
}

// ── the one-click publish, end to end ───────────────────────────────────────
// The trap this closes: "Make it public" succeeds, and the old copy
// congratulated the owner with a promise that publishing has no power to make
// true. A non-lobby is still a non-lobby after it goes public.
log('\n=== make it public, on a project that is not a lobby ===')
await setBridge(true, false)
await clickShare()
await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) =>
    /make it public/i.test(b.textContent || ''),
  )
  button?.click()
})
await page.waitForTimeout(2500)
const afterPublish = await page.evaluate(() => {
  const button = [...document.querySelectorAll('button')].find((b) =>
    /share link/i.test(b.textContent || ''),
  )
  return [...(button?.parentElement?.querySelectorAll('p') ?? [])]
    .map((p) => (p.textContent || '').trim())
    .join(' ⏎ ')
})
log(`  says: ${afterPublish}`)
if (/drops straight into your game/i.test(afterPublish)) {
  failures++
  log('  ✗ publishing a non-lobby still promised the friend drops in')
}
if (!/not an open lobby/i.test(afterPublish)) {
  failures++
  log('  ✗ publishing a non-lobby did not say the link cannot deliver anyone')
}

log('\n=== VERDICT ===')
log(`  share button reachable : ${ready}`)
log(`  page errors            : ${errors.length}`)
for (const error of errors.slice(0, 5)) log(`     ${error}`)
log(`  failed assertions      : ${failures}`)
log(`  SHARE COPY IS HONEST: ${ready && failures === 0 && errors.length === 0}`)

await page.screenshot({ path: '/tmp/boots-share.png' }).catch(() => {})
await browser.close()
