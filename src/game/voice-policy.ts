/**
 * VOICE — the pure half. Every decision that can be wrong without looking
 * wrong lives here, so it can be tested without a microphone, a peer, or a
 * browser: the wire validator, the SDP guards, who calls whom, how loud a peer
 * is, and when a mic counts as "talking".
 *
 * The impure half (getUserMedia, RTCPeerConnection, the WebAudio graph, the
 * per-frame panner update) is voice.ts, and it holds no policy of its own.
 *
 * ── WHY WEBRTC AND NOT THE BUS ──────────────────────────────────────────────
 * The collaboration bus is a JSON channel with an 8 000-byte frame cap and
 * latest-value coalescing per (pluginId, event): it is a fine wire for poses
 * and for a grow-only destruction lattice, and a hopeless one for a continuous
 * 32 kbit/s audio stream — coalescing would drop the middle of every sentence.
 * So the bus carries SIGNALLING ONLY (a few kilobytes, once per peer) and the
 * audio itself goes peer-to-peer over SRTP, where it belongs.
 *
 * ── THE COALESCING PROBLEM, AND WHY EVERY FRAME IS CUMULATIVE ───────────────
 * The host keeps only the LATEST payload per (pluginId, event) inside its
 * window. A classic trickle-ICE exchange — offer, then candidate, then
 * candidate — would therefore lose the offer to the candidate that followed it,
 * and negotiation would stall with nothing logged anywhere.
 *
 * Two consequences, both load-bearing:
 *
 *  1. NON-TRICKLE ICE. We wait for gathering to finish and send ONE
 *     description with its candidates already embedded. One frame per peer per
 *     epoch, so there is no sequence to lose.
 *  2. EVERY FRAME IS A COMPLETE, IDEMPOTENT STATEMENT of what we want that peer
 *     to know, and it is RE-SENT on a heartbeat until the peer acknowledges the
 *     epoch. A coalesced frame therefore costs one heartbeat of latency instead
 *     of a dead call. This is the same reasoning shared-world.ts uses for its
 *     lattice: on a lossy wire, make the message re-sendable rather than the
 *     transport reliable.
 *
 * ── WHAT A STRANGER MAY SAY TO US ───────────────────────────────────────────
 * In an open lobby the peer on the other end is an anonymous member of the
 * public, and an SDP is a description we hand to the browser's own negotiator.
 * The browser's parser is hardened; what it will happily do FOR an attacker is
 * the problem. So `readVoiceFrame` bounds every field and `sdpIsAudioOnly`
 * refuses any description that is not exactly one audio m-line: no video (a
 * peer must not be able to make our tab decode a video stream), no
 * `m=application` (no data channel — that is a file-transfer and NAT-probing
 * surface this feature has no use for), and a hard cap on candidate lines,
 * because each candidate is an address our machine will send packets to.
 *
 * We deliberately do NOT filter private address ranges out of candidates: two
 * people in one office are the case this feature exists for, and LAN
 * candidates are how that call stays on the LAN. The cap is the bound.
 */

/** Our frame kind on the Boots transport (net.ts). */
export const VOICE_KIND = 'boots/voice' as const

/** Wire protocol for the voice payload specifically. */
export const VOICE_PROTOCOL = 1

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * A full mesh costs every peer (n − 1) uplinks. At ~32 kbit/s of Opus that is
 * 160 kbit/s up at six people, which is fine on any connection that can load
 * the editor; twenty would not be. Past the cap we simply do not call the
 * extra peers — they still see and hear the game, they just are not in the
 * voice mesh, which is a far better failure than everyone's audio breaking up.
 */
export const MAX_VOICE_PEERS = 6

/**
 * The host's frame cap is 8 000 serialized characters and net.ts reserves 120
 * for the envelope. An SDP travels as a JSON string, so every CRLF costs four
 * characters, not two. This is the budget the description itself may use, with
 * room left for `to`, `ack` and the flags.
 */
export const MAX_SDP_CHARS = 6200

