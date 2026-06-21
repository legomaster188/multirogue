// MultiRogue — authoritative multiplayer roguelike server.
// Modeled on the original Rogue: persistent multi-level dungeon, lit-room
// field-of-view, a hunger clock, weapons/armor with armor class, traps,
// stairs up/down, and the Amulet of Yendor as the win condition.
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

// ---------- helpers ----------
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rnd(a.length)];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const chebyshev = (a, b) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

// ---------- map tiles ----------
const W = 60, H = 34;
const WALL = '#', FLOOR = '.', DOWN = '>', UP = '<';
const AMULET_DEPTH = 8;          // Amulet of Yendor lives this deep
let amuletSpawned = false;       // there is only ever one

// ---------- dungeon generation: rooms + corridors ----------
function genLevel(depth) {
  const grid = Array.from({ length: H }, () => Array(W).fill(WALL));
  const rooms = [];
  for (let i = 0; i < 80 && rooms.length < 12; i++) {
    const rw = 4 + rnd(8), rh = 3 + rnd(5);
    const rx = 1 + rnd(W - rw - 1), ry = 1 + rnd(H - rh - 1);
    if (rooms.some(o => rx < o.x + o.w + 1 && rx + rw + 1 > o.x && ry < o.y + o.h + 1 && ry + rh + 1 > o.y)) continue;
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) grid[y][x] = FLOOR;
    rooms.push({ x: rx, y: ry, w: rw, h: rh, cx: rx + (rw >> 1), cy: ry + (rh >> 1) });
  }
  const carveH = (x1, x2, y) => { for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) grid[y][x] = FLOOR; };
  const carveV = (y1, y2, x) => { for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) grid[y][x] = FLOOR; };
  for (let i = 1; i < rooms.length; i++) {
    const a = rooms[i - 1], b = rooms[i];
    if (rnd(2)) { carveH(a.cx, b.cx, a.cy); carveV(a.cy, b.cy, b.cx); }
    else { carveV(a.cy, b.cy, a.cx); carveH(a.cx, b.cx, b.cy); }
  }
  const first = rooms[0] || { cx: W >> 1, cy: H >> 1 };
  const last = rooms[rooms.length - 1] || first;
  // up-stairs at entrance, down-stairs at the far room (depth 1's up-stairs is the exit)
  grid[first.cy][first.cx] = UP;
  if (depth < AMULET_DEPTH + 12) grid[last.cy][last.cx] = DOWN; // a floor below the amulet still exists

  const level = {
    depth, grid, rooms,
    up: { x: first.cx, y: first.cy },
    down: { x: last.cx, y: last.cy },
    monsters: [], items: [], traps: [],
  };
  populate(level);
  return level;
}

function freeTile(level, avoidPlayers = true) {
  for (let t = 0; t < 600; t++) {
    const x = 1 + rnd(W - 2), y = 1 + rnd(H - 2);
    if (level.grid[y][x] !== FLOOR) continue;
    if (monsterAt(level, x, y)) continue;
    if (avoidPlayers && playerAt(level.depth, x, y)) continue;
    return { x, y };
  }
  return { ...level.up };
}

// ---------- monsters (Rogue-style letters), gated + scaled by depth ----------
const MONSTERS = [
  { g: 'b', name: 'bat',     hp: 4,  atk: 1,  xp: 2,  speed: 2, sight: 6,  minD: 1 },
  { g: 'r', name: 'rat',     hp: 6,  atk: 2,  xp: 3,  speed: 2, sight: 5,  minD: 1 },
  { g: 'k', name: 'kobold',  hp: 9,  atk: 3,  xp: 6,  speed: 2, sight: 7,  minD: 2 },
  { g: 's', name: 'snake',   hp: 12, atk: 4,  xp: 9,  speed: 3, sight: 6,  minD: 3 },
  { g: 'o', name: 'orc',     hp: 16, atk: 6,  xp: 14, speed: 3, sight: 7,  minD: 4 },
  { g: 'z', name: 'zombie',  hp: 24, atk: 7,  xp: 20, speed: 4, sight: 6,  minD: 5 },
  { g: 'T', name: 'troll',   hp: 32, atk: 10, xp: 35, speed: 4, sight: 8,  minD: 6 },
  { g: 'D', name: 'dragon',  hp: 60, atk: 16, xp: 90, speed: 3, sight: 10, minD: 8 },
];
let monNo = 0;

