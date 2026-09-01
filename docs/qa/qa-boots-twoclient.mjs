/**
 * QA — DO TWO PLAYERS SHARE ONE BUILDING? (builds AND destruction, both ways)
 *
 * The owner's requirement is one sentence: "everything must be synchronous in
 * multiplayer — builds AND destruction". Nothing in the plugin's own test suite
 * can answer that, because every unit test drives ONE copy of the world with a
 * scripted transport. What was never run is the thing being shipped: two live
 * sessions, two real world runtimes, one wire between them.
 *
 * :3002 has no collaboration bus (it is the editor dev server, not the app), and
 * net.ts is feature-detected, so Boots there is deliberately solo. So this
 * harness supplies the missing half: a `__pascalCollabBus` v1 that bridges two
 * tabs over a BroadcastChannel.
 *
 * THE SHIM MIRRORS THE HOST, NOT AN IDEALISED WIRE. A test transport that
 * delivers everything instantly would prove nothing about production, where the
 * bus is lossy by design. So it reproduces, from
 * `plugin-collab-bus.ts` (the host module it stands in for):
 *
 *   - latest-value coalescing per (pluginId, event), clamped to one send every
 *     66 ms — intermediate payloads for the same key are DROPPED, which is the
 *     single most important property for a delta stream to survive;
 *   - the 8 000-byte serialized frame budget, measured on the same probe shape,
 *     with an over-budget publish returning 'suppressed' rather than throwing;
 *   - HOST-STAMPED identity: the receiver's `sessionId`/`clientId`/`userId` come
 *     from the transport, never from the payload;
 *   - no echo to the sender's own session.
 *
 * Then it plays: A builds, B must see it; B blows a wall apart, A must see the
 * same voxels die. Both directions, because a one-way wire looks identical to a
 * working one from whichever end happens to be driving.
 *
 *   SCENE=… node qa-boots-twoclient.mjs
 */
import { chromium } from 'playwright'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-twoclient-profile'
const SHOT = process.env.SHOT ?? '/tmp/boots-two'
const log = (...a) => console.log(...a)