/** Candidate lines we will accept in one description (see the header). */
export const MAX_ICE_CANDIDATES = 24

/** Ack entries in one frame — one per peer we could possibly be talking to. */
export const MAX_ACK_ENTRIES = MAX_VOICE_PEERS + 2

/** Session ids are host-minted; this is a sanity bound, not a format. */
export const MAX_SESSION_ID_CHARS = 128

// ── ICE servers ──────────────────────────────────────────────────────────────

/**
 * Public STUN, from two operators. Enough to discover a reflexive candidate,
 * which is what makes two ordinary home connections reach each other; a
 * second operator so one outage does not take the whole path. Relays (TURN)
 * carry credentials and are never written here — they arrive validated through
 * `readIceServers` from the host global or the same-origin credentials route
 * (voice.ts), and the STUN path below is what every failure falls back to.
 */
export const DEFAULT_ICE_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.relay.metered.ca:80' },
]

/** Servers we will hand the browser at most — each is a place it sends packets. */
export const MAX_ICE_SERVERS = 8
/**
 * URLs kept per server. Cloudflare's generate-ice-servers answers with ONE
 * object carrying eight (stun 3478/53, turn udp 3478/53, turn tcp 3478/80,
 * turns 5349/443), so anything under 8 discards the real relay wholesale. A
 * longer list is truncated, never rejected: a server with too many addresses
 * is still a server.
 */
export const MAX_ICE_URLS_PER_SERVER = 10
export const MAX_ICE_CREDENTIAL_CHARS = 512

/** stun/turn URL shape, RFC 7064/7065: scheme:host[:port][?transport=udp|tcp]. */
const ICE_URL = /^(stun|stuns|turn|turns):[A-Za-z0-9.\-]+(:\d{1,5})?(\?transport=(udp|tcp))?$/

/**
 * Every URL is checked (one bad address condemns the entry — it did not come
 * from anyone who knows what an ICE URL is); the survivors are truncated to the
 * cap, in the provider's order.
 */
function readIceUrls(value: unknown): string[] | null {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : null
  if (!list || list.length === 0) return null
  const urls: string[] = []
  for (const url of list) {
    if (typeof url !== 'string' || !ICE_URL.test(url)) return null
    if (urls.length < MAX_ICE_URLS_PER_SERVER) urls.push(url)
  }
  return urls
}

const TURN_URL = /^turns?:/

/** A relay needs both halves, bounded — the browser refuses a turn: URL without them. */
function readIceCredentials(e: Record<string, unknown>): { username: string; credential: string } | null {
  if (
    typeof e.username === 'string' &&
    typeof e.credential === 'string' &&
    e.username.length <= MAX_ICE_CREDENTIAL_CHARS &&
    e.credential.length <= MAX_ICE_CREDENTIAL_CHARS
  ) {
    return { username: e.username, credential: e.credential }
  }
  return null
}

/**
 * TOTAL validator for an ICE server list from anywhere we did not write it:
 * a host global, a credentials route, a caller of `setVoiceIceServers`.
 *
 * Accepts a bare array (metered.ca's shape), `{ iceServers: [...] }`
 * (Cloudflare's generate-ice-servers) and `{ iceServers: {...} }` (Cloudflare's
 * single-object form). Per entry: `urls` as one string or an array (truncated
 * to MAX_ICE_URLS_PER_SERVER), every one a stun/turn URL; `username` /
 * `credential` copied only when BOTH are bounded strings. A turn:/turns: entry
 * WITHOUT that pair is dropped whole, not passed on credential-less: the
 * browser's RTCPeerConnection constructor throws InvalidAccessError on a relay
 * URL with no credentials, and one such entry would kill every link. Anything
 * else is dropped, never passed through. Returns null when nothing survives,
 * so the caller keeps its defaults.
 */
