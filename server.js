// MultiRogue — authoritative multiplayer roguelike server.
// One shared dungeon. Players move in real time; monsters act on a tick.
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join, extname } from 'path';
import { WebSocketServer } from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ---------- tiny static file server (serves /public) ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const http = createServer(async (req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  try {
    const body = await readFile(join(__dirname, 'public', url));
    res.writeHead(200, { 'Content-Type': MIME[extname(url)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

// ---------- RNG / helpers ----------
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

// ---------- Map tiles ----------
const W = 60, H = 34;
const WALL = '#', FLOOR = '.', STAIRS = '>';

// ---------- Dungeon generation: rooms + corridors ----------
function genDungeon(depth) {
  const grid = Array.from({ length: H }, () => Array(W).fill(WALL));
  const rooms = [];
  const tries = 60;
  for (let i = 0; i < tries && rooms.length < 12; i++) {
    const rw = 4 + rnd(8), rh = 3 + rnd(5);
    const rx = 1 + rnd(W - rw - 1), ry = 1 + rnd(H - rh - 1);
    const room = { x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) };
    if (rooms.some(o => rx < o.x + o.w + 1 && rx + rw + 1 > o.x && ry < o.y + o.h + 1 && ry + rh + 1 > o.y)) continue;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) grid[y][x] = FLOOR;
    rooms.push(room);
  }
  // connect each room to the previous with an L-shaped corridor
  const carveH = (x1, x2, y) => { for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) grid[y][x] = FLOOR; };
  const carveV = (y1, y2, x) => { for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) grid[y][x] = FLOOR; };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    if (rnd(2)) { carveH(a.cx, b.cx, a.cy); carveV(a.cy, b.cy, b.cx); }
    else { carveV(a.cy, b.cy, a.cx); carveH(a.cx, b.cx, b.cy); }
  }
  // stairs in the last room
  const last = rooms[rooms.length - 1] || { cx: W >> 1, cy: H >> 1 };
  grid[last.cy][last.cx] = STAIRS;
  const spawn = rooms[0] || last;
  return { grid, rooms, spawn: { x: spawn.cx, y: spawn.cy }, stairs: { x: last.cx, y: last.cy } };
}

// ---------- Monster archetypes; scale with depth ----------
const MONSTERS = [
  { g: 'r', name: 'rat',     hp: 4,  atk: 1, xp: 2,  speed: 2, sight: 5 },
  { g: 'k', name: 'kobold',  hp: 7,  atk: 3, xp: 5,  speed: 2, sight: 7 },
  { g: 'o', name: 'orc',     hp: 14, atk: 5, xp: 12, speed: 3, sight: 7 },
  { g: 'T', name: 'troll',   hp: 26, atk: 9, xp: 30, speed: 4, sight: 8 },
  { g: 'D', name: 'dragon',  hp: 60, atk: 16, xp: 90, speed: 3, sight: 10 },
];

// ---------- Game state ----------
const game = {
  depth: 1,
  ...genDungeon(1),
  players: new Map(), // id -> player
  monsters: [],
  items: [],         // {x,y,kind} kind: 'gold'|'potion'
  tick: 0,
};

function emptyFloor() {
  for (let t = 0; t < 500; t++) {
    const x = 1 + rnd(W - 2), y = 1 + rnd(H - 2);
    if (game.grid[y][x] === FLOOR && !monsterAt(x, y) && !playerAt(x, y)) return { x, y };
  }
  return { ...game.spawn };
}

function populateLevel() {
  game.monsters = [];
  game.items = [];
  const maxKind = Math.min(MONSTERS.length - 1, Math.floor(game.depth / 1.5));
  const count = 5 + game.depth * 2;
  for (let i = 0; i < count; i++) {
    const tpl = MONSTERS[rnd(maxKind + 1)];
    const p = emptyFloor();
    game.monsters.push({ id: 'm' + game.tick + '_' + i, ...tpl, hp: tpl.hp + game.depth, maxhp: tpl.hp + game.depth, x: p.x, y: p.y, cd: 0 });
  }
  for (let i = 0; i < 4 + game.depth; i++) {
    const p = emptyFloor();
    game.items.push({ x: p.x, y: p.y, kind: rnd(3) === 0 ? 'potion' : 'gold', amt: 5 + rnd(15) });
  }
}
populateLevel();

function monsterAt(x, y) { return game.monsters.find(m => m.x === x && m.y === y && m.hp > 0); }
function playerAt(x, y) { for (const p of game.players.values()) if (p.alive && p.x === x && p.y === y) return p; }

function descend() {
  game.depth++;
  Object.assign(game, genDungeon(game.depth));
  populateLevel();
  for (const p of game.players.values()) { p.x = game.spawn.x; p.y = game.spawn.y; }
  broadcastLog(`The party descends to depth ${game.depth}!`, 'good');
}

// ---------- Combat ----------
function playerLevelUp(p) {
  while (p.xp >= p.next) {
    p.xp -= p.next;
    p.level++;
    p.next = Math.floor(p.next * 1.5);
    p.maxhp += 6; p.hp = p.maxhp; p.atk += 2;
    sendLog(p, `You reach level ${p.level}! (+HP, +ATK)`, 'good');
  }
}

function attackMonster(p, m) {
  const dmg = p.atk + rnd(3);
  m.hp -= dmg;
  sendLog(p, `You hit the ${m.name} for ${dmg}.`, 'hit');
  if (m.hp <= 0) {
    sendLog(p, `You slay the ${m.name}! +${m.xp} XP`, 'good');
    p.kills++; p.xp += m.xp; playerLevelUp(p);
  }
}

function monsterAttack(m, p) {
  const dmg = Math.max(1, m.atk + rnd(2) - rnd(2));
  p.hp -= dmg;
  sendLog(p, `The ${m.name} hits you for ${dmg}.`, 'bad');
  if (p.hp <= 0) killPlayer(p, m.name);
}

function killPlayer(p, by) {
  p.alive = false; p.hp = 0; p.deaths++;
  p.respawnAt = game.tick + 30; // ~6s at 200ms tick
  broadcastLog(`${p.name} was killed by a ${by}.`, 'bad');
}

function respawn(p) {
  p.alive = true;
  p.maxhp = 20 + (p.level - 1) * 6;
  p.hp = p.maxhp;
  const s = emptyFloor();
  p.x = s.x; p.y = s.y;
  sendLog(p, 'You awaken, restored.', 'good');
}

// ---------- Player movement (real-time, rate-limited per player) ----------
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1] };

