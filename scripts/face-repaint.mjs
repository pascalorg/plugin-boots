/**
 * FACE REPAINT — ask an image model to repaint the flat ortho render of the
 * avatar's head (scripts/face-plate.py render → <prefix>-input.png) as a crisp,
 * on-model version of the mascot, keeping the framing so the result drops
 * straight onto the face plate.
 *
 *     source ~/.zshrc   # FAL_KEY
 *     node scripts/face-repaint.mjs <input.png> <ref.png> <out-prefix> [--n 4] [--seed N]
 *                                   [--png-inputs] [--prompt-suffix "..."] [--prompt-file f.txt]
 *
 * Writes <out-prefix>-<i>.png for each candidate and <out-prefix>-job.json
 * (request id, prompt, seed, sha256 of both inputs, model) so a pick can be
 * reproduced. Inputs go up as JPEG q92 data URIs by default (~150-250 KB each;
 * `--png-inputs` sends the PNGs verbatim). The model is fal-ai/nano-banana/edit
 * over the queue REST API: submit, poll status_url every 2 s (5 min cap), GET
 * response_url. Any non-2xx prints the response body so a payload rejection is
 * visible at once.
 *
 * The prompt is written for what survives at 60-100 px on a peer's screen:
 * white sclera + dark irises, thick brows, a dark lip line — not the wordmark.
 * Candidates are judged at 96 px (scripts/preview-head.py), never on the hat
 * text.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const MODEL = 'fal-ai/nano-banana/edit'
export const QUEUE_URL = `https://queue.fal.run/${MODEL}`

export const REPAINT_PROMPT =
  'Image 1 is a flat orthographic front render of a low-detail 3D character head on a plain grey background. ' +
  'Repaint image 1 as a crisp, high-detail version of the character in image 2 (the official mascot). ' +
  "Keep image 1's framing, scale, head position, hat brim line, hair outline and jacket collar EXACTLY where they are; " +
  'do not crop, zoom, rotate, or change the background. ' +
  'Keep every hair strand that falls over the face exactly where it is, painted as dark brown hair. ' +
  'Skin tone identical to image 1. ' +
  'Give the face strong readable features: large eyes with clearly visible white sclera and dark-brown irises, ' +
  'one bright catchlight each, looking straight ahead; thick, defined dark eyebrows; small nose; ' +
  'a warm smile with a clearly defined dark lip line; gentle top-down form shading, no hard shadows, ' +
  'no specular highlights except the eye catchlights. ' +
  "White hard hat with the black 'Pascal' wordmark and the small three-bar logo centered on the hat front. " +
  'Long wavy dark-brown hair, black jacket. Same plain grey background as image 1. 3D cartoon render style, sharp.'

const argv = process.argv.slice(2)
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt)
const positional = argv.filter((a, i) => !a.startsWith('--') && (i === 0 || !argv[i - 1].startsWith('--') || ['--png-inputs'].includes(argv[i - 1])))

function usage(msg) {
  if (msg) console.error(msg)
  console.error('usage: node scripts/face-repaint.mjs <input.png> <ref.png> <out-prefix> [--n 4] [--seed N] [--png-inputs] [--prompt-suffix "..."] [--prompt-file f.txt]')
  process.exit(2)
}

const [INPUT, REF, OUT] = positional
if (!INPUT || !REF || !OUT) usage()
if (!existsSync(INPUT)) usage(`no such file: ${INPUT}`)
if (!existsSync(REF)) usage(`no such file: ${REF}`)
const N = Number(opt('--n', '4'))
const SEED = argv.includes('--seed') ? Number(opt('--seed')) : undefined
const PNG_INPUTS = argv.includes('--png-inputs')
const SUFFIX = opt('--prompt-suffix', '')
const PROMPT_FILE = opt('--prompt-file', null)
const PROMPT = (PROMPT_FILE ? readFileSync(PROMPT_FILE, 'utf8').trim() : REPAINT_PROMPT) + (SUFFIX ? ' ' + SUFFIX : '')

const FAL_KEY = process.env.FAL_KEY
if (!FAL_KEY) {
  console.error('FAL_KEY is not set (source ~/.zshrc)')
  process.exit(2)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** A data: URI for the image — JPEG q92 through sips unless --png-inputs. */