export function readIceServers(data: unknown): RTCIceServer[] | null {
  try {
    let list: unknown = data
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
      const inner = (data as { iceServers?: unknown }).iceServers
      list = Array.isArray(inner) ? inner : inner !== undefined ? [inner] : null
    }
    if (!Array.isArray(list)) return null
    const out: RTCIceServer[] = []
    for (const entry of list) {
      if (out.length >= MAX_ICE_SERVERS) break
      if (typeof entry !== 'object' || entry === null) continue
      const e = entry as Record<string, unknown>
      const urls = readIceUrls(e.urls)
      if (!urls) continue
      const credentials = readIceCredentials(e)
      if (!credentials && urls.some((url) => TURN_URL.test(url))) continue
      const server: RTCIceServer = { urls }
      if (credentials) {
        server.username = credentials.username
        server.credential = credentials.credential
      }
      out.push(server)
    }
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/** Base first, then whatever in `extra` names a URL set the base does not; capped. */
export function mergeIceServers(
  base: readonly RTCIceServer[],
  extra: readonly RTCIceServer[],
): RTCIceServer[] {
  const seen = new Set<string>()
  const out: RTCIceServer[] = []
  for (const server of [...base, ...extra]) {
    const key = JSON.stringify(server.urls)
    if (seen.has(key) || out.length >= MAX_ICE_SERVERS) continue
    seen.add(key)
    out.push(server)
  }
  return out
}

/** Does this set include a relay (TURN) at all? The overlay reads it. */
export function iceHasRelay(servers: readonly RTCIceServer[]): boolean {
  return servers.some((server) => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls
    return urls.some((url) => /^turns?:/.test(url))
  })
}

// ── The mic key ──────────────────────────────────────────────────────────────

/**
 * The mic toggle key, as an `e.code`. input.ts claims the same code in
 * GAME_KEYS; every label that names the key derives from here so a rebind is
 * one edit. `keyCap` is the caption: 'KeyM' → 'M'.
 */
export const MIC_KEY = 'KeyM'

export function keyCap(code: string): string {
  return code.replace(/^(Key|Digit)/, '').toUpperCase()
}

// ── The wire payload ─────────────────────────────────────────────────────────

export type VoiceMode = 'squad' | 'proximity'

const MODES: ReadonlySet<string> = new Set<VoiceMode>(['squad', 'proximity'])

export function isVoiceMode(value: unknown): value is VoiceMode {
  return typeof value === 'string' && MODES.has(value)
}

export type VoiceDescription = {
  type: 'offer' | 'answer'
  /**
   * Bumped by the OFFERER whenever it starts a fresh negotiation (first call,
   * ICE failure, a peer that came back). An answer carries the epoch of the
   * offer it answers, so a late answer to a superseded offer is detectable
   * rather than confusing.
   */
  epoch: number
  sdp: string
}