function tryMove(p, dir) {
  if (!p.alive) return;
  const now = game.tick;
  if (now < p.moveCd) return;
  p.moveCd = now + 1; // limit to one move per tick
  const d = DIRS[dir]; if (!d) return;
  const nx = clamp(p.x + d[0], 0, W - 1), ny = clamp(p.y + d[1], 0, H - 1);
  if (game.grid[ny][nx] === WALL) return;
  const m = monsterAt(nx, ny);
  if (m) { attackMonster(p, m); return; }
  if (playerAt(nx, ny)) return; // can't stack on a teammate
  p.x = nx; p.y = ny;
  // pickups
  const ix = game.items.findIndex(it => it.x === nx && it.y === ny);
  if (ix >= 0) {
    const it = game.items[ix];
    if (it.kind === 'gold') { p.gold += it.amt; sendLog(p, `Picked up ${it.amt} gold.`, 'good'); }
    else { p.potions++; sendLog(p, 'Picked up a potion.', 'good'); }
    game.items.splice(ix, 1);
  }
  // stairs — any player can lead the descent
  if (game.grid[ny][nx] === STAIRS) descend();
}

function quaff(p) {
  if (!p.alive || p.potions <= 0) return;
  p.potions--;
  p.hp = clamp(p.hp + 15, 0, p.maxhp);
  sendLog(p, 'You quaff a potion. (+15 HP)', 'good');
}