function dataUri(path) {
  if (PNG_INPUTS) return `data:image/png;base64,${readFileSync(path).toString('base64')}`
  const dir = mkdtempSync(join(tmpdir(), 'face-repaint-'))
  const out = join(dir, 'in.jpg')
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', path, '--out', out], { stdio: 'pipe' })
    const bytes = readFileSync(out)
    console.log(`  ${path} → jpeg q92 ${(bytes.length / 1024).toFixed(0)} KB`)
    return `data:image/jpeg;base64,${bytes.toString('base64')}`
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function falFetch(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${FAL_KEY}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(`${init?.method ?? 'GET'} ${url} → ${res.status}\n${text.slice(0, 2000)}`)
    throw new Error(`fal ${res.status}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`fal returned non-JSON: ${text.slice(0, 200)}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`model ${MODEL}, n=${N}${SEED !== undefined ? `, seed=${SEED}` : ''}`)
  const body = {
    prompt: PROMPT,
    image_urls: [dataUri(INPUT), dataUri(REF)],
    num_images: N,
    aspect_ratio: '1:1',
    output_format: 'png',
  }
  if (SEED !== undefined) body.seed = SEED
  const payload = JSON.stringify(body)
  console.log(`  payload ${(payload.length / 1024).toFixed(0)} KB`)
  const submitted = await falFetch(QUEUE_URL, { method: 'POST', body: payload })
  const { request_id, status_url, response_url } = submitted
  if (!request_id || !status_url || !response_url) throw new Error(`unexpected submit response: ${JSON.stringify(submitted)}`)
  console.log(`  request ${request_id}`)

  const t0 = Date.now()
  let status = submitted.status
  while (status !== 'COMPLETED') {
    if (Date.now() - t0 > 5 * 60_000) throw new Error('timed out after 5 min waiting for the queue')
    await sleep(2000)
    const s = await falFetch(`${status_url}?logs=0`, { method: 'GET' })
    if (s.status !== status) console.log(`  ${s.status}${s.queue_position !== undefined ? ` (queue ${s.queue_position})` : ''}`)
    status = s.status
    if (status === 'FAILED' || status === 'CANCELLED') throw new Error(`request ${status}: ${JSON.stringify(s).slice(0, 500)}`)
  }
  const result = await falFetch(response_url, { method: 'GET' })
  const images = result.images ?? []
  if (!images.length) throw new Error(`no images in result: ${JSON.stringify(result).slice(0, 500)}`)
  const written = []
  for (let i = 0; i < images.length; i++) {
    const url = images[i].url
    let bytes
    if (url.startsWith('data:')) {
      bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64')
    } else {
      const r = await fetch(url)
      if (!r.ok) throw new Error(`download ${url} → ${r.status}`)
      bytes = Buffer.from(await r.arrayBuffer())
    }
    const path = `${OUT}-${i}.png`
    writeFileSync(path, bytes)
    written.push(path)
    console.log(`  wrote ${path} (${images[i].width}x${images[i].height}, ${(bytes.length / 1024).toFixed(0)} KB)`)
  }
  const job = {
    model: MODEL,
    request_id,
    seed: result.seed ?? SEED ?? null,
    prompt: PROMPT,
    n: N,
    inputs: { input: INPUT, ref: REF, inputSha256: sha256(INPUT), refSha256: sha256(REF), encoding: PNG_INPUTS ? 'png' : 'jpeg-q92' },
    outputs: written,
    description: result.description ?? null,
    at: new Date().toISOString(),
  }
  writeFileSync(`${OUT}-job.json`, JSON.stringify(job, null, 2) + '\n')
  console.log(`  wrote ${OUT}-job.json (seed ${job.seed})`)
}

main().catch((e) => {
  console.error(e.message ?? e)
  process.exit(1)
})