export type VoiceFrame = {
  v: typeof VOICE_PROTOCOL
  /** The peer `sdp` is addressed to. Absent on a hello/heartbeat frame. */
  to?: string
  sdp?: VoiceDescription
  /** Newest epoch we have successfully APPLIED, per peer session id. */
  ack?: Record<string, number>
  /** Is our mic open and over the talk gate right now (HUD only, lossy). */
  talking?: boolean
  /** How we are mixing the room — informational, each side mixes its own. */
  mode?: VoiceMode
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= min && v <= max

const isSessionId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_SESSION_ID_CHARS

/**
 * Is this description one audio stream and nothing else?
 *
 * Refuses: anything that is not an SDP at all, more than one media section, a
 * media section that is not audio, and more candidate lines than the cap. This
 * is the whole reason a hostile peer cannot use the voice handshake to open a
 * data channel or push video at us — see the header.
 */
export function sdpIsAudioOnly(sdp: unknown): sdp is string {
  if (typeof sdp !== 'string') return false
  if (sdp.length === 0 || sdp.length > MAX_SDP_CHARS) return false
  // An SDP always opens with the version line; anything else is not one.
  if (!/^v=0(\r\n|\n)/.test(sdp)) return false
  const lines = sdp.split(/\r\n|\n/)
  let media = 0
  let candidates = 0
  for (const line of lines) {
    if (line.startsWith('m=')) {
      media++
      if (!line.startsWith('m=audio ')) return false
    } else if (line.startsWith('a=candidate:')) {
      candidates++
    }
  }
  if (media !== 1) return false
  if (candidates > MAX_ICE_CANDIDATES) return false
  return true
}

function readDescription(data: unknown): VoiceDescription | null {
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>
  if (d.type !== 'offer' && d.type !== 'answer') return null
  if (!isInt(d.epoch, 1, Number.MAX_SAFE_INTEGER)) return null
  if (!sdpIsAudioOnly(d.sdp)) return null
  return { type: d.type, epoch: d.epoch, sdp: d.sdp }
}

function readAck(data: unknown): Record<string, number> | null {
  if (typeof data !== 'object' || data === null) return null
  const out: Record<string, number> = {}
  let kept = 0
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (kept >= MAX_ACK_ENTRIES) break // bounded: a flood of keys costs nothing
    if (!isSessionId(key)) continue
    if (!isInt(value, 1, Number.MAX_SAFE_INTEGER)) continue
    out[key] = value
    kept++
  }
  return out
}

/**
 * TOTAL validator for an inbound voice frame — returns a NORMALIZED copy or
 * null. Never throws, never returns a field it did not check, and never passes
 * a caller's object through: what comes out is ours.
 *
 * A frame that carries `sdp` without `to` is dropped rather than treated as a
 * broadcast. The bus has no addressing, so `to` is the ONLY thing that says a
 * description was meant for us; an unaddressed one would be applied by every
 * peer in the lobby at once.
 */
export function readVoiceFrame(data: unknown): VoiceFrame | null {
  try {
    if (typeof data !== 'object' || data === null) return null
    const f = data as Record<string, unknown>
    if (f.v !== VOICE_PROTOCOL) return null
    const out: VoiceFrame = { v: VOICE_PROTOCOL }
    if (f.to !== undefined) {
      if (!isSessionId(f.to)) return null
      out.to = f.to
    }
    if (f.sdp !== undefined) {
      const description = readDescription(f.sdp)
      if (!description) return null
      if (out.to === undefined) return null // a description must be addressed
      out.sdp = description
    }
    if (f.ack !== undefined) {
      const ack = readAck(f.ack)
      if (!ack) return null
      out.ack = ack
    }
    if (f.talking !== undefined) {
      if (typeof f.talking !== 'boolean') return null
      out.talking = f.talking
    }
    if (f.mode !== undefined) {
      if (!isVoiceMode(f.mode)) return null
      out.mode = f.mode
    }
    return out
  } catch {
    return null
  }
}

// ── Fitting a description on the wire ────────────────────────────────────────

const CANDIDATE_TYPE = /\btyp\s+(host|srflx|prflx|relay)\b/

/**
 * First per-type allowance the squeeze tries. Four known types × 6 = the line
 * cap; a line whose type the regex does not read lands in a fifth bucket
 * ('unknown'), so this first pass can still exceed MAX_ICE_CANDIDATES — the
 * count check in the loop, not this constant, is what guarantees the cap.
 */
const TRIM_START_PER_TYPE = 6