// ---------- Monster AI tick ----------
function tickMonsters() {
  for (const m of game.monsters) {
    if (m.hp <= 0) continue;
    m.cd++;
    if (m.cd < m.speed) continue;
    m.cd = 0;
    // find nearest living player in sight
    let target = null, best = Infinity;
    for (const p of game.players.values()) {
      if (!p.alive) continue;
      const dd = dist(m, p);
      if (dd < best && dd <= m.sight) { best = dd; target = p; }
    }
    let nx = m.x, ny = m.y;
    if (target) {
      if (best === 1) { monsterAttack(m, target); continue; }
      nx += Math.sign(target.x - m.x);
      ny += Math.sign(target.y - m.y);
    } else {
      const d = pick(Object.values(DIRS)); nx += d[0]; ny += d[1];
    }
    nx = clamp(nx, 0, W - 1); ny = clamp(ny, 0, H - 1);
    if (game.grid[ny][nx] !== WALL && !monsterAt(nx, ny) && !playerAt(nx, ny)) { m.x = nx; m.y = ny; }
  }
  game.monsters = game.monsters.filter(m => m.hp > 0);
  // keep the level lively
  if (game.monsters.length < 3 + game.depth && rnd(8) === 0) {
    const tpl = MONSTERS[rnd(Math.min(MONSTERS.length, Math.floor(game.depth / 1.5) + 1))];
    const p = emptyFloor();
    game.monsters.push({ id: 'm' + game.tick, ...tpl, hp: tpl.hp + game.depth, maxhp: tpl.hp + game.depth, x: p.x, y: p.y, cd: 0 });
  }
}

// ---------- Networking ----------
const wss = new WebSocketServer({ server: http });
let nextId = 1;

function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function broadcast(obj) { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); }
function sendLog(p, text, cls) { if (p.ws) send(p.ws, { t: 'log', text, cls }); }
function broadcastLog(text, cls) { broadcast({ t: 'log', text, cls }); }

const COLORS = ['#4ec9ff', '#ffd24e', '#7CFC00', '#ff6ec7', '#ff8c42', '#b07cff', '#52ffb8'];

wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  let player = null;

  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }

    if (msg.t === 'join') {
      const name = String(msg.name || 'Hero').slice(0, 14).replace(/[^\w \-]/g, '') || 'Hero';
      const s = game.spawn;
      player = {
        id, ws, name, alive: true,
        x: s.x, y: s.y, color: COLORS[(nextId) % COLORS.length],
        hp: 20, maxhp: 20, atk: 4, level: 1, xp: 0, next: 20,
        gold: 0, potions: 1, kills: 0, deaths: 0, moveCd: 0, respawnAt: 0,
      };
      // spawn on a free tile near the entrance
      const free = emptyFloor(); player.x = free.x; player.y = free.y;
      game.players.set(id, player);
      send(ws, { t: 'welcome', id, w: W, h: H });
      broadcastLog(`${player.name} entered the dungeon.`, 'good');
      return;
    }
    if (!player) return;

    if (msg.t === 'move') tryMove(player, msg.dir);
    else if (msg.t === 'quaff') quaff(player);
    else if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 120);
      if (text) broadcast({ t: 'chat', name: player.name, color: player.color, text });
    }
  });

  ws.on('close', () => {
    if (player) {
      game.players.delete(id);
      broadcastLog(`${player.name} left the dungeon.`, 'bad');
    }
  });
});

// ---------- Main loop: tick monsters + broadcast snapshot ----------
const TICK_MS = 200;
setInterval(() => {
  game.tick++;
  tickMonsters();
  // respawn timers
  for (const p of game.players.values()) {
    if (!p.alive && game.tick >= p.respawnAt) respawn(p);
  }
  // snapshot — send the whole shared state (small enough for this scale)
  const snap = {
    t: 'state',
    depth: game.depth,
    grid: game.grid.map(r => r.join('')),
    monsters: game.monsters.map(m => ({ x: m.x, y: m.y, g: m.g, hp: m.hp, maxhp: m.maxhp, name: m.name })),
    items: game.items.map(it => ({ x: it.x, y: it.y, kind: it.kind })),
    players: [...game.players.values()].map(p => ({
      id: p.id, name: p.name, x: p.x, y: p.y, color: p.color, alive: p.alive,
      hp: p.hp, maxhp: p.maxhp, level: p.level, gold: p.gold, potions: p.potions,
      kills: p.kills, deaths: p.deaths, xp: p.xp, next: p.next, atk: p.atk,
    })),
  };
  broadcast(snap);
}, TICK_MS);

http.listen(PORT, () => console.log(`MultiRogue running at http://localhost:${PORT}`));