function spawnMonster(level) {
  const eligible = MONSTERS.filter(m => m.minD <= level.depth);
  const tpl = pick(eligible.length ? eligible : [MONSTERS[0]]);
  const p = freeTile(level);
  const hp = tpl.hp + level.depth * 2;
  level.monsters.push({ id: 'm' + (monNo++), g: tpl.g, name: tpl.name, atk: tpl.atk + Math.floor(level.depth / 2),
    xp: tpl.xp, speed: tpl.speed, sight: tpl.sight, hp, maxhp: hp, x: p.x, y: p.y, cd: rnd(tpl.speed) });
}

// ---------- items ----------
const WEAPONS = ['', 'dagger', 'short sword', 'mace', 'long sword', 'battle axe', 'war hammer', 'rune blade'];
const ARMORS  = ['', 'leather armor', 'studded leather', 'ring mail', 'chain mail', 'banded mail', 'plate mail'];

function makeWeapon(depth) { const b = clamp(1 + rnd(2) + Math.floor(depth / 2), 1, WEAPONS.length - 1); return { kind: 'weapon', bonus: b, name: WEAPONS[b] }; }
function makeArmor(depth)  { const b = clamp(1 + rnd(2) + Math.floor(depth / 2), 1, ARMORS.length - 1);  return { kind: 'armor',  bonus: b, name: ARMORS[b] }; }

function populate(level) {
  const monCount = 5 + level.depth * 2;
  for (let i = 0; i < monCount; i++) spawnMonster(level);

  const drop = (it) => { const p = freeTile(level); level.items.push({ x: p.x, y: p.y, ...it }); };
  for (let i = 0; i < 3 + level.depth; i++) drop({ kind: 'gold', amt: 5 + rnd(10 + level.depth * 4) });
  for (let i = 0; i < 2 + (level.depth >> 1); i++) drop({ kind: 'potion' });
  for (let i = 0; i < 2; i++) drop({ kind: 'food' });
  for (let i = 0; i < 1 + (level.depth >> 2); i++) drop({ kind: rnd(2) ? 'scroll_map' : 'scroll_tele' });
  if (rnd(2) === 0) drop(makeWeapon(level.depth));
  if (rnd(2) === 0) drop(makeArmor(level.depth));

  for (let i = 0; i < level.depth; i++) {
    const p = freeTile(level);
    if (level.grid[p.y][p.x] !== FLOOR) continue;
    level.traps.push({ x: p.x, y: p.y, kind: rnd(3) === 0 ? 'teleport' : 'dart', known: false, dmg: 3 + rnd(level.depth * 2) });
  }

  if (level.depth === AMULET_DEPTH && !amuletSpawned) {
    amuletSpawned = true;
    const p = freeTile(level);
    level.items.push({ x: p.x, y: p.y, kind: 'amulet' });
    // the Yendor Warden guards the Amulet
    const b = freeTileNear(level, p);
    const hp = 140 + level.depth * 5;
    level.monsters.push({ id: 'boss' + (monNo++), g: 'W', name: 'Yendor Warden', atk: 18, xp: 400,
      speed: 2, sight: 12, hp, maxhp: hp, x: b.x, y: b.y, cd: 0, boss: true });
  }
}

// ---------- world state ----------
const levels = new Map();        // depth -> level
const players = new Map();        // id -> player
let tick = 0;
function getLevel(depth) { if (!levels.has(depth)) levels.set(depth, genLevel(depth)); return levels.get(depth); }
getLevel(1);

