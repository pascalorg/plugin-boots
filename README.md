# Boots

**First-person mode for the [Pascal editor](https://github.com/pascalorg/editor). Put your boots on, walk the job, and work the punch list from the ground.**

Bones shows you what the house is made of. Boots puts you *in* it — eye height, WASD, pointer lock — the way you'd actually walk a jobsite: clipboard in hand, cones on the floor, "good enough" is not on the inspection sheet.

## Today (v0)

- **Walk the job** — one click drops you into the editor's first-person mode at eye height.
- **Punch list** — place `boots:job` cones where work is needed (fix / paint / install / clean / inspect), check them off as they're done. The panel is the live punch list; the cones are the scene truth.

## Where it's going

Editing, in first person, with game feel:

- **Work the cone** — walk up to a job marker and do the work right there: swap the fixture, paint the wall, straighten the door.
- **Tool belt** — a hotbar of editor tools usable from first person (point at a wall, click, it's patched).
- **Real collisions** — capsule-vs-scene so you walk through doorways, not walls (BVH against the meshes you're editing).
- **Grab & carry** — pick up furniture and set it down where it belongs.
- **Co-op** — walk the job with the crew.

See [`docs/RESEARCH.md`](docs/RESEARCH.md) for the open-source three.js groundwork this builds on.

## Install (development)

Boots is a standard Pascal editor plugin — raw TypeScript, peer-deps on `@pascal-app/core|editor|viewer`.

```bash
bun install
bun test
bun run check-types
```

Host wiring follows the [plugin guide](https://editor.pascal.app/docs/developers/plugins): pin the package, add it to `transpilePackages`, `extendPluginDiscovery(async () => [bootsPlugin])`, `registerEditorHostPanel(bootsHostPanel)`. Ships `defaultInstalled: false` — users enable it per scene from the Plugins panel.

## License

MIT
