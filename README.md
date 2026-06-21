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
| `Q` | quaff a healing potion |
| `Enter` | chat with the party |

Grab `$` gold and `!` potions. Reach the `>` stairs to take the **whole party**
deeper — each level spawns tougher monsters (`r`at → `k`obold → `o`rc → `T`roll → `D`ragon).
Kill monsters for XP, level up (+HP/+ATK). Die and you respawn after a few seconds.
`@` is you, `&` are other players.

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

- `server.js` — authoritative game server. Owns the map, monsters, combat, and
  loot. Ticks monster AI every 200ms and broadcasts the full world snapshot to all
  clients over WebSocket. Players move in real time (rate-limited to one step/tick).
- `public/index.html` — thin client: renders the ASCII grid, HUD, party roster,
  and log/chat; sends input. No game logic lives here, so clients can't cheat.
- `test-client.mjs` — headless smoke test (two players join, sync, and move).

Authoritative-server design means all players always agree on the world state.
