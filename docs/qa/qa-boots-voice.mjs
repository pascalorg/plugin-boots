/**
 * QA — CAN THE TWO PEOPLE IN ONE BUILDING HEAR EACH OTHER?
 *
 * The owner's ask was "talk to each other like if we were on a call or teammates
 * in fortnite". Nothing in the plugin's test suite can answer whether that is
 * true, because voice.test.ts drives one copy of the module against a scripted
 * WebRTC stack: it proves the state machine, never that two real browsers ever
 * complete an ICE handshake over the real bus and end up with each other's audio.
 *
 * That gap matters more here than anywhere else in the plugin, because every way
 * voice fails is SILENCE. A mesh that never opens a link, two peers that both
 * offer and deadlock, a description the host's 66 ms coalescing window ate, an
 * answer applied against the wrong epoch, a track that never reaches the sender,
 * two NATs that refuse each other — none of them throw, none of them log, and
 * all of them are indistinguishable in the room from "voice chat doesn't work".
 *
 * So this drives the real thing: two tabs, two live sessions, the lossy
 * host-faithful bus shim from qa-collab-bus.mjs for SIGNALLING, and Chromium's
 * fake capture device standing in for a microphone. What it asserts is the pair
 * of facts that make a call a call —
 *
 *   1. each side's RTCPeerConnection to the other reaches 'connected', and
 *   2. each side actually HOLDS the other's audio (a track on its element),
 *
 * plus the counters that would otherwise hide a limping negotiation: an offer
 * and an answer really went out, nothing was given up on, and how many frames
 * the coalescing window swallowed on the way (`notSent` — a number that is
 * expected to be non-zero and is not a failure; the resend loop exists for it).
 *
 * FAKE DEVICES, NOT A REAL MIC. `--use-fake-device-for-media-stream` gives every
 * tab a synthetic capture source and `--use-fake-ui-for-media-stream` grants the
 * permission without a dialog, which is the only way a headless run can press M
 * at all. The synthetic source is a periodic beep, so whether the talk gate opens
 * during any given window is not something to assert on — it is REPORTED, and the
 * gate itself is pinned by unit tests that feed it known levels.
 *
 *   SCENE=… node qa-boots-voice.mjs
 */
import { chromium } from './qa-playwright.mjs'
import { installBus } from './qa-collab-bus.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-voice-profile'
const SHOT = process.env.SHOT ?? '/tmp/boots-voice'
const log = (...a) => console.log(...a)

const browser = await chromium.launchPersistentContext(PROFILE, {
  args: [
    '--disable-features=WebGPU',
    // Two live games in one browser: Chromium throttles a tab it thinks nobody
    // is looking at, and only one of two pages is ever focused. Without these the
    // background session's 100 ms voice tick is clamped and every "the peer never
    // answered" reading is the harness, not the code.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    // A synthetic microphone, auto-granted. Nothing here can prompt.
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,900',
  ],
  headless: !process.env.HEADED,
  permissions: ['microphone'],
  viewport: { height: 900, width: 1280 },
})

const clients = []
for (const [index, who] of [
  ['A', { name: 'Owner', sessionId: 'session_A', clientId: 'client_A', userId: 'user_A' }],
  ['B', { name: 'Visitor', sessionId: 'session_B', clientId: 'client_B', userId: 'user_B' }],
].entries()) {
  const [label, identity] = who
  const page =
    index === 0 ? (browser.pages()[0] ?? (await browser.newPage())) : await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.addInitScript(installBus, { projectId: `project_${SCENE}`, ...identity })
  clients.push({ errors, identity, label, page })
}

for (const client of clients) {
  log(`[${client.label}] goto ${URL}`)
  await client.page
    .goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' })
    .catch((e) => log(`[${client.label}] goto:`, e.message))
}

const busReady = (client) =>
  client.page.evaluate(() => ({
    bus: Boolean(globalThis.__pascalCollabBus),
    peers: globalThis.__pascalCollabBus?.getParticipants?.()?.length ?? 0,
  }))
for (const wait of [4000, 8000, 15000]) {
  await clients[0].page.waitForTimeout(wait)
  for (const client of clients) log(`[${client.label}] ${JSON.stringify(await busReady(client))}`)
}

const jumpIn = async (client) => {
  const clicked = await client.page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((b) =>
      /jump in/i.test(b.textContent || ''),
    )
    if (!button) return false
    button.click()
    return true
  })
  log(`[${client.label}] jump in clicked: ${clicked}`)
}
for (const client of clients) await jumpIn(client)
await clients[0].page.waitForTimeout(20000)

const phase = (client) => client.page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)
const presence = (client) => client.page.evaluate(() => globalThis.__boots?.presence?.() ?? null)
const voice = (client) => client.page.evaluate(() => globalThis.__boots?.voice?.() ?? null)
const busStats = (client) => client.page.evaluate(() => globalThis.__busStats?.() ?? null)

