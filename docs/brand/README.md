<p align="center">
  <img src="../../src/assets/boots-loader.webp" width="520" alt="Boots — Pascaline on the loading plate" />
</p>

# BOOTS — the brand

The plugin keeps its name. Everything you can look at is new, and all of it is
**Pascaline**, the editor's official mascot: hard hat carrying the Pascal
logotype and its stair-step mark, black jacket over a black Pascal tee, tool
belt, and — the reason the name still fits — tan work boots.

What was there before: a rail icon of a frightened man in a helmet standing
between two wooden boards (generated, off-brand, nothing to do with the
product), and a loading screen made entirely of type.

## The rule

**Nothing here is generated.** Every pixel of Pascaline comes from the official
render pack in [`pascalorg/pascaline`](https://github.com/pascalorg/pascaline)
(2048×2084 PNG originals). `build-brand-assets.py` only frames her, lights her,
and animates the plate around her. That is deliberate: a model asked for "the
mascot" drifts off-model every single time, and the mascot belongs to the whole
product, not to this plugin.

## The assets

| file | size | where it shows |
| --- | --- | --- |
| `src/assets/boots-icon.webp` | 512×512, static | the left-rail entry (host renders it at **20×20**), the Plugins panel list (**32×32**), and the panel header (24 px) |
| `src/assets/boots-loader.webp` | 700×300, **24 frames, 1.92 s, loop-exact** | above the loading bar, in both loading surfaces |

Both are reached through [`src/art.ts`](../../src/art.ts) as `BOOTS_ICON` and
`BOOTS_LOADER`. Next's static image import hands back
`{ src, width, height }`; hosts and raw DOM both want the URL, so `art.ts`
exports `.src`.

### `boots-icon.webp` — the badge

A tight portrait: hat to smile. The crop is sized against the only number that
matters, the 20 px the rail actually renders (`h-5 w-5` in the host's
`use-plugin-panels.tsx`). Wider crops were rendered at 20 px and compared —
taking in the collar and jacket turns the bottom half into one dark smear. At
20 px the recognition budget is the white cap shape, two dark eyes, and the
yellow rail, and that is exactly what it spends it on.

> **The filename is load-bearing.** `docs/qa/qa-boots-roster.mjs` finds the rail
> entry with `img[src*="boots-icon"]`, because the host renders that entry as an
> icon with no text and no `aria-label` — it is the only thing in that DOM that
> names Boots. Rename the file and the QA script goes blind.

### `boots-loader.webp` — the loading hero

Pascaline cycling three official poses (`thumbs-up`, `wave`, `hands-palm`) over
a turning sunburst, with the depot hazard rail scrolling along the bottom edge.

The three poses are the three that **register on the hard hat to the pixel**, so
the cycle reads as one character gesturing instead of three cross-fades.
`celebrate` and `point-left` are framed differently and would jump, which is why
they are not in the set. Poses are anchored on the hat's centre, not the alpha
bbox — the bbox moves with whichever arm is outstretched, so centring on it
would swing her sideways on every pose change.

**All the motion is loop-exact:** the sunburst turns exactly two ray-periods,
the rail scrolls exactly one stripe period, the bob runs two sine cycles, the
spotlight pulse one. Frame 24 *is* frame 0 — no cross-fade, no seam.

**Why animated WebP and not GIF.** The ask was "maybe animated gif during
loading above the bar", and WebP is strictly the better way to deliver it here:
a quarter of the bytes, 24-bit colour instead of a 256-entry palette (this art
is a soft-shaded 3D render — a GIF palette bands it visibly), and
`src/assets.d.ts` already declares `*.webp`, so it rides the existing
static-import pipeline with no new module declaration. Every browser that can
run this plugin has decoded animated WebP for years — it renders through WebGPU.

It is a plain `<img>` in both surfaces, so the **browser** owns the animation:
no rAF, no timer, no work at all on the frame loop the loading card exists to
wait for.

## The palette

The accent is the plugin's existing `#e8c229` — the JUMP IN button, the depot
hazard stripes, the loading card's rule are already this yellow, so the new art
reads as the same product rather than a bolt-on. The plate is `#0e1114` base
lifted to steel `#54636f` by the spotlight (she wears black on black; without a
lit plate she is a silhouette).

## Rebuilding

```sh
git clone --depth=1 git@github.com:pascalorg/pascaline.git /tmp/pascaline
python3 docs/brand/build-brand-assets.py        # writes into src/assets/
```

Needs Pillow + numpy. This is a one-shot art step, not part of the build: the
outputs are committed and CI never runs it.