/**
 * Drop surplus ICE candidates until the description fits `maxChars`.
 *
 * WHICH ONES GO, AND WHY NOT "THE LOWEST PRIORITY". ICE type preference makes
 * host candidates the highest-priority ones (126) and relay the lowest (0), so
 * trimming by priority would throw away exactly the candidates that let a call
 * cross two different NATs and keep the ones that only ever work on a LAN. It
 * is also backwards about the cause: what actually bloats an SDP is HOST
 * candidate spam — a laptop with Wi-Fi, Ethernet, a VPN and a container bridge
 * gathers one per interface per component, and all but a couple are useless.
 *
 * So the rule is BREADTH FIRST: keep at most `perType` of each candidate type,
 * squeezing that allowance down until it fits. Every type keeps a
 * representative for as long as possible, and the interface spam is what goes.
 * Original line order is preserved (candidate order in an SDP carries no
 * meaning — the priority field does).
 *
 * TWO BUDGETS, NOT ONE. The receiver refuses more than MAX_ICE_CANDIDATES
 * lines (sdpIsAudioOnly) as well as more than MAX_SDP_CHARS characters, and 24
 * candidate lines are ~2.6 kB — far under the character cap. So a description
 * that fits on length alone can still be unreadable at the other end, which is
 * exactly what a multi-interface laptop produces the moment a relay is added
 * to the ICE set: an untrimmed offer the peer drops without a word. The count
 * is squeezed here, by the same breadth-first rule, so our own receiver can
 * never refuse what our own sender built.
 *
 * Returns null when even one candidate per type will not fit, which the caller
 * must report rather than truncate: a half-sent description is worse than an
 * unsent one.
 */
export function trimSdpToBudget(sdp: string, maxChars = MAX_SDP_CHARS): string | null {
  const lines = sdp.split(/\r\n|\n/)
  let candidates = 0
  for (const line of lines) if (line.startsWith('a=candidate:')) candidates++
  if (sdp.length <= maxChars && candidates <= MAX_ICE_CANDIDATES) return sdp
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n'
  for (let perType = TRIM_START_PER_TYPE; perType >= 1; perType--) {
    const seen = new Map<string, number>()
    const kept: string[] = []
    let keptCandidates = 0
    for (const line of lines) {
      if (!line.startsWith('a=candidate:')) {
        kept.push(line)
        continue
      }
      const type = CANDIDATE_TYPE.exec(line)?.[1] ?? 'unknown'
      const count = seen.get(type) ?? 0
      if (count >= perType) continue
      seen.set(type, count + 1)
      keptCandidates++
      kept.push(line)
    }
    const out = kept.join(newline)
    if (out.length <= maxChars && keptCandidates <= MAX_ICE_CANDIDATES) return out
  }
  return null
}


// ── Who calls whom ───────────────────────────────────────────────────────────

/**
 * The OFFERER is the peer with the lexicographically smaller session id.
 *
 * Glare — both ends offering at once — is the classic way a mesh deadlocks:
 * each side has a local offer pending and must roll it back to accept the
 * other's, and getting that wrong leaves two half-open connections and no
 * audio. A total order over session ids removes the situation instead of
 * recovering from it: every pair agrees, with no round trip and no coordinator.
 *
 * Equal ids answer false, because that is us and we do not call ourselves.
 */
export function voiceOffererIsUs(mySessionId: string, peerSessionId: string): boolean {
  return mySessionId < peerSessionId
}

/**
 * Round-robin the next peer to send a signalling frame to.
 *
 * One target per frame, because the bus keeps ONE payload per (pluginId, event)
 * and a description is a couple of kilobytes: two peers' offers in one frame
 * would not fit, and two frames in one window would lose the first. Every
 * frame is idempotent and re-sent, so rotating is enough — with the heartbeat
 * at a few hundred milliseconds a full mesh negotiates in a couple of seconds.
 *
 * `last` not being in `pending` (it just finished, or it left) starts over at
 * the head rather than stalling.
 */
export function nextSignalTarget(pending: readonly string[], last: string | null): string | null {
  if (pending.length === 0) return null
  if (last === null) return pending[0] ?? null
  const at = pending.indexOf(last)
  if (at < 0) return pending[0] ?? null
  return pending[(at + 1) % pending.length] ?? null
}

// ── How loud a peer is ───────────────────────────────────────────────────────

/** Inside this many metres a peer is at full volume. */
export const VOICE_NEAR_M = 5
/** At or past this many metres a peer is silent. */
export const VOICE_FAR_M = 28
/** >1 keeps voices present across the room and drops them off near the edge. */
export const VOICE_ROLLOFF = 1.7