for (const client of clients) log(`[${client.label}] phase ${await phase(client)}`)

// ── 0. is voice even on? ────────────────────────────────────────────────────
// `active:false` here means startVoice refused — no bus, or no
// RTCPeerConnection — and every later reading would be about the harness rather
// than the feature. Worth knowing before ten minutes of waiting.
log('\n=== 0. voice is running ===')
for (const client of clients) {
  const v = await voice(client)
  log(`[${client.label}] active ${v?.active} supported ${v?.supported} mode ${v?.mode} mic ${v?.mic}`)
}

// ── 0b. does the roster hold still? ─────────────────────────────────────────
// A voice link is built from the presence roster, so a remote that flickers out
// of it takes the whole handshake with it — connection, gathered candidates,
// epoch, applied watermark — and both ends begin again. That failure is
// invisible in every voice readout: it looks precisely like a peer who cannot be
// reached, and it is the opposite problem. So sample the roster faster than the
// negotiation deadline and count the disappearances directly.
log('\n=== 0b. presence roster stability (a flicker here breaks the call) ===')
const watchRoster = async (client) =>
  client.page.evaluate(() => {
    globalThis.__rosterWatch = { drops: 0, samples: 0, maxAgeMs: 0, seen: 0 }
    const w = globalThis.__rosterWatch
    let had = 0
    globalThis.__rosterTimer = setInterval(() => {
      const remotes = globalThis.__boots?.presence?.()?.remotes ?? []
      w.samples++
      w.seen = Math.max(w.seen, remotes.length)
      for (const r of remotes) w.maxAgeMs = Math.max(w.maxAgeMs, r.ageMs ?? 0)
      if (remotes.length < had) w.drops++
      had = remotes.length
    }, 200)
  })
for (const client of clients) await watchRoster(client)

// ── 1. the mesh forms before anybody speaks ─────────────────────────────────
// A link is opened for every peer in the session whether or not either side has
// a microphone: you must be able to HEAR people while your own mic is off, and
// the transceiver goes up front precisely so a later `replaceTrack` needs no
// renegotiation. So the handshake is expected to complete with mic 'off'.
log('\n=== 1. the mesh (no microphones yet) ===')
const meshLine = async () => {
  for (const client of clients) {
    const v = await voice(client)
    const peers = (v?.peers ?? [])
      .map(
        (p) =>
          // `step` is the whole point of the line: state says 'negotiating' for
          // both an await that never settled and an await that returned in
          // silence, and only the stage label tells them apart.
          `${p.sessionId} ${p.state}@${p.step}/${p.connection}/${p.ice} owed=${p.owed} track=${p.hasTrack}` +
          // A link inside its absence grace period is not negotiating and looks
          // identical to an idle one; only this says why.
          (p.absentMs ? ` absent=${p.absentMs}ms` : '') +
          (p.error ? ` ERR(${p.error})` : ''),
      )
      .join('  |  ')
    log(`[${client.label}] mic ${v?.mic}  peers: ${peers || '(none)'}`)
  }
}
for (let round = 0; round < 8; round++) {
  const front = clients[round % 2]
  await front.page.bringToFront()
  await front.page.waitForTimeout(2000)
  log(`  --- front=${front.label} ---`)
  await meshLine()
}

const connectedBothWays = async () => {
  const results = []
  for (const client of clients) {
    const v = await voice(client)
    const other = clients.find((c) => c !== client)
    const peer = (v?.peers ?? []).find((p) => p.sessionId === other.identity.sessionId)
    results.push({ label: client.label, ok: peer?.connection === 'connected', peer })
  }
  return results
}
const linked = await connectedBothWays()
for (const r of linked) log(`  ${r.label} → peer connection: ${r.peer?.connection ?? 'absent'}`)
const meshOk = linked.every((r) => r.ok)
log(`  MESH CONNECTED BOTH WAYS: ${meshOk}`)

// ── 2. the microphones ──────────────────────────────────────────────────────
// M is a one-shot off the input action queue, so a real keypress is the honest
// way in — it exercises input.ts, takeAction and VoiceControls, not just the
// module's exported entry point.
log('\n=== 2. press M on both ===')
for (const client of clients) {
  await client.page.bringToFront()
  await client.page.keyboard.press('m')
  await client.page.waitForTimeout(2500)
  const v = await voice(client)
  log(`[${client.label}] mic ${v?.mic}`)
}
await clients[0].page.waitForTimeout(6000)