function monsterAt(level, x, y) { return level.monsters.find(m => m.x === x && m.y === y && m.hp > 0); }
function playerAt(depth, x, y) { for (const p of players.values()) if (p.alive && p.depth === depth && p.x === x && p.y === y) return p; }
function trapAt(level, x, y) { return level.traps.find(t => t.x === x && t.y === y); }

// ---------- networking primitives ----------
const wss = new WebSocketServer({ server: http });
let nextId = 1;
const send = (ws, obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const broadcast = (obj) => { const s = JSON.stringify(obj); for (const c of wss.clients) if (c.readyState === 1) c.send(s); };
const sendLog = (p, text, cls) => send(p.ws, { t: 'log', text, cls });
const broadcastLog = (text, cls) => broadcast({ t: 'log', text, cls });
const broadcastFx = (depth, obj) => { for (const p of players.values()) if (p.depth === depth) send(p.ws, obj); };
const COLORS = ['#4ec9ff', '#ffd24e', '#7CFC00', '#ff6ec7', '#ff8c42', '#b07cff', '#52ffb8', '#ff5d5d'];

// ---------- hunger ----------
const HUNGER_MAX = 1300;
function hungerState(h) {
  if (h <= 0) return 'Starving';
  if (h < 150) return 'Weak';
  if (h < 350) return 'Hungry';
  return 'Sated';
}

// ---------- classes ----------
const CLASSES = {
  warrior: { label: 'Warrior', hp: 32, atk: 6, armor: 2, weapon: 1, ranged: false },
  mage:    { label: 'Mage',    hp: 16, atk: 3, armor: 0, weapon: 0, ranged: true, rdmg: 9, rrange: 7, rcd: 5, ammo: 'magic bolt' },
  ranger:  { label: 'Ranger',  hp: 22, atk: 4, armor: 1, weapon: 1, ranged: true, rdmg: 5, rrange: 9, rcd: 2, ammo: 'arrow' },
};

// ---------- player lifecycle ----------
function makePlayer(id, ws, name, clsKey) {
  const cls = CLASSES[clsKey] ? clsKey : 'warrior';
  const c = CLASSES[cls];
  const lvl = getLevel(1);
  const s = freeTileNear(lvl, lvl.up);
  return {
    id, ws, name, color: COLORS[nextId % COLORS.length],
    cls, className: c.label,
    depth: 1, x: s.x, y: s.y, alive: true,
    baseHp: c.hp, hp: c.hp, maxhp: c.hp, atk: c.atk, level: 1, xp: 0, next: 20,
    gold: 0, potions: 1, rations: 1, scrollMap: 1, scrollTele: 0, hunger: HUNGER_MAX,
    weaponBonus: c.weapon, weaponName: c.weapon ? WEAPONS[c.weapon] : 'bare fists',
    armorBonus: c.armor, armorName: c.armor ? ARMORS[c.armor] : 'no armor',
    ranged: c.ranged, rdmg: c.rdmg || 0, rrange: c.rrange || 0, rcd: c.rcd || 0,
    ammoName: c.ammo || '', fireCd: 0,
    poison: 0, hasAmulet: false, won: false,
    downed: false, downedUntil: 0,
    kills: 0, deaths: 0, moveCd: 0,
    explored: {},   // depth -> Set of tile indices
  };
}

function freeTileNear(level, near) {
  for (let r = 0; r < 8; r++) {
    for (let t = 0; t < 12; t++) {
      const x = clamp(near.x + rnd(r * 2 + 1) - r, 1, W - 2);
      const y = clamp(near.y + rnd(r * 2 + 1) - r, 1, H - 2);
      if (level.grid[y][x] === FLOOR && !monsterAt(level, x, y) && !playerAt(level.depth, x, y)) return { x, y };
    }
  }
  return freeTile(level);
}

// A fallen hero is "downed" — an ally can revive them in time; otherwise they die.
function downPlayer(p, by) {
  if (!p.alive) return;
  p.alive = false; p.hp = 0; p.poison = 0;
  p.downed = true; p.downedUntil = tick + 90;   // ~18s window
  const lvl = getLevel(p.depth);
  if (p.hasAmulet) { // drop the Amulet where you fell so it can be recovered
    p.hasAmulet = false;
    lvl.items.push({ x: p.x, y: p.y, kind: 'amulet' });
    broadcastLog(`${p.name} fell carrying the Amulet — it lies on depth ${p.depth}!`, 'bad');
  }
  broadcastLog(`${p.name} has fallen to ${by} on depth ${p.depth}! An ally can revive them (move beside them) within 18s.`, 'bad');
}

function finalDeath(p) {
  p.downed = false; p.deaths++;
  const lost = Math.floor(p.gold / 2); p.gold -= lost;
  respawn(p);
  broadcastLog(`${p.name} perished and returns to the entrance. (lost ${lost} gold)`, 'bad');
}

function revive(rescuer, p) {
  p.alive = true; p.downed = false;
  p.hp = Math.floor(p.maxhp / 2);
  p.hunger = Math.max(p.hunger, 300);
  sendLog(p, `${rescuer.name} pulls you back from death!`, 'good');
  broadcastLog(`${rescuer.name} revived ${p.name}!`, 'good');
}

function respawn(p) {
  p.alive = true;
  p.depth = 1;
  p.maxhp = p.baseHp + (p.level - 1) * 6;
  p.hp = p.maxhp;
  p.hunger = Math.max(p.hunger, 400);
  const lvl = getLevel(1);
  const s = freeTileNear(lvl, lvl.up);
  p.x = s.x; p.y = s.y;
  sendLog(p, 'You awaken at the dungeon entrance, restored.', 'good');
}

function downedAt(depth, x, y) { for (const p of players.values()) if (p.downed && p.depth === depth && p.x === x && p.y === y) return p; }

// ---------- progression ----------
function levelUp(p) {
  while (p.xp >= p.next) {
    p.xp -= p.next; p.level++; p.next = Math.floor(p.next * 1.6);
    p.maxhp += 6; p.hp = p.maxhp; p.atk += 2;
    sendLog(p, `Welcome to level ${p.level}! (+6 HP, +2 ATK)`, 'good');
  }
}

// ---------- combat ----------
function damageMonster(p, m, dmg, verb) {
  m.hp -= dmg;
  sendLog(p, `${verb} the ${m.name} for ${dmg}.`, 'hit');
  if (m.hp <= 0) {
    sendLog(p, `You have defeated the ${m.name}! +${m.xp} XP`, 'good');
    p.kills++; p.xp += m.xp; levelUp(p);
    const lvl = getLevel(p.depth);
    lvl.monsters = lvl.monsters.filter(x => x !== m);  // remove immediately
    if (m.boss) broadcastLog(`${p.name} has slain the ${m.name}!`, 'good');
    if (m.boss || rnd(2) === 0) lvl.items.push({ x: m.x, y: m.y, kind: 'gold', amt: (m.boss ? 100 : 0) + 3 + rnd(5 + p.depth * 3) });
  }
}

function playerAttack(p, m) { damageMonster(p, m, p.atk + p.weaponBonus + rnd(3), 'You hit'); }

function fireBolt(p) {
  if (!p.alive) return;
  if (!p.ranged) { sendLog(p, 'You have no ranged weapon.', 'sys'); return; }
  if (tick < p.fireCd) { sendLog(p, 'Your ranged attack is not ready.', 'sys'); return; }
  const lvl = getLevel(p.depth);
  const vis = computeVisible(lvl, p.x, p.y);
  let target = null, best = Infinity;
  for (const m of lvl.monsters) {
    if (m.hp <= 0 || !vis.has(m.y * W + m.x)) continue;
    const dd = chebyshev(p, m);
    if (dd <= p.rrange && dd < best) { best = dd; target = m; }
  }
  if (!target) { sendLog(p, 'No target in sight.', 'sys'); return; }
  p.fireCd = tick + p.rcd;
  broadcastFx(p.depth, { t: 'fx', kind: 'bolt', color: p.color, from: { x: p.x, y: p.y }, to: { x: target.x, y: target.y } });
  damageMonster(p, target, p.rdmg + Math.floor(p.level / 2) + rnd(3), `Your ${p.ammoName} strikes`);
}

function monsterAttack(m, p) {
  let dmg = m.atk + rnd(3) - p.armorBonus;      // armor class soaks damage
  dmg = Math.max(1, dmg);
  p.hp -= dmg;
  sendLog(p, `The ${m.name} hits you for ${dmg}.`, 'bad');
  if (p.hp <= 0) { downPlayer(p, `a ${m.name}`); return; }
  if (m.g === 's' && rnd(2) === 0) { p.poison = Math.max(p.poison, 6); sendLog(p, 'The snake bite poisons you!', 'bad'); }
}

// ---------- movement & actions ----------
const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
  upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1] };

