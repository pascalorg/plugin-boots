# Boots

**First-person mode for the [Pascal editor](https://github.com/pascalorg/editor). Put your boots on, walk the job, and work the punch list from the ground.**

Bones shows you what the house is made of. Boots puts you *in* it — eye height, WASD, pointer lock — the way you'd actually walk a jobsite: clipboard in hand, cones on the floor.

## Today

- **Jump in** — one button. Full screen, pointer lock, first person, standing in the building you were just editing. It's a game — and a way to build.
- **Play** — break the walls, shatter the glass. Peaceful until you gear up at the table: grab a gun and the machines arrive on a short countdown. You can't die — you get staggered; catch your breath and keep going.
- **Build** — slot `4`/`B`: cycle pieces with `Q`, hold click to place a run, `G` to undo. When you're done playing, keep what you built — walls become real editor walls — or discard it all.
- `Esc` exits, and the editor is exactly as you left it.
- `boots:job` — a punch-list cone node kind (fix / paint / install / clean / inspect, open/done), groundwork for the loop below.

## Where it's going

Editing, in first person, with game feel:

- **Punch list** — post job cones where work is needed, see them from the ground, check them off as you go.
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
