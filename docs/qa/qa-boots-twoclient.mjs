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
 * net.ts is feature-detected, so Boots there is deliberately solo. The missing
 * half comes from qa-collab-bus.mjs — a lossy, host-faithful `__pascalCollabBus`
 * shared with the other harnesses here.
 *
 * Then it plays: A builds, B must see it; B blows a wall apart, A must see the
 * same voxels die. Both directions, because a one-way wire looks identical to a
 * working one from whichever end happens to be driving.
 *
 * Five more sections were added after the owner played it with a friend
 * (2026-09-01), each pinned to one of his sentences:
 *   5. the GRID STAMP counters — the failure that was invisible in development
 *      and total in production ("others couldn't see my constructions / only
 *      some destructions");
 *   6. one peer's GUNFIRE reaching the other ("last time I could not hear or see
 *      other players shoot");
 *   7. one peer's SPRAY landing on the other's copy of the same wall ("i hope
 *      every player sees the same sprays and builds") — and again on a peer who
 *      arrives after the can was put down;
 *   8. B builds, B LEAVES, and a peer who was never in the room while B was
 *      there still gets B's wall ("we should always all see the state of the map
 *      as it is currently");
 *   9. a remote avatar photographed at 6 m and 20 m, either side of the detail
 *      LOD ("our avatars should look like pascalines").
 *
 *   SCENE=… node qa-boots-twoclient.mjs
 */
import { chromium } from './qa-playwright.mjs'
import { installBus } from './qa-collab-bus.mjs'

const SCENE = process.env.SCENE ?? '65fbacdc1faf'
const URL = `http://localhost:3002/scene/${SCENE}?boots=drop`
const PROFILE = '/tmp/boots-twoclient-profile'
const SHOT = process.env.SHOT ?? '/tmp/boots-two'
const log = (...a) => console.log(...a)

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
const buildSync = (client) => client.page.evaluate(() => globalThis.__boots?.buildSync?.() ?? null)
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
  log(`[${client.label}] buildSync ${JSON.stringify(await buildSync(client))}`)
}

/**
 * THE GRID STAMP, ASSERTED — the counter that would have caught a whole month.
 *
 * `publishGridStamp` used to no-op when the build lane was not attached yet, and
 * React runs a child's effect before its parent's, so the publish ALWAYS lost
 * the race with `startWorldSync()`. StrictMode's double-invoke hid it in
 * development; in a production build `world.gridStamp` stayed 0 all session, and
 * the gate reads `delta.gridStamp !== 0 && delta.gridStamp === world.gridStamp`
 * — so every slot-addressed frame was refused in BOTH directions while grid-free
 * damage kept landing. Sections 2 and 3 above cannot separate those two lanes;
 * these three numbers can, and they are cheap:
 *   gridStampPublishes > 0   the frame reached a world at all
 *   gridFrameHeld === true   it is retained, so a late attach still speaks it
 *   blindGrid === 0          no frame was ever refused while OUR stamp was 0
 */
log('\n=== 5. the grid stamp (the production-only failure) ===')
let stampOk = true
for (const client of clients) {
  const bs = await buildSync(client)
  const ws = await worldSync(client)
  const ok =
    (bs?.gridStampPublishes ?? 0) > 0 &&
    bs?.gridFrameHeld === true &&
    (bs?.gridStamp ?? 0) !== 0 &&
    (ws?.blindGrid ?? 0) === 0
  log(
    `[${client.label}] publishes ${bs?.gridStampPublishes} held ${bs?.gridFrameHeld} ` +
      `stamp ${bs?.gridStamp} · blindGrid ${ws?.blindGrid} refusedGrid ${ws?.refusedGrid} → ${ok}`,
  )
  if (!ok) stampOk = false
}
log(`  GRID STAMP HEALTHY: ${stampOk}`)

/**
 * GUNFIRE, SEEN AND HEARD — "last time I could not hear or see other players
 * shoot. I shoot. I see my gun and I could hear it. I want the others to shoot
 * the same." (owner, 2026-09-01)
 *
 * A muzzle flash lasts 50 ms and a report cannot be read out of a headless
 * browser, so what is asserted is the thing both of them hang off: the fire
 * counter on the pose. If B's copy of A's pose shows the counter ADVANCING
 * while A holds the trigger, then B's frame loop is being handed the shots, and
 * flash/tracer/report are downstream of that one number.
 *
 * The weapon id is checked in the same breath, because the flash is parented to
 * the muzzle of the gun B thinks A is holding — a counter that arrives while B
 * still shows a builder would flash nothing.
 */
log('\n=== 6. gunfire crosses the wire ===')
const seenBy = async (watcher, sessionId) => {
  const p = await presence(watcher)
  return (p?.remotes ?? []).find((r) => r.sessionId === sessionId) ?? null
}
const gunfireProbe = async (shooter, watcher, weapon, slot) => {
  log(`\n--- ${shooter.label} fires a ${weapon} → ${watcher.label} sees the counter move`)
  const before = await seenBy(watcher, shooter.identity.sessionId)
  await shooter.page.bringToFront()
  // The depot is where guns come from; a scripted session skips the errand.
  await shooter.page.evaluate((w) => globalThis.__boots?.state?.()?.giveWeapon?.(w), weapon)
  await shooter.page.keyboard.press(slot)
  await shooter.page.waitForTimeout(900)
  const held = await shooter.page.evaluate(() => globalThis.__boots?.state?.()?.weapon ?? null)
  await shooter.page.mouse.move(640, 470)
  await shooter.page.mouse.down()
  await shooter.page.waitForTimeout(2500) // headless runs ~3 fps: give it frames
  await shooter.page.mouse.up()
  const fired = await shooter.page.evaluate(
    () => globalThis.__bootsPlayer?.sample?.()?.shots ?? null,
  )
  // THE READ HAS TO BE POLLED, AND ON THE WATCHER'S OWN TAB. A headless session
  // spends 1–3 s inside a single frame while voxels die, and presenceTick is a
  // timer that queues behind those long tasks — so the shooter can go silent for
  // longer than STALE_MS (3 s) and the watcher REAPS the avatar mid-probe. That
  // is what a fixed sleep read as "the counter never arrived" (2026-09-01: `f 0
  // → -`, weapon undefined, while a third client saw the same shooter's f=2).
  //
  // Polling is not a workaround for a real race: the count is a FIELD ON THE
  // POSE, so the very next frame the shooter publishes still carries it, whole,
  // however late it is. An event lane would have been genuinely lost here.
  await watcher.page.bringToFront()
  let after = null
  for (let round = 0; round < 16; round++) {
    await watcher.page.waitForTimeout(700)
    const seen = await seenBy(watcher, shooter.identity.sessionId)
    if (seen) after = seen
    if (seen && seen.w === weapon && (!before || seen.f !== before.f)) break
  }
  // A re-admitted avatar starts a fresh ring, so its first count IS the delta.
  const delta =
    before && after ? (after.f - before.f + 256) % 256 : after ? after.f : 0
  log(`[${shooter.label}] holds ${held}   local rounds fired: ${fired}`)
  log(`[${watcher.label}] sees f ${before?.f ?? '-'} → ${after?.f ?? '-'} (Δ${delta}), weapon ${after?.w}, age ${after?.ageMs} ms`)
  const ok = held === weapon && delta > 0 && after?.w === weapon
  log(`  GUNFIRE SYNCED ${shooter.label}→${watcher.label}: ${ok}`)
  return ok
}
const fireAtoB = await gunfireProbe(a, b, 'rifle', 'Digit3')
const fireBtoA = await gunfireProbe(b, a, 'pistol', 'Digit2')

/**
 * THE SPRAY IS THE SAME COAT ON BOTH SCREENS — "spray looks good, i hope every
 * player sees the same sprays and builds" (owner, 2026-09-01).
 *
 * Paint is the one lane with no grid stamp in it: strokes are grid-free records
 * folded in canonical (lamport, id) order, so they cannot be refused the way
 * slot-addressed pieces were. That is an argument, not evidence — this is the
 * evidence. A sprays, and the SAME node's paint census has to grow on B.
 *
 * The candidate sweep exists because paint only lands on paintable surfaces and
 * a headless session cannot be trusted to be facing one: each pose is tried and
 * the first one that actually deposits is the one used (the qa-paint-flash
 * recipe — three earlier attempts there read all-zeros and looked like a bug).
 */
log('\n=== 7. sprays are the same coat on both screens ===')
/**
 * THE ORACLE IS THE LEDGER, NOT THE RENDERER.
 *
 * Three earlier cuts of this section read all-zeros and looked like a broken
 * paint lane. Both mistakes were in the harness:
 *
 * 1. It pre-resolved a target with `identifyAim`, which walks the THREE.JS
 *    scene and reports `userData.nodeId`. sprayPaint resolves against
 *    `world.colliders` (and the voxel skins) instead, so the probe kept
 *    returning surfaces with `nodeId: null` — real geometry the spray would
 *    happily coat, which the harness then skipped for lack of a name.
 * 2. `census(node)` counts STAMPS in whatever representation the client chose:
 *    a pristine wall wears clipped decals, a shot-up one wears voxel sprites.
 *    Two clients holding the identical coat can therefore report different
 *    censuses — and a peer that never fired reports zero sprites.
 *
 * Cells are what actually travels on the wire, so `paintDebug.coated()` is the
 * oracle: spray first, then ask BOTH clients which node holds how many cells.
 * A's spray must appear on B under the SAME nodeId, and on B those cells must
 * be marked `remote` — which is the difference between "B sees my spray" and
 * "B has some paint of its own somewhere".
 */
const coatedNodes = (client) =>
  client.page.evaluate(() => globalThis.__bootsPaint?.coated?.() ?? [])
const cellsOn = (list, nodeId) => list.find((n) => n.nodeId === nodeId)?.cells ?? 0
const sprayBurst = async (client, ms) => {
  await client.page.evaluate(() => {
    globalThis.__bootsPaint.holdFire = true
  })
  await client.page.waitForTimeout(ms)
  await client.page.evaluate(() => {
    globalThis.__bootsPaint.holdFire = false
  })
  await client.page.waitForTimeout(1800) // the fold + the wire
}
await a.page.bringToFront()
await a.page.keyboard.press('Digit7') // the sprayer — always reachable, never owned
await a.page.waitForTimeout(900)
/**
 * WHERE TO STAND AND WHICH WAY TO LOOK — in WORLD space, and with a frame in
 * between. Two more harness bugs lived here:
 *
 * 1. `wallNodes()` returns the SCENE nodes, whose start/end are the building's
 *    own 2-D coordinates. The game places that building under a site transform
 *    — the whole reason a grid anchor exists — so teleporting to a wall's
 *    midpoint lands nowhere near the wall. `placed` pieces, by contrast, carry
 *    a WORLD position and a slot id whose prefix names the run: `Wx:…` is a
 *    wall along x, so its faces look ±z.
 * 2. `teleport` writes playerRig.yaw and the feet synchronously, but
 *    `playerRig.position` — the origin the spray rays from — is recomputed in
 *    the frame loop. A sweep inside ONE page.evaluate therefore rays every step
 *    from the position the rig had BEFORE the first teleport. Every step must be
 *    its own await with a real frame in it.
 *
 * Forward is (-sin yaw, ·, -cos yaw), so looking along a unit vector (fx, fz)
 * means yaw = atan2(-fx, -fz).
 */
const yawToward = (fx, fz) => Math.atan2(-fx, -fz)
const sprayPoses = await a.page.evaluate(() => {
  const out = []
  const STANDOFF = 2.2
  for (const piece of globalThis.__boots?.pieces?.() ?? []) {
    const [px, , pz] = piece.position ?? []
    if (typeof px !== 'number' || typeof pz !== 'number') continue
    // Wx runs along x (faces ±z); anything else is treated as running along z.
    const alongX = String(piece.slotId ?? '').startsWith('Wx')
    for (const side of [1, -1]) {
      const nx = alongX ? 0 : side
      const nz = alongX ? side : 0
      out.push({ nx, nz, pitch: 0, x: px + nx * STANDOFF, z: pz + nz * STANDOFF })
    }
  }
  return out
})
// The yaw is computed OUT here: page.evaluate ships a function, not a closure,
// so a helper defined in this file does not exist inside the page.
for (const pose of sprayPoses) pose.yaw = yawToward(-pose.nx, -pose.nz)
// FALLBACK POSES: stand where the player already is and TURN — 8 yaws at eye
// level, then 8 tilted down. A lot whose pieces were all levelled in section 3
// leaves nothing to stand off, and the original building is still all around.
const here = await a.page.evaluate(() => {
  const s = globalThis.__bootsPlayer?.sample?.()
  return { x: s?.x ?? 0, z: s?.z ?? 0 }
})
for (let step = 0; step < 16; step++) {
  sprayPoses.push({
    pitch: step < 8 ? 0 : -0.7,
    x: here.x,
    yaw: ((step % 8) / 8) * Math.PI * 2,
    z: here.z,
  })
}
let sprayNode = null
let spraySynced = false
let sprayRemote = 0
for (const pose of sprayPoses) {
  await a.page.evaluate((p) => globalThis.__boots?.teleport?.(p.x, p.z, p.yaw, p.pitch ?? 0), pose)
  await a.page.waitForTimeout(700) // one real frame at headless rates
  const before = await coatedNodes(a)
  const bBefore = await coatedNodes(b)
  await sprayBurst(a, 1500)
  const after = await coatedNodes(a)
  const grew = after.find((n) => n.cells > cellsOn(before, n.nodeId))
  log(
    `  from ${pose.x.toFixed(1)},${pose.z.toFixed(1)} yaw ${pose.yaw.toFixed(2)} pitch ${pose.pitch}: ` +
      (grew ? `coated ${grew.nodeId} ${cellsOn(before, grew.nodeId)}→${grew.cells}` : 'nothing'),
  )
  if (!grew) continue
  sprayNode = grew.nodeId
  /**
   * B MAY NOT CALL THE WALL WHAT A CALLS IT — and that is the fix, not a bug.
   *
   * A host wall is named by the document, so both clients key the coat under
   * the same id. A PLAYER-BUILT wall is named by a per-client counter, so the
   * stroke crosses under its shared record id and B re-resolves it to B's own
   * number (shared-damage's wireNodeId / localNodeId, now used by both lanes).
   * Comparing the two ledgers by node id therefore proves nothing; what proves
   * it is that B gained cells it did not put there, in the window where the only
   * thing spraying was A.
   */
  const theirs = (await coatedNodes(b)).find(
    (n) => n.cells > cellsOn(bBefore, n.nodeId) && n.remote > 0,
  )
  sprayRemote = theirs?.remote ?? 0
  log(
    `  A ${grew.nodeId}: ${grew.cells} cells (remote ${grew.remote})   ` +
      `B ${theirs?.nodeId ?? '—'}: ${theirs?.cells ?? 0} cells (${sprayRemote} of them somebody else's)`,
  )
  spraySynced = (theirs?.cells ?? 0) > 0 && sprayRemote > 0
  break
}
// The four silent failures, from both ends (paintDebug.wire): A's `unnamed` is
// a stroke with no room-wide name, B's `foldUnnamed` is a name B could not
// resolve, `foldNoTarget` is a name it resolved onto nothing paintable.
for (const client of [a, b]) {
  log(`[${client.label}] paintWire ${JSON.stringify(await client.page.evaluate(() => globalThis.__bootsPaint?.wire?.() ?? null))}`)
}
log(`  SPRAY SYNCED A→B: ${spraySynced}  (node ${sprayNode}, ${sprayRemote} cells marked remote on B)`)

/**
 * THE FORT OUTLIVES ITS BUILDER — the relay gate, end to end.
 *
 * Under a per-frame authorship gate a record's only courier is its author, so
 * when a builder leaves the room their walls stop being re-published and the
 * next visitor finds a lot that has forgotten what was built on it (the owner's
 * "we should always all see the state of the map as it is currently"). The gate
 * is now split: deltas stay strictly authored, snapshots are accepted whoever
 * wrote the records inside them. The only honest test is the sequence itself —
 * B builds, B LEAVES, and a peer who was never in the room while B was there
 * must still be handed B's wall, by A.
 */
log('\n=== 8. a fort outlives its builder (relay) ===')
const bKeys = keysOf(await pieces(b))
const aKeysBefore = keysOf(await pieces(a))
// Only the pieces A holds that B authored can prove a relay: anything A built
// itself would arrive from its own author and prove nothing.
log(`  A holds ${aKeysBefore.size} pieces, B holds ${bKeys.size}`)
await b.page.close()
log('  B has left the room')
await a.page.bringToFront()
await a.page.waitForTimeout(4000)

const cPage = await browser.newPage()
const cErrors = []
cPage.on('pageerror', (e) => cErrors.push(String(e).slice(0, 200)))
await cPage.addInitScript(installBus, {
  clientId: 'client_C',
  name: 'Latecomer',
  projectId: `project_${SCENE}`,
  sessionId: 'session_C',
  userId: 'user_C',
})
const c = { errors: cErrors, label: 'C', page: cPage }
await cPage.goto(URL, { timeout: 240000, waitUntil: 'domcontentloaded' }).catch((e) => log('C goto:', e.message))
await cPage.waitForTimeout(15000)
await jumpIn(c)
// The joiner asks for state and merges what comes back; a snapshot may take a
// few ticks to drain, so poll rather than sleeping on a guess.
let cKeys = new Set()
for (let round = 0; round < 12; round++) {
  await cPage.waitForTimeout(2500)
  await cPage.bringToFront()
  cKeys = keysOf(await pieces(c))
  if (cKeys.size >= aKeysBefore.size) break
}
const cSync = await worldSync(c)
const cSettle = await c.page.evaluate(() => globalThis.__boots?.settle?.() ?? null)
const relayedIn = [...aKeysBefore].filter((key) => cKeys.has(key))
log(`[C] phase ${await phase(c)} pieces ${cKeys.size}   of A's ${aKeysBefore.size}: ${relayedIn.length}`)
log(`[C] worldSync ${JSON.stringify(cSync)}`)
log(`[C] settle ${JSON.stringify(cSettle)}`)
const relayOk = cKeys.size >= aKeysBefore.size && (cSync?.relayed ?? 0) > 0
log(`  LATECOMER GOT THE WHOLE MAP: ${relayOk}  (relayed ${cSync?.relayed})`)

/**
 * WHEN THE LATECOMER GETS NOTHING, SAY WHY IN THE SAME RUN.
 *
 * A refused snapshot and an unsent one look identical from the pieces list, and
 * the difference is two counters plus one hash. `refusedGrid > 0` with
 * `blindGrid 0` is the gate saying "we genuinely disagree about this lot" — and
 * a hash only ever says THAT two peers differ, never WHICH input does, so the
 * preimage of both stamps is printed side by side. This is the diagnostic that
 * found the wall-root yaw residue on 2026-09-01; a stamp mismatch is a
 * recurring failure mode and it should never again cost a run to see it.
 */
if (!relayOk) {
  for (const client of [a, c]) {
    const bs = await buildSync(client)
    log(`[${client.label}] stamp ${bs?.gridStamp} frame ${JSON.stringify(bs?.gridFrame)}`)
    // `wallNodes()` is the set that was COLLECTED (frozen when this session
    // entered the game and derived its anchor); gridAudit's wallCount is the
    // LIVE registry now. Different numbers mean the world was collected while
    // the scene was still filling — which changes which wall is longest, and
    // the anchor IS the longest wall's start.
    const collected = await client.page.evaluate(
      () => (globalThis.__boots?.wallNodes?.() ?? []).length,
    )
    log(`[${client.label}] walls collected ${collected}`)
    log(`[${client.label}] gridAudit ${JSON.stringify(await client.page.evaluate(() => globalThis.__boots?.gridAudit?.() ?? null))}`)
  }
}

// The coat, too: a stroke is a record like a piece, so a peer who was not in the
// room when the can was held must still be handed the paint. (C has to hold the
// sprayer for its census handle to exist — it publishes with the tool.)
let coatRelayed = null
if (sprayNode) {
  await cPage.bringToFront()
  await cPage.keyboard.press('Digit7')
  await cPage.waitForTimeout(1500)
  // Cells, not stamps, and never by node id: C never fired, so its copy of the
  // wall is pristine and wears decals where A's wears voxel sprites — and if the
  // wall was player-built, C's number for it is its own (see section 7).
  const cCoat = (await coatedNodes(c)).find((n) => n.cells > 0 && n.remote > 0)
  const aCoat = (await coatedNodes(a)).find((n) => n.nodeId === sprayNode)
  coatRelayed = Boolean(cCoat)
  log(
    `  LATECOMER GOT THE COAT: ${coatRelayed}  (C ${cCoat?.nodeId ?? '—'}: ${cCoat?.cells ?? 0} cells / ` +
      `${cCoat?.remote ?? 0} remote vs A ${sprayNode}: ${aCoat?.cells ?? 0})`,
  )
  log(`[C] paintWire ${JSON.stringify(await cPage.evaluate(() => globalThis.__bootsPaint?.wire?.() ?? null))}`)
  // WHY a waiting stroke can still not land: it needs the piece's NAME (the
  // record→runtime map) and a voxel GRID for that name. Print both sides so a
  // `foldNoTarget` reads as either "no such piece here" or "piece here, not
  // voxelized yet" without guessing.
  log(
    `[C] pieces ${JSON.stringify(
      await cPage.evaluate(() => (globalThis.__boots?.pieces?.() ?? []).map((p) => p.id)),
    )} pieceTargets ${JSON.stringify(
      await cPage.evaluate(() =>
        (globalThis.__boots?.targets?.() ?? [])
          .map((t) => t.nodeId)
          .filter((id) => id.startsWith('__boots-piece-')),
      ),
    )} strokeAudit ${JSON.stringify((await buildSync(c))?.strokes)} paintMounts ${await cPage.evaluate(
      () => globalThis.__bootsPaint?.mounts?.() ?? null,
    )}`,
  )
}

/**
 * THE AVATARS — "our avatars should look like pascalines, only slightly
 * customized (each new player has a different color?)".
 *
 * Unit tests pin the palette (assignPalette: stable, distinct, agreed on every
 * screen without coordination) and the articulation, but only pixels can answer
 * whether the thing standing over there READS as the mascot. So C stands off in
 * front of A's avatar and looks at it, at two distances that straddle
 * DETAIL_MAX_DIST (14 m) — the near shot is the full rig, the far one is the
 * simplified one plus the name tag, and the LOD crossing is exactly where a
 * remote avatar has blinked out before. The shots are for a human to read; what
 * is asserted here is only that there WAS someone to photograph.
 */
log('\n=== 9. the avatar in frame ===')
const aPose = (await presence(c))?.remotes?.[0] ?? null
log(`[C] sees remote ${JSON.stringify(aPose)}`)
if (aPose) {
  const [ax, , az] = aPose.p
  for (const dist of [6, 20]) {
    // Stand due +Z of them and look back along −Z: yaw 0 is (−sin 0, −cos 0).
    await cPage.evaluate(
      ([x, z]) => globalThis.__bootsPlayer?.teleport?.(x, z, 0, -0.05),
      [ax, az + dist],
    )
    await cPage.waitForTimeout(2500)
    await cPage.screenshot({ path: `${SHOT}-avatar-${dist}m.png` }).catch(() => {})
    const still = (await presence(c))?.remotes?.[0] ?? null
    log(`  ${dist} m: remote age ${still?.ageMs} ms  → ${SHOT}-avatar-${dist}m.png`)
  }
}

// ── 10. the body on the wire: C sees A as Pascaline, where A stands, holding what A holds ──
// Everything above proves the MAP is shared. This proves the PEOPLE are: the
// remote body is the mascot model (not the box fallback), planted on A's feet
// (the wire carries A's eye; remote-players plants EYE − EYE_HEIGHT), and the
// weapon in its hand follows A's weapon changes.
log('\n=== 10. the body on the wire ===')
const remoteBody = (page) =>
  page.evaluate(() => {
    const world = globalThis.__boots?.world
    // Any remote root: the first group named boots-remote-*.
    let root = null
    const scene = (() => {
      let o = (world?.colliders ?? [])[0]?.mesh ?? null
      while (o?.parent) o = o.parent
      return o
    })()
    scene?.traverse((o) => {
      if (!root && typeof o.name === 'string' && o.name.startsWith('boots-remote-')) root = o
    })
    if (!root) return null
    root.updateWorldMatrix(true, false)
    const e = root.matrixWorld.elements
    const hand = root.getObjectByName('hand-frame-R')
    let weaponMeshes = 0
    hand?.traverse((o) => {
      if (o.isMesh) weaponMeshes++
    })
    return {
      at: [e[12], e[13], e[14]],
      body: root.getObjectByName('pivot-legL') ? 'model' : 'primitive',
      elbowR: root.getObjectByName('pivot-elbowR')?.rotation?.x ?? null,
      weaponMeshes,
    }
  })
const aFeet = await a.page.evaluate(() => {
  const s = globalThis.__bootsPlayer?.sample?.()
  return s ? [s.x, s.y, s.z] : null
})
// A pose frame is published from A's render loop, and a background tab's loop
// is throttled to nothing — so A must be the front tab while it changes hands,
// then C while it looks (the co-presence section alternates for the same reason).
// Sampled over time, not once: the frame has to be published (A's timers),
// carried (the bus), ingested (C's ring) and rendered (C's React) — and a
// single reading cannot tell a slow wire from a dead one.
const holdAndLook = async (weapon) => {
  await a.page.bringToFront()
  const pubBefore = (await presence(a))?.published ?? 0
  await a.page.evaluate((w) => {
    const st = globalThis.__boots.state()
    st.giveWeapon?.(w)
    st.setWeapon(w)
  }, weapon)
  const timeline = []
  let seen = null
  for (let i = 0; i < 20; i++) {
    // A in front for the first half (its publisher ticks), C for the second (its scene updates).
    if (i === 8) await cPage.bringToFront()
    await (i < 8 ? a.page : cPage).waitForTimeout(250)
    const r = (await presence(c))?.remotes?.[0] ?? null
    const body = await remoteBody(cPage)
    timeline.push(`${(i + 1) * 250}ms:${r?.w ?? '?'}/${r?.ageMs ?? '?'}ms/${body?.weaponMeshes ?? '?'}m`)
    seen = body
    if (r?.w === weapon && body && body.weaponMeshes > 0 && i >= 8) break
  }
  const pubAfter = (await presence(a))?.published ?? 0
  log(`  A → ${weapon}: A published +${pubAfter - pubBefore}; C saw ${timeline.join(' ')}`)
  return { ...seen, wire: (await presence(c))?.remotes?.[0]?.w ?? null }
}
const seenKnife = await holdAndLook('knife')
const seenRifle = await holdAndLook('rifle')
log(`[C] sees A: ${JSON.stringify(seenKnife)} → with rifle ${JSON.stringify(seenRifle)}; A's feet ${JSON.stringify(aFeet?.map((v) => +v.toFixed(2)))}`)
const bodyIsModel = seenRifle?.body === 'model'
const planted =
  seenRifle && aFeet
    ? Math.hypot(seenRifle.at[0] - aFeet[0], seenRifle.at[1] - aFeet[1], seenRifle.at[2] - aFeet[2]) < 0.35
    : false
const weaponFollows =
  seenKnife !== null &&
  seenRifle !== null &&
  seenRifle.wire === 'rifle' &&
  seenRifle.weaponMeshes > seenKnife.weaponMeshes &&
  seenRifle.elbowR > 0.5
log(`  C SEES THE MASCOT BODY: ${bodyIsModel}  (${seenRifle?.body})`)
log(`  PLANTED ON A'S FEET: ${planted}`)
log(`  A'S WEAPON CHANGE REACHES C'S HANDS: ${weaponFollows}  (wire ${seenKnife?.wire} → ${seenRifle?.wire}; knife ${seenKnife?.weaponMeshes} meshes → rifle ${seenRifle?.weaponMeshes}, elbow ${seenRifle?.elbowR?.toFixed?.(2)})`)

for (const client of [...clients.filter((x) => x !== b), c]) {
  await client.page.screenshot({ path: `${SHOT}-${client.label}.png` }).catch(() => {})
  log(`[${client.label}] page errors: ${client.errors.length}`)
  for (const e of client.errors.slice(0, 5)) log(`   ${e}`)
}
log(`[B] page errors: ${b.errors.length}`)

log('\n=== verdict ===')
log(`  builds A→B ${buildAtoB}  B→A ${buildBtoA}`)
log(`  destruction B→A ${damageBtoA}  A→B ${damageAtoB}`)
log(`  gunfire A→B ${fireAtoB}  B→A ${fireBtoA}`)
log(`  spray A→B ${spraySynced}   relayed to a latecomer ${coatRelayed}`)
log(`  grid stamp healthy ${stampOk}   latecomer got the map ${relayOk}`)
log(`  body on the wire: model ${bodyIsModel}  planted ${planted}  weapon follows ${weaponFollows}`)

await browser.close()
