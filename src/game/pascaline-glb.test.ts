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

/** The 12-byte GLB header + the first chunk's type, as read — asserted in a test body. */
type GlbHeader = { magic: number; version: number; totalBytes: number; firstChunkType: number }

/**
 * Header + JSON chunk only. Runs at module scope, so it must not call
 * `expect()` (bun reports an expect outside a test as its own failure, with
 * no test name to point at): a malformed container throws a plain Error
 * naming the field, and the header values are returned for the test below.
 */
function parseGlb(bytes: Uint8Array): { json: GltfJson; header: GlbHeader } {
  if (bytes.byteLength < 20) throw new Error(`GLB too short for a header + chunk: ${bytes.byteLength} B`)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const header: GlbHeader = {
    magic: view.getUint32(0, true),
    version: view.getUint32(4, true),
    totalBytes: view.getUint32(8, true),
    firstChunkType: view.getUint32(16, true),
  }
  const jsonLength = view.getUint32(12, true)
  if (header.firstChunkType !== CHUNK_JSON) {
    throw new Error(`first GLB chunk is not JSON (type 0x${header.firstChunkType.toString(16)})`)
  }
  if (20 + jsonLength > bytes.byteLength) throw new Error(`JSON chunk (${jsonLength} B) runs past the file`)
  const json = JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as GltfJson
  return { json, header }
}

const bytes = decodeBase64(PASCALINE_GLB_BASE64)
const { json, header } = parseGlb(bytes)
const materials = json.materials ?? []
const face = materials.find((m) => m.name === 'face')
const body = materials.find((m) => m.name === 'model')
const primitives = (json.meshes ?? []).flatMap((m) => m.primitives)

describe('embedded Pascaline GLB', () => {
  test('is a well-formed v2 GLB under the size budget', () => {
    // Container: magic 'glTF', binary version 2, declared length = actual
    // length (a truncated or padded embed fails here, by name), JSON first.
    expect(header.magic).toBe(GLB_MAGIC)
    expect(header.version).toBe(2)
    expect(header.totalBytes).toBe(bytes.byteLength)
    expect(header.firstChunkType).toBe(CHUNK_JSON)
    expect(json.asset.version).toBe('2.0')
    expect(header.totalBytes).toBeLessThan(PASCALINE_GLB_MAX_BYTES)
  })

  test('has the body atlas material and the face plate material', () => {
    expect(body).toBeDefined()
    expect(face).toBeDefined()
    // The body is textured (the generator's atlas rides its base colour);
    // whether it also ships a normal / MR map is a size-vs-noise call for the
    // asset pipeline (today it does — ~80 KB each, see assets/README.md), NOT
    // part of the contract. The plate IS: a flat albedo, nothing else, so the
    // painted face never gets a bump or gloss step at the hat seam.
    expect(body?.pbrMetallicRoughness?.baseColorTexture).toBeDefined()
    expect(face?.pbrMetallicRoughness?.baseColorTexture).toBeDefined()
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

  test('the face plate image is present and is what the face material samples', () => {
    // Semantic, not a count: follow the face material's base colour to its
    // texture to its image, and require that to be the painted plate. The body
    // atlas is a second, distinct image. How many OTHER maps the body carries
    // is not pinned (see the material test).
    const images = json.images ?? []
    const textures = json.textures ?? []
    const faceTex = textures[face?.pbrMetallicRoughness?.baseColorTexture?.index as number]
    const faceImage = images[faceTex?.source as number]
    expect(faceImage).toBeDefined()
    expect(faceImage?.name).toBe('pascaline_face')
    const bodyTex = textures[body?.pbrMetallicRoughness?.baseColorTexture?.index as number]
    expect(bodyTex?.source).toBeDefined()
    expect(bodyTex?.source).not.toBe(faceTex?.source) // the plate is its own picture
    expect(images.length).toBeGreaterThanOrEqual(2)
    // Every image JPEG: the size budget above is only met with JPEG textures
    // (a PNG atlas at 1024 px alone would blow it).
    for (const img of images) expect(img.mimeType).toBe('image/jpeg')
  })

  test('rigDims extras ride along with every measured key', () => {
    const raw = (json.nodes ?? []).map((n) => n.extras?.rigDims).find((r) => r !== undefined)
    expect(raw).toBeDefined()
    const dims = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>
    expect(Math.abs((dims.height as number) - 1.85)).toBeLessThan(1e-3)
    for (const key of Object.keys(DEFAULT_DIMS)) expect(dims).toHaveProperty(key)
  })
})