/** Mirrors apps/community/.../plugin-collab-bus.ts. Runs inside the page. */
function installBus({ projectId, sessionId, clientId, userId, name }) {
  const COALESCE_MS = 66
  const MAX_SERIALIZED = 8000
  const MAX_EVENT = 40
  const PLUGIN_ID_PATTERN = /^[A-Za-z0-9:_-]{1,160}$/
  const channel = new BroadcastChannel(`boots-qa-bus:${projectId}`)
  const subscribers = new Map()
  const participantHandlers = new Set()
  const lastSentAtByKey = new Map()
  const pendingByKey = new Map()
  const encoder = new TextEncoder()
  let participants = []
  const stats = { published: 0, suppressed: 0, deferred: 0, delivered: 0, coalesced: 0 }

  const fits = (pluginId, event, data) => {
    try {
      const probe = JSON.stringify({
        clientId,
        data,
        event,
        kind: 'plugin',
        pluginId,
        projectId,
        protocolVersion: 1,
        sentAt: Number.MAX_SAFE_INTEGER,
        sequence: Number.MAX_SAFE_INTEGER,
        sessionId,
      })
      return encoder.encode(probe).byteLength <= MAX_SERIALIZED
    } catch {
      return false
    }
  }

  const send = (pluginId, event, data) => {
    channel.postMessage({
      clientId,
      data,
      event,
      pluginId,
      sentAt: Date.now(),
      sessionId,
      userId,
    })
    stats.published += 1
    lastSentAtByKey.set(`${pluginId}\n${event}`, Date.now())
  }

  const schedule = (pluginId, event, key, data, delayMs) => {
    const existing = pendingByKey.get(key)
    if (existing) clearTimeout(existing.timer)
    pendingByKey.set(key, {
      data,
      timer: setTimeout(
        () => {
          const pending = pendingByKey.get(key)
          pendingByKey.delete(key)
          if (pending) send(pluginId, event, pending.data)
        },
        Math.max(1, delayMs),
      ),
    })
  }

  const publish = (pluginId, event, data) => {
    if (!PLUGIN_ID_PATTERN.test(pluginId)) return 'suppressed'
    if (typeof event !== 'string' || event.length < 1 || event.length > MAX_EVENT) {
      return 'suppressed'
    }
    if (!fits(pluginId, event, data)) {
      stats.suppressed += 1
      return 'suppressed'
    }
    const key = `${pluginId}\n${event}`
    const pending = pendingByKey.get(key)
    if (pending) {
      // Latest-value coalescing: the queued payload is REPLACED and the one it
      // replaced never reaches the wire. This is the lossy edge under test.
      pending.data = data
      stats.coalesced += 1
      stats.deferred += 1
      return 'deferred'
    }
    const lastSentAt = lastSentAtByKey.get(key)
    const elapsed = lastSentAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - lastSentAt
    if (elapsed < COALESCE_MS) {
      schedule(pluginId, event, key, data, COALESCE_MS - elapsed)
      stats.deferred += 1
      return 'deferred'
    }
    send(pluginId, event, data)
    return 'sent'
  }

  channel.onmessage = (message) => {
    const frame = message.data
    if (!frame || frame.sessionId === sessionId) return // never echo to self
    const handlers = subscribers.get(frame.pluginId)
    if (!handlers) return
    stats.delivered += 1
    for (const handler of [...handlers]) {
      handler({
        clientId: frame.clientId,
        data: frame.data,
        event: frame.event,
        sentAt: frame.sentAt,
        sessionId: frame.sessionId,
        userId: frame.userId,
      })
    }
  }

  // Roster: each tab announces itself on a side channel so both see two people.
  const roster = new BroadcastChannel(`boots-qa-roster:${projectId}`)
  const known = new Map([[userId, { name, sessions: [{ clientId, sessionId }], userId }]])
  const pushRoster = () => {
    participants = [...known.values()]
    for (const handler of [...participantHandlers]) handler(participants.map((p) => ({ ...p })))
  }
  roster.onmessage = (message) => {
    const peer = message.data
    if (!peer || peer.userId === userId) return
    known.set(peer.userId, peer)
    pushRoster()
    roster.postMessage({ name, sessions: [{ clientId, sessionId }], userId })
  }
  pushRoster()
  roster.postMessage({ name, sessions: [{ clientId, sessionId }], userId })

  globalThis.__pascalCollabBus = {
    clientId,
    getParticipants: () => participants.map((p) => ({ ...p })),
    onParticipants: (handler) => {
      participantHandlers.add(handler)
      return () => participantHandlers.delete(handler)
    },
    projectId,
    publish,
    sessionId,
    subscribe: (pluginId, handler) => {
      let handlers = subscribers.get(pluginId)
      if (!handlers) {
        handlers = new Set()
        subscribers.set(pluginId, handlers)
      }
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    userId,
    version: 1,
  }
  globalThis.__busStats = () => ({ ...stats })
}

const browser = await chromium.launchPersistentContext(PROFILE, {
  // TWO TABS, TWO LIVE GAMES. Chromium throttles a tab it thinks nobody is
  // looking at — rAF stops, timers are clamped — and only one of two pages is
  // ever focused. Without these the second session's loop nearly halts and
  // every "the peer never sent anything" reading is the harness, not the code.
  args: [
    '--disable-features=WebGPU',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,900',
  ],
  headless: !process.env.HEADED,
  viewport: { height: 900, width: 1280 },
})

const clients = []
for (const [index, who] of [
  ['A', { name: 'Owner', sessionId: 'session_A', clientId: 'client_A', userId: 'user_A' }],
  ['B', { name: 'Visitor', sessionId: 'session_B', clientId: 'client_B', userId: 'user_B' }],
].entries()) {
  const [label, identity] = who
  const page = index === 0 ? (browser.pages()[0] ?? await browser.newPage()) : await browser.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.addInitScript(installBus, { projectId: `project_${SCENE}`, ...identity })
  clients.push({ errors, identity, label, page })
}

// ── enter the game on both ───────────────────────────────────────────────────
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

const phase = (client) =>
  client.page.evaluate(() => globalThis.__boots?.state?.()?.phase ?? null)
const presence = (client) => client.page.evaluate(() => globalThis.__boots?.presence?.() ?? null)
const pieces = (client) => client.page.evaluate(() => globalThis.__boots?.pieces?.() ?? [])
const targets = (client) => client.page.evaluate(() => globalThis.__boots?.targets?.() ?? [])
const worldSync = (client) => client.page.evaluate(() => globalThis.__boots?.worldSync?.() ?? null)
const busStats = (client) => client.page.evaluate(() => globalThis.__busStats?.() ?? null)

for (const client of clients) log(`[${client.label}] phase ${await phase(client)}`)

// ── 1. CO-PRESENCE: does each session see the other one at all? ─────────────
// Sampled over time, alternating which tab is in front. A pose is a LIVE thing
// with an age — one reading proves nothing, and if both peers only ever publish
// while focused, the counters say so here instead of looking like a dead wire.
log('\n=== 1. co-presence (10 samples, front tab alternating) ===')
for (let round = 0; round < 10; round++) {
  const front = clients[round % 2]
  await front.page.bringToFront()
  await front.page.waitForTimeout(1200)
  const line = []
  for (const client of clients) {
    const p = await presence(client)
    line.push(
      `${client.label}: remotes ${p?.remotes?.length ?? 0} pub ${p?.published ?? 0} rec ${p?.received ?? 0}`,
    )
  }
  log(`  front=${front.label}  ${line.join('   |   ')}`)
}

// ── 2. BUILDS, BOTH WAYS ────────────────────────────────────────────────────
// Both directions on purpose: a one-way wire is indistinguishable from a working
// one when only the same peer ever drives, and presence above is exactly where
// an asymmetry would hide.
const [a, b] = clients
/**
 * WHAT MAKES TWO PEERS' COPIES OF ONE WALL THE SAME WALL.
 *
 * NOT the piece's `id`: that is a per-session runtime counter (shared-build.ts
 * binds a locally minted runtime id to the shared record id), so A's first wall
 * is `1` on A and whatever B happens to be up to on B. Comparing ids would fail
 * a working wire. `slotId` is `${kind}:${i},${k},${s}` straight off the grid —
 * a pure function of where the piece sits, so it is the same string on every
 * peer that holds the piece. Position is the fallback for anything placed off
 * the slot grid.
 */
const keyOf = (p) =>
  p.slotId ?? `${p.piece}@${p.position.map((v) => Math.round(v * 100) / 100).join(',')}`
const keysOf = (list) => new Set(list.map(keyOf))
/**
 * Place one piece through the game's own path: builder, aim, hold the trigger.
 *
 * `turnPx` exists because both sessions spawn at the same point facing the same
 * way, so the second builder would aim at the slot the first one already filled
 * and the placement would be refused as `occupied` — a false "nothing synced".
 * Under pointer lock the look accumulates movementX, so a mouse sweep is a yaw.
 */
const placeOne = async (client, turnPx = 0) => {
  await client.page.bringToFront()
  await client.page.keyboard.press('Digit4')
  await client.page.waitForTimeout(400)
  if (turnPx) {
    for (let i = 0; i < 10; i++) {
      await client.page.mouse.move(640 + (turnPx * (i + 1)) / 10, 470)
      await client.page.waitForTimeout(30)
    }
    await client.page.waitForTimeout(500)
  } else {
    await client.page.mouse.move(640, 470)
  }
  await client.page.mouse.down()
  await client.page.waitForTimeout(220)
  await client.page.mouse.up()
  await client.page.waitForTimeout(600)
}
const buildProbe = async (builder, watcher, turnPx = 0) => {
  log(`\n=== 2${builder.label === 'A' ? 'a' : 'b'}. ${builder.label} builds → ${watcher.label} sees ===`)
  const beforeBuilder = await pieces(builder)
  const beforeWatcher = await pieces(watcher)
  await placeOne(builder, turnPx)
  await builder.page.waitForTimeout(3000)
  const afterBuilder = await pieces(builder)
  const afterWatcher = await pieces(watcher)
  const had = keysOf(beforeBuilder)
  const watcherHad = keysOf(beforeWatcher)
  const minted = [...keysOf(afterBuilder)].filter((key) => !had.has(key))
  const watcherNow = keysOf(afterWatcher)
  const landed = minted.filter((key) => watcherNow.has(key) && !watcherHad.has(key))
  log(`[${builder.label}] placed ${beforeBuilder.length} → ${afterBuilder.length}   minted ${JSON.stringify(minted)}`)
  log(`[${watcher.label}] placed ${beforeWatcher.length} → ${afterWatcher.length}   received ${JSON.stringify(landed)}`)
  const piece = afterBuilder.find((p) => minted.includes(keyOf(p)))
  if (piece) log(`  the piece: ${piece.piece} at ${JSON.stringify(piece.position.map((v) => Math.round(v * 100) / 100))} slot ${piece.slotId}`)
  // The SLOT must match, not just the count: two peers each placing their own
  // wall somewhere else would pass a count check while sharing nothing.
  const ok = minted.length > 0 && landed.length === minted.length
  log(`  BUILD SYNCED ${builder.label}→${watcher.label}: ${ok}`)
  return ok
}
const buildAtoB = await buildProbe(a, b)
const buildBtoA = await buildProbe(b, a, 900)

// ── 3. DESTRUCTION, BOTH WAYS ───────────────────────────────────────────────
// Level a wall through the game's own damage path — levelTarget drives the same
// damageSegment/collapseWholeTarget the gunfire lane does, and scripted gunfire
// is too flaky at headless frame rates to be a reliable assertion.
const censusFor = async (client, nodeId) => {
  const all = await targets(client)
  return all.find((t) => t.nodeId === nodeId) ?? null
}
const alive = (t) => (t ? `${t.aliveCount}/${t.totalCount}` : 'absent')
const damageProbe = async (shooter, watcher, wallIndex) => {
  log(`\n=== 3${shooter.label === 'A' ? 'a' : 'b'}. ${shooter.label} destroys → ${watcher.label} sees ===`)
  const wall = await shooter.page.evaluate(
    (index) => (globalThis.__boots?.wallNodes?.() ?? [])[index]?.id ?? null,
    wallIndex,
  )
  log(`  target wall: ${wall}`)
  if (!wall) return false
  const beforeWatcher = await censusFor(watcher, wall)
  const levelled = await shooter.page.evaluate(
    (nodeId) => globalThis.__boots?.levelTarget?.(nodeId) ?? false,
    wall,
  )
  await shooter.page.waitForTimeout(4000)
  const afterShooter = await censusFor(shooter, wall)
  const afterWatcher = await censusFor(watcher, wall)
  log(`[${shooter.label}] levelled ${levelled} → ${alive(afterShooter)}`)
  log(`[${watcher.label}] ${alive(beforeWatcher)} → ${alive(afterWatcher)}`)
  // The watcher must hold the SAME grid, not merely some damage: a target that
  // is absent on the watcher means the node was never even replicated.
  const ok =
    afterWatcher !== null &&
    afterShooter !== null &&
    afterWatcher.aliveCount === afterShooter.aliveCount &&
    afterWatcher.totalCount === afterShooter.totalCount
  log(`  DESTRUCTION SYNCED ${shooter.label}→${watcher.label}: ${ok}  (grids equal)`)
  return ok
}
const damageBtoA = await damageProbe(b, a, 0)
const damageAtoB = await damageProbe(a, b, 1)

// ── 4. what the wire actually did ───────────────────────────────────────────
log('\n=== 4. the wire ===')
for (const client of clients) {
  log(`[${client.label}] busStats ${JSON.stringify(await busStats(client))}`)
  log(`[${client.label}] worldSync ${JSON.stringify(await worldSync(client))}`)
}

for (const client of clients) {
  await client.page.screenshot({ path: `${SHOT}-${client.label}.png` }).catch(() => {})
  log(`[${client.label}] page errors: ${client.errors.length}`)
  for (const e of client.errors.slice(0, 5)) log(`   ${e}`)
}

await browser.close()