function tryMove(p, dir) {
  if (!p.alive || tick < p.moveCd) return;
  const d = DIRS[dir]; if (!d) return;
  p.moveCd = tick + 1;
  const lvl = getLevel(p.depth);
  const nx = clamp(p.x + d[0], 0, W - 1), ny = clamp(p.y + d[1], 0, H - 1);
  if (lvl.grid[ny][nx] === WALL) return;
  const m = monsterAt(lvl, nx, ny);
  if (m) { playerAttack(p, m); return; }
  const fallen = downedAt(p.depth, nx, ny);
  if (fallen) { revive(p, fallen); p.moveCd = tick + 3; return; }   // revive an ally instead of stepping in
  if (playerAt(p.depth, nx, ny)) return;     // don't stack on a teammate
  p.x = nx; p.y = ny;
  pickup(p, lvl);
  triggerTrap(p, lvl);
}

function pickup(p, lvl) {
  const ix = lvl.items.findIndex(it => it.x === p.x && it.y === p.y);
  if (ix < 0) return;
  const it = lvl.items[ix];
  if (it.kind === 'gold') { p.gold += it.amt; sendLog(p, `You found ${it.amt} gold.`, 'good'); }
  else if (it.kind === 'potion') { p.potions++; sendLog(p, 'You pick up a healing potion.', 'good'); }
  else if (it.kind === 'food') { p.rations++; sendLog(p, 'You pick up a food ration.', 'good'); }
  else if (it.kind === 'scroll_map') { p.scrollMap++; sendLog(p, 'You pick up a scroll of magic mapping.', 'good'); }
  else if (it.kind === 'scroll_tele') { p.scrollTele++; sendLog(p, 'You pick up a scroll of teleportation.', 'good'); }
  else if (it.kind === 'amulet') { p.hasAmulet = true; broadcastLog(`${p.name} has claimed the Amulet of Yendor! Return to the surface!`, 'good'); }
  else if (it.kind === 'weapon') {
    if (it.bonus > p.weaponBonus) { p.weaponBonus = it.bonus; p.weaponName = it.name; sendLog(p, `You wield the ${it.name} (+${it.bonus} ATK).`, 'good'); }
    else { sendLog(p, `You leave the ${it.name}; your ${p.weaponName} is better.`, 'sys'); return; }
  } else if (it.kind === 'armor') {
    if (it.bonus > p.armorBonus) { p.armorBonus = it.bonus; p.armorName = it.name; sendLog(p, `You don the ${it.name} (+${it.bonus} AC).`, 'good'); }
    else { sendLog(p, `You leave the ${it.name}; your ${p.armorName} is better.`, 'sys'); return; }
  }
  lvl.items.splice(ix, 1);
}

