<p align="center">
  <img src="src/assets/boots-loader.webp" width="560" alt="Boots — Pascaline in her hard hat, on the loading plate" />
</p>

# Boots

**First-person mode for the [Pascal editor](https://github.com/pascalorg/editor). Put your boots on, walk the job, and work the punch list from the ground.**

Bones shows you what the house is made of. Boots puts you *in* it — eye height, WASD, pointer lock — the way you'd actually walk a jobsite: clipboard in hand, cones on the floor.

## Today

- **Jump in** — one button. Full screen, pointer lock, standing in the building you were just editing. Stay first person or press `Tab` for a Fortnite-style shoulder camera and your local Pascaline avatar.
- **Play** — break the walls, shatter the glass. Peaceful until you gear up at the table: grab a gun and a five-second countdown starts at the top of the screen — *They heard you* — then HERE THEY COME, and they keep coming in waves. You can't die — you get staggered: red screen, pounding heart, the machines backing off while you shake it off and get back up.
- **Build** — slot `4`/`B`: cycle pieces with `Q`, hold click to place a run, `U` to undo, and `G` to throw a grenade. Pieces snap to what you've placed — walls chain and stack (look up to go up), floors tile and cap wall tops (build a box of walls, roof it with floors), ramps land on floor edges and climb to wall tops. When you're done playing, keep what you built — walls become real editor walls — or discard it all.
- **Furnish** — press `I` for the live item catalog. Place furniture on floors, counters, shelves, or other suitable surfaces; `R` rotates and `L` lifts a placed object so it can be moved without crossing blocking geometry.
- **Drive** — enter the Cybertruck with `E`. Its supply trailer closes for travel, follows through an articulated hitch, and reopens when you get out.
- **Share the site** — collaborators see interpolated Pascalines, builds, items, damage, shots, the convoy, and spatial voice over the host project bus. Editor-view spectators see the small live characters moving through the building.
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

> **Not on npm** — and that's deliberate. Boots only runs inside the
> Pascal editor: players just enable it from the **Plugins panel** at
> [editor.pascal.app](https://editor.pascal.app); host apps consume it
> pinned straight from this repo (`github:pascalorg/plugin-boots#<sha>`).

Boots is a standard Pascal editor plugin — raw TypeScript, peer-deps on `@pascal-app/core|editor|viewer`.

```bash
bun install
bun test
bun run check-types
```

Host wiring follows the [plugin guide](https://editor.pascal.app/docs/developers/plugins): pin the package, add it to `transpilePackages`, `extendPluginDiscovery(async () => [bootsPlugin])`, `registerEditorHostPanel(bootsHostPanel)`. Ships `defaultInstalled: false` — users enable it per scene from the Plugins panel.

## License

MIT
