import { describe, expect, test } from 'bun:test'
import { PASCALINE_GLB_BASE64 } from './pascaline-glb'
import { DEFAULT_DIMS, decodeBase64, PIVOT_NAMES } from './pascaline-model'

/**
 * The embedded avatar's CONTRACT — what the game and the asset pipeline rely
 * on, not tonight's exact numbers. A re-rig (more bones), a re-embed or a new
 * face paint must keep passing; dropping the face plate, losing the clamp,
 * shipping a translucent material or blowing the size budget must not.
 *
 * Only the GLB header and JSON chunk are read (no Draco decode): ~50 ms.
 */

/** Keep the embedded body under a megabyte: it is one chunk every session downloads once. */
const PASCALINE_GLB_MAX_BYTES = 1_000_000
const GLB_MAGIC = 0x46546c67
const CHUNK_JSON = 0x4e4f534a
/** glTF sampler wrap: CLAMP_TO_EDGE (the default, absent, is REPEAT). */
const CLAMP_TO_EDGE = 33071
/** Bones the runtime looks up by name (pascaline-model.ts), beyond the six pivots. */
const LIMB_BONES = ['foreL', 'foreR', 'handL', 'handR', 'shinL', 'shinR'] as const

type GltfTextureRef = { index: number }
type GltfMaterial = {
  name?: string
  alphaMode?: string
  normalTexture?: GltfTextureRef
  pbrMetallicRoughness?: { baseColorTexture?: GltfTextureRef; metallicRoughnessTexture?: GltfTextureRef }
}
type GltfPrimitive = { attributes: Record<string, number>; extensions?: Record<string, unknown> }
type GltfJson = {
  asset: { version: string }
  materials?: GltfMaterial[]
  textures?: { sampler?: number; source?: number }[]
  samplers?: { wrapS?: number; wrapT?: number }[]
  images?: { mimeType?: string; name?: string; bufferView?: number }[]
  meshes?: { primitives: GltfPrimitive[] }[]
  skins?: { joints: number[] }[]
  nodes?: { name?: string; extras?: Record<string, unknown> }[]
}

function parseGlb(bytes: Uint8Array): { json: GltfJson; totalBytes: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(view.getUint32(0, true)).toBe(GLB_MAGIC)
  expect(view.getUint32(4, true)).toBe(2)
  const totalBytes = view.getUint32(8, true)
  expect(totalBytes).toBe(bytes.byteLength)
  const jsonLength = view.getUint32(12, true)
  expect(view.getUint32(16, true)).toBe(CHUNK_JSON)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson
  return { json, totalBytes }
}

const bytes = decodeBase64(PASCALINE_GLB_BASE64)
const { json, totalBytes } = parseGlb(bytes)
const materials = json.materials ?? []
const face = materials.find((m) => m.name === 'face')
const body = materials.find((m) => m.name === 'model')
const primitives = (json.meshes ?? []).flatMap((m) => m.primitives)

describe('embedded Pascaline GLB', () => {
  test('is a v2 GLB under the size budget', () => {
    expect(json.asset.version).toBe('2.0')
    expect(totalBytes).toBeLessThan(PASCALINE_GLB_MAX_BYTES)
  })

  test('has the body atlas material and the face plate material', () => {
    expect(body).toBeDefined()
    expect(face).toBeDefined()
    // The body keeps its generator maps; the plate is a flat albedo only.
    expect(body?.normalTexture).toBeDefined()
    expect(face?.normalTexture).toBeUndefined()
    expect(face?.pbrMetallicRoughness?.metallicRoughnessTexture).toBeUndefined()
    // Both opaque: a BLEND mesh inside an avatar sorts against itself and flickers.
    for (const m of materials) expect(m.alphaMode).toBeUndefined()
  })

  test('face plate sampler clamps to the edge (no REPEAT wrap onto the plate)', () => {
    const texIndex = face?.pbrMetallicRoughness?.baseColorTexture?.index
    expect(texIndex).toBeDefined()
    const texture = json.textures?.[texIndex as number]
    expect(texture?.sampler).toBeDefined()
    const sampler = json.samplers?.[texture?.sampler as number]
    expect(sampler?.wrapS).toBe(CLAMP_TO_EDGE)
    expect(sampler?.wrapT).toBe(CLAMP_TO_EDGE)
  })

  test('every primitive is skinned, UV-mapped and Draco-compressed', () => {
    expect(primitives.length).toBeGreaterThanOrEqual(2)
    for (const p of primitives) {
      expect(p.attributes.JOINTS_0).toBeDefined()
      expect(p.attributes.WEIGHTS_0).toBeDefined()
      expect(p.attributes.TEXCOORD_0).toBeDefined()
      expect(p.extensions?.KHR_draco_mesh_compression).toBeDefined()
    }
  })

  test('one skin with at least the 13 rig bones, all named bones present', () => {
    expect(json.skins?.length).toBe(1)
    expect(json.skins?.[0]?.joints.length ?? 0).toBeGreaterThanOrEqual(13)
    const names = new Set((json.nodes ?? []).map((n) => n.name))
    for (const name of [...PIVOT_NAMES, ...LIMB_BONES, 'root']) expect(names.has(name)).toBe(true)
  })

  test('all images are JPEG and the plate is among them', () => {
    const images = json.images ?? []
    expect(images.length).toBeGreaterThanOrEqual(4)
    for (const img of images) expect(img.mimeType).toBe('image/jpeg')
    expect(images.some((img) => img.name === 'pascaline_face')).toBe(true)
  })

  test('rigDims extras ride along with every measured key', () => {
    const raw = (json.nodes ?? []).map((n) => n.extras?.rigDims).find((r) => r !== undefined)
    expect(raw).toBeDefined()
    const dims = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
    expect(Math.abs((dims.height as number) - 1.85)).toBeLessThan(1e-3)
    for (const key of Object.keys(DEFAULT_DIMS)) expect(dims).toHaveProperty(key)
  })
})