function triggerTrap(p, lvl) {
  const tr = trapAt(lvl, p.x, p.y);
  if (!tr) return;
  tr.known = true;
  if (tr.kind === 'teleport') {
    const s = freeTile(lvl);
    p.x = s.x; p.y = s.y;
    sendLog(p, 'A trap door! You are teleported across the level.', 'bad');
  } else {
    p.hp -= tr.dmg;
    sendLog(p, `A dart trap springs! You take ${tr.dmg} damage.`, 'bad');
    if (p.hp <= 0) downPlayer(p, 'a trap');
  }
}

function readMap(p) {
  if (!p.alive || p.scrollMap <= 0) { sendLog(p, 'You have no scroll of magic mapping.', 'sys'); return; }
  p.scrollMap--;
  const exp = p.explored[p.depth] || (p.explored[p.depth] = new Set());
  for (let i = 0; i < W * H; i++) exp.add(i);
  sendLog(p, 'You read a scroll of magic mapping — the level is revealed.', 'good');
}

function readTele(p) {
  if (!p.alive || p.scrollTele <= 0) { sendLog(p, 'You have no scroll of teleportation.', 'sys'); return; }
  p.scrollTele--;
  const lvl = getLevel(p.depth);
  const s = freeTile(lvl);
  p.x = s.x; p.y = s.y;
  sendLog(p, 'You read a scroll of teleportation and blink away.', 'good');
}