/**
 * Proximity falloff: 1 inside NEAR, 0 at FAR, a smooth curve between.
 *
 * Continuous at both ends on purpose — a gain that steps is heard as a click,
 * and a peer walking a circle at exactly FAR metres would otherwise chatter.
 * Non-finite input reads as "infinitely far", because a NaN gain silences a
 * WebAudio graph for the rest of the session.
 */
export function proximityGain(distanceM: number): number {
  if (!Number.isFinite(distanceM)) return 0
  if (distanceM <= VOICE_NEAR_M) return 1
  if (distanceM >= VOICE_FAR_M) return 0
  const t = (VOICE_FAR_M - distanceM) / (VOICE_FAR_M - VOICE_NEAR_M)
  return t ** VOICE_ROLLOFF
}

/**
 * The gain for one peer under the current mode.
 *
 * 'squad' is a party call: everyone is always audible wherever they are, which
 * is what "talk to each other like we are on a call" means and what makes the
 * feature work the first time somebody tries it. 'proximity' is the spatial
 * mode — the same mesh, mixed by distance.
 */
export function mixGain(mode: VoiceMode, distanceM: number): number {
  return mode === 'squad' ? 1 : proximityGain(distanceM)
}

// ── When a mic counts as talking ─────────────────────────────────────────────

/** RMS at which an open mic starts transmitting as "talking". */
export const VAD_OPEN_RMS = 0.022
/** …and the lower level it must fall below to stop. */
export const VAD_CLOSE_RMS = 0.012
/** How long a talker stays "talking" through a pause between words (ms). */
export const VAD_HANG_MS = 400

/**
 * Is this mic talking? Hysteresis plus a hang time, which is not cosmetic: a
 * single threshold makes the HUD indicator strobe on every syllable, and a
 * gate with no hang cuts the end off every word. Two thresholds mean the level
 * that starts a transmission is higher than the one that ends it, so ordinary
 * speech never sits on the boundary.
 *
 * `msSinceOverOpen` is time since the level was last over VAD_OPEN_RMS; the
 * caller keeps that clock, so this stays pure.
 */
export function talkGate(args: {
  rms: number
  wasTalking: boolean
  msSinceOverOpen: number
}): boolean {
  const { rms, wasTalking, msSinceOverOpen } = args
  if (!Number.isFinite(rms)) return false
  if (rms >= VAD_OPEN_RMS) return true
  if (!wasTalking) return false
  if (rms >= VAD_CLOSE_RMS) return true
  return msSinceOverOpen < VAD_HANG_MS
}

// ── Who is in the mesh ───────────────────────────────────────────────────────

/**
 * The voice room: the MAX_VOICE_PEERS lowest session ids in the whole roster,
 * ourselves included.
 *
 * THE CAP IS ON THE ROOM, NOT ON EACH PEER'S LIST, and that is the only version
 * that is symmetric. Capping per peer looks equivalent and is not: with eight
 * people, A would keep the six lowest of its seven others and B the six lowest
 * of its seven others — different sets, so A can want B while B has no interest
 * in A, and that pair sits forever holding one half-open connection with no
 * audio and nothing to log. Deriving one room from one sorted roster means both
 * ends of every pair always reach the same verdict.
 *
 * The honest cost: past the cap the highest-id arrivals are outside voice
 * entirely rather than partially connected. They still see and hear the game.
 * voice.ts reports the excluded count so it is a number and not a mystery.
 */
export function voiceRoom(roster: readonly string[]): string[] {
  const unique = [...new Set(roster)].filter((id) => isSessionId(id))
  unique.sort()
  return unique.slice(0, MAX_VOICE_PEERS)
}

/** The peers WE should hold a connection to — empty if we are past the cap. */
export function voicePeersFor(mySessionId: string, roster: readonly string[]): string[] {
  const room = voiceRoom(roster)
  if (!room.includes(mySessionId)) return []
  return room.filter((id) => id !== mySessionId)
}
