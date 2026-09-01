/**
 * THE HOST'S PLUGIN COLLAB BUS, AS A PAGE SHIM — shared by every two-client QA
 * harness in this directory.
 *
 * :3002 is the editor dev server, not the app, so it has no
 * `__pascalCollabBus`; net.ts is feature-detected and Boots there is
 * deliberately solo. This supplies the missing half: a v1 bus that bridges two
 * tabs over a BroadcastChannel.
 *
 * IT MIRRORS THE HOST, NOT AN IDEALISED WIRE. A transport that delivered
 * everything instantly would prove nothing about production, where the bus is
 * lossy by design. Reproduced from `plugin-collab-bus.ts` (the host module it
 * stands in for):
 *
 *   - latest-value coalescing per (pluginId, event), clamped to one send every
 *     66 ms — intermediate payloads for the same key are DROPPED, which is the
 *     single most important property for a delta stream to survive, and the
 *     exact condition non-trickle voice signalling exists to live through;
 *   - the 8 000-byte serialized frame budget, measured on the same probe shape,
 *     with an over-budget publish returning 'suppressed' rather than throwing;
 *   - HOST-STAMPED identity: the receiver's `sessionId`/`clientId`/`userId` come
 *     from the transport, never from the payload;
 *   - no echo to the sender's own session.
 *
 * `installBus` is passed to `page.addInitScript`, so it must stay
 * SELF-CONTAINED — Playwright ships its source, not its closure.
 */

export function installBus({ projectId, sessionId, clientId, userId, name }) {
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