function quaff(p) {
  if (!p.alive || p.potions <= 0) return;
  p.potions--;
  const heal = 15 + p.level * 2;
  p.hp = clamp(p.hp + heal, 0, p.maxhp);
  sendLog(p, `You quaff a potion of healing. (+${heal} HP)`, 'good');
}

function eat(p) {
  if (!p.alive || p.rations <= 0) return;
  if (p.hunger > HUNGER_MAX - 200) { sendLog(p, 'You are too full to eat.', 'sys'); return; }
  p.rations--;
  p.hunger = clamp(p.hunger + 700, 0, HUNGER_MAX);
  sendLog(p, 'You eat a food ration.', 'good');
}

function useStairs(p, want) {
  if (!p.alive) return;
  const lvl = getLevel(p.depth);
  const here = lvl.grid[p.y][p.x];
  if (want === 'down') {
    if (here !== DOWN) { sendLog(p, 'There are no down-stairs here.', 'sys'); return; }
    const nd = getLevel(p.depth + 1);
    p.depth += 1; p.x = nd.up.x; p.y = nd.up.y;
    sendLog(p, `You descend to depth ${p.depth}.`, 'good');
  } else { // up
    if (here !== UP) { sendLog(p, 'There are no up-stairs here.', 'sys'); return; }
    if (p.depth === 1) {
      if (p.hasAmulet) winGame(p);
      else sendLog(p, 'The dungeon exit is sealed. Only the Amulet of Yendor can open it.', 'bad');
      return;
    }
    const nd = getLevel(p.depth - 1);
    p.depth -= 1; p.x = nd.down.x; p.y = nd.down.y;
    sendLog(p, `You climb to depth ${p.depth}.`, 'good');
  }
}

function winGame(p) {
  p.won = true;
  const score = p.gold + p.level * 100 + p.kills * 25 + 1000;
  broadcastLog(`🏆 ${p.name} escaped the dungeon with the Amulet of Yendor! VICTORY! (score ${score})`, 'good');
  send(p.ws, { t: 'win', score });
  // recycle the amulet so the quest can continue
  amuletSpawned = false;
  p.hasAmulet = false;
}

