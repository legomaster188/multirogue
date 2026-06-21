# ☠ MultiRogue

A **multiplayer ASCII roguelike**. One shared, procedurally-generated dungeon;
everyone connected plays in the same world in real time.

## Run

```bash
npm install
npm start            # serves http://localhost:3000
```

Open the URL in a browser (multiple tabs, or other machines on your network via
`http://<your-ip>:3000`). Each tab is a separate hero.

## Play

| Key | Action |
|-----|--------|
| `WASD` / arrows | move (bump a monster to attack) |
| `Y U B N` | move diagonally |
| `>` / `<` | descend / climb stairs (while standing on them) |
| `Q` | quaff a healing potion |
| `E` | eat a food ration |
| `Enter` | chat with the party |

### The quest (modeled on the original *Rogue*)

The dungeon is **dark** — rooms light up only when you enter them, and corridors reveal
just the squares beside you. Explored ground is remembered, dimmed. Each player has their
own field of view, but you all crawl one **persistent** dungeon, so a floor you cleared
stays cleared and the party can split across depths.

- **Goal:** descend to **depth 8**, claim the **Amulet of Yendor** (`"`), and carry it
  back up to the surface (`<` on depth 1) to win.
- **Hunger:** your `Sated → Hungry → Weak → Starving` clock ticks down. Eat rations (`%`)
  with `E` or you'll starve to death.
- **Gear:** pick up weapons (`)`) for `+ATK` and armor (`[`) for armor class, which soaks
  incoming damage. Better gear auto-equips.
- **Loot & combat:** grab `$` gold and `!` potions; kill monsters
  (`b`at → `r`at → `k`obold → `s`nake → `o`rc → `z`ombie → `T`roll → `D`ragon, scaling with
  depth) for XP and level up (+HP/+ATK). Slain monsters may drop gold.
- **Traps** (`^`) hide in the floor — dart traps wound you, trap doors fling you across
  the level. They reveal once sprung.
- **Death** isn't permanent here: you respawn at the entrance after a few seconds, losing
  half your gold — and if you were carrying the Amulet, it drops where you fell.

`@` is you, `&` are other heroes (only visible when in your line of sight).

## Play online (over the internet)

The server is host-ready: it binds all interfaces, respects `$PORT`, and the client
auto-upgrades to secure `wss://` when served over HTTPS. Deploy it anywhere that runs
Node and share the URL — anyone who opens it joins the same live dungeon.

- **Render** (free): push this repo, create a *Blueprint* — `render.yaml` is detected
  automatically.
- **Docker**: `docker build -t multirogue . && docker run -p 3000:3000 multirogue`
- **Any Node host** (Railway, Fly.io, a VPS): run `npm install && npm start`.

For a quick public link from your own machine, a tunnel works too:
`npx localtunnel --port 3000` (or `cloudflared tunnel --url http://localhost:3000`).

## Architecture

- `server.js` — authoritative game server. Owns persistent per-depth levels, monster
  AI, combat, loot, hunger, and the win condition. Ticks every 200ms; computes a
  **per-player** snapshot (each hero sees only their own field of view) and sends it
  over WebSocket. Players move in real time (rate-limited to one step/tick). Monster AI
  only runs on floors that currently have players.
- `public/index.html` — thin client: renders the fog-of-war grid, HUD (HP/XP/hunger,
  gear, depth, Amulet), party roster, legend, and log/chat; sends input. No game logic
  lives here, so clients can't cheat or see through walls.
- `test-client.mjs` — headless smoke test (two players: fog-of-war, HUD, movement).
- `test-descend.mjs` — pathfinding bot that explores, descends, and climbs back.

Authoritative-server design means all players always agree on the world state, and
since visibility is computed server-side, the unexplored map is never sent to a client.