// ── 3. does each side hold the other's audio? ───────────────────────────────
// `hasTrack` is the element's srcObject: the point at which a remote stream has
// actually arrived and is playing. A connection that is 'connected' with no
// track is the failure mode that looks perfect in every other readout.
log('\n=== 3. audio arrived ===')
for (let round = 0; round < 6; round++) {
  const front = clients[round % 2]
  await front.page.bringToFront()
  await front.page.waitForTimeout(2000)
  log(`  --- front=${front.label} ---`)
  await meshLine()
}
const audio = []
for (const client of clients) {
  const v = await voice(client)
  const other = clients.find((c) => c !== client)
  const peer = (v?.peers ?? []).find((p) => p.sessionId === other.identity.sessionId)
  audio.push({ label: client.label, ok: Boolean(peer?.hasTrack), gain: peer?.gain })
  log(`  ${client.label} holds ${other.label}'s audio: ${Boolean(peer?.hasTrack)}  gain ${peer?.gain}`)
}
const audioOk = audio.every((r) => r.ok)
log(`  AUDIO FLOWING BOTH WAYS: ${audioOk}`)

// ── 4. the talk gate, reported not asserted ─────────────────────────────────
// The fake device is a periodic beep, so the gate opening inside any particular
// two-second window is luck. What is worth seeing is that the flag MOVES and
// that each side reads the other's — the wiring behind the speaking dot.
log('\n=== 4. talk gate (fake device beeps — reported, not asserted) ===')
for (let round = 0; round < 6; round++) {
  await clients[round % 2].page.bringToFront()
  await clients[0].page.waitForTimeout(1200)
  const line = []
  for (const client of clients) {
    const v = await voice(client)
    line.push(`${client.label}: self ${v?.talking} peers-talking ${(v?.peers ?? []).filter((p) => p.talking).length}`)
  }
  log(`  ${line.join('   |   ')}`)
}

// ── 5. proximity ────────────────────────────────────────────────────────────
// Switching the mode must rewrite every level on the next tick. Both peers spawn
// at the same point, so 'proximity' should read close to full rather than faded —
// what is under test is that the gain is RE-EVALUATED, not the distance curve
// (voice-policy.test.ts owns the curve).
log('\n=== 5. mode switch rewrites the mix ===')
for (const client of clients) {
  const before = (await voice(client))?.peers?.[0]?.gain
  await client.page.evaluate(() => globalThis.__boots?.voiceMode?.('proximity'))
  await client.page.waitForTimeout(1500)
  const after = await voice(client)
  log(`[${client.label}] mode ${after?.mode}  gain ${before} → ${after?.peers?.[0]?.gain}`)
  await client.page.evaluate(() => globalThis.__boots?.voiceMode?.('squad'))
}

// ── 6. what the wire actually did ───────────────────────────────────────────
log('\n=== 6. counters ===')
for (const client of clients) {
  const v = await voice(client)
  log(`[${client.label}] counters ${JSON.stringify(v?.counters)}`)
  log(`[${client.label}] unreachable ${JSON.stringify(v?.unreachable)}`)
  log(`[${client.label}] busStats ${JSON.stringify(await busStats(client))}`)
  const p = await presence(client)
  log(`[${client.label}] presence remotes ${p?.remotes?.length ?? 0}`)
  const w = await client.page.evaluate(() => globalThis.__rosterWatch ?? null)
  log(`[${client.label}] roster ${JSON.stringify(w)}`)
}

const counters = []
for (const client of clients) counters.push((await voice(client))?.counters ?? {})
// An offer and an answer between them (exactly one side offers per pair — the
// total order in voice-policy decides which), and nobody written off.
const signalled =
  counters.reduce((sum, c) => sum + (c.offersSent ?? 0), 0) >= 1 &&
  counters.reduce((sum, c) => sum + (c.answersSent ?? 0), 0) >= 1
const gaveUp = counters.reduce((sum, c) => sum + (c.given_up ?? 0), 0)
// Nobody leaves during this run, so every reaped link is presence churn that
// threw away a handshake in progress.
const reaped = counters.reduce((sum, c) => sum + (c.reaped ?? 0), 0)

log('\n=== VERDICT ===')
log(`  mesh connected both ways : ${meshOk}`)
log(`  audio flowing both ways  : ${audioOk}`)
log(`  offer + answer exchanged : ${signalled}`)
log(`  peers given up on        : ${gaveUp} (must be 0)`)
log(`  frames the bus swallowed : ${counters.map((c) => c.notSent ?? 0).join(' / ')} (expected, resent)`)
log(`  links reaped mid-call    : ${reaped} (must be 0 — nobody left)`)
log(`  VOICE WORKS: ${meshOk && audioOk && signalled && gaveUp === 0 && reaped === 0}`)

for (const client of clients) {
  await client.page.screenshot({ path: `${SHOT}-${client.label}.png` }).catch(() => {})
  log(`[${client.label}] page errors: ${client.errors.length}`)
  for (const e of client.errors.slice(0, 5)) log(`   ${e}`)
}

await browser.close()