// ---------- monster AI (only on floors that have players) ----------
function tickMonsters(level) {
  for (const m of level.monsters) {
    if (m.hp <= 0) continue;
    if (++m.cd < m.speed) continue;
    m.cd = 0;
    let target = null, best = Infinity;
    for (const p of players.values()) {
      if (!p.alive || p.depth !== level.depth) continue;
      const dd = chebyshev(m, p);
      if (dd < best && dd <= m.sight) { best = dd; target = p; }
    }
    let nx = m.x, ny = m.y;
    if (target) {
      if (best === 1) { monsterAttack(m, target); continue; }
      nx += Math.sign(target.x - m.x); ny += Math.sign(target.y - m.y);
    } else {
      const d = pick(Object.values(DIRS)); nx += d[0]; ny += d[1];
    }
    nx = clamp(nx, 0, W - 1); ny = clamp(ny, 0, H - 1);
    if (level.grid[ny][nx] !== WALL && !monsterAt(level, nx, ny) && !playerAt(level.depth, nx, ny) && !downedAt(level.depth, nx, ny)) { m.x = nx; m.y = ny; }
  }
  level.monsters = level.monsters.filter(m => m.hp > 0);
  if (level.monsters.length < 3 + level.depth && rnd(10) === 0) spawnMonster(level);
}

// ---------- field of view: Rogue-style lit rooms + a small radius in corridors ----------
function computeVisible(level, px, py) {
  const vis = new Set();
  const room = level.rooms.find(r => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h);
  if (room) {
    for (let y = room.y - 1; y <= room.y + room.h; y++)
      for (let x = room.x - 1; x <= room.x + room.w; x++)
        if (x >= 0 && y >= 0 && x < W && y < H) vis.add(y * W + x);
  }
  for (let y = py - 1; y <= py + 1; y++)
    for (let x = px - 1; x <= px + 1; x++)
      if (x >= 0 && y >= 0 && x < W && y < H) vis.add(y * W + x);
  return vis;
}

// ---------- connection handling ----------
wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  let player = null;
  ws.on('message', (buf) => {
    let msg; try { msg = JSON.parse(buf); } catch { return; }
    if (msg.t === 'join') {
      const name = String(msg.name || 'Hero').slice(0, 14).replace(/[^\w \-]/g, '') || 'Hero';
      player = makePlayer(id, ws, name, msg.cls);
      players.set(id, player);
      send(ws, { t: 'welcome', id, w: W, h: H, amuletDepth: AMULET_DEPTH });
      broadcastLog(`${name} the ${player.className} enters the dungeon.`, 'good');
      return;
    }
    if (!player) return;
    if (msg.t === 'move') tryMove(player, msg.dir);
    else if (msg.t === 'fire') fireBolt(player);
    else if (msg.t === 'quaff') quaff(player);
    else if (msg.t === 'eat') eat(player);
    else if (msg.t === 'readmap') readMap(player);
    else if (msg.t === 'readtele') readTele(player);
    else if (msg.t === 'descend') useStairs(player, 'down');
    else if (msg.t === 'ascend') useStairs(player, 'up');
    else if (msg.t === 'chat') {
      const text = String(msg.text || '').slice(0, 120);
      if (text) broadcast({ t: 'chat', name: player.name, color: player.color, text });
    }
  });
  ws.on('close', () => { if (player) { players.delete(id); broadcastLog(`${player.name} left the dungeon.`, 'bad'); } });
});

// ---------- per-player snapshot ----------
const ITEM_GLYPH = { gold: '$', potion: '!', food: '%', weapon: ')', armor: '[', amulet: '"', scroll_map: '?', scroll_tele: '?' };

function snapshotFor(p) {
  const lvl = getLevel(p.depth);
  const vis = computeVisible(lvl, p.x, p.y);
  let exp = p.explored[p.depth];
  if (!exp) { exp = new Set(); p.explored[p.depth] = exp; }
  for (const i of vis) exp.add(i);

  // grid rows with known traps overlaid, plus a visibility mask (0 unseen,1 explored,2 visible)
  const grid = [], mask = [];
  for (let y = 0; y < H; y++) {
    let grow = '', mrow = '';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let ch = lvl.grid[y][x];
      const tr = trapAt(lvl, x, y);
      if (tr && tr.known) ch = '^';
      grow += ch;
      mrow += vis.has(i) ? '2' : exp.has(i) ? '1' : '0';
    }
    grid.push(grow); mask.push(mrow);
  }

  const visM = lvl.monsters.filter(m => vis.has(m.y * W + m.x)).map(m => ({ x: m.x, y: m.y, g: m.g, name: m.name, boss: !!m.boss }));
  const visI = lvl.items.filter(it => vis.has(it.y * W + it.x)).map(it => ({ x: it.x, y: it.y, g: ITEM_GLYPH[it.kind] }));
  const others = [...players.values()].filter(o => o.depth === p.depth && (o.alive || o.downed) && vis.has(o.y * W + o.x))
    .map(o => ({ x: o.x, y: o.y, me: o.id === p.id, color: o.color, name: o.name, downed: !o.alive && o.downed }));

  const roster = [...players.values()].sort((a, b) => b.kills - a.kills).map(o => ({
    name: o.name, color: o.color, className: o.className, level: o.level, kills: o.kills, gold: o.gold,
    depth: o.depth, alive: o.alive, downed: o.downed, amulet: o.hasAmulet, me: o.id === p.id,
  }));

  return {
    t: 'state', depth: p.depth, w: W, h: H, grid, mask,
    monsters: visM, items: visI, others, roster,
    me: {
      hp: Math.max(0, p.hp), maxhp: p.maxhp, atk: p.atk, weaponBonus: p.weaponBonus, weaponName: p.weaponName,
      armorBonus: p.armorBonus, armorName: p.armorName, level: p.level, xp: p.xp, next: p.next,
      gold: p.gold, potions: p.potions, rations: p.rations, scrollMap: p.scrollMap, scrollTele: p.scrollTele,
      hunger: p.hunger, hungerMax: HUNGER_MAX, hungerState: hungerState(p.hunger),
      depth: p.depth, kills: p.kills, deaths: p.deaths, className: p.className,
      alive: p.alive, hasAmulet: p.hasAmulet, poisoned: p.poison > 0,
      ranged: p.ranged, fireReady: p.ranged && tick >= p.fireCd,
      downed: p.downed, downedLeft: p.downed ? Math.max(0, Math.ceil((p.downedUntil - tick) * TICK_MS / 1000)) : 0,
      onStairs: p.alive ? (lvl.grid[p.y][p.x] === DOWN ? 'down' : lvl.grid[p.y][p.x] === UP ? 'up' : null) : null,
    },
  };
}

// ---------- main loop ----------
const TICK_MS = 200;
setInterval(() => {
  tick++;
  // monster AI on populated floors only
  const activeDepths = new Set([...players.values()].filter(p => p.alive).map(p => p.depth));
  for (const d of activeDepths) tickMonsters(getLevel(d));

  // status effects, hunger, and downed-timer
  for (const p of players.values()) {
    if (p.alive) {
      if (p.poison > 0 && tick % 3 === 0) {
        p.hp -= 2; p.poison--;
        if (p.hp <= 0) { downPlayer(p, 'poison'); continue; }
        sendLog(p, 'The poison courses through you.', 'bad');
      }
      p.hunger = Math.max(0, p.hunger - 1);
      if (p.hunger <= 0 && tick % 5 === 0) {
        p.hp -= 1;
        if (p.hp <= 0) downPlayer(p, 'starvation');
        else sendLog(p, 'You are starving!', 'bad');
      }
    } else if (p.downed && tick >= p.downedUntil) finalDeath(p);
  }

  for (const p of players.values()) send(p.ws, snapshotFor(p));
}, TICK_MS);

http.listen(PORT, () => console.log(`MultiRogue running at http://localhost:${PORT}`));
