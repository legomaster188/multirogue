// Co-op test: two heroes descend together to a lethal depth; the mage dives until
// downed; the warrior revives them. Also confirms ranged fire lands a hit.
import { WebSocket } from 'ws';
const W = 60, H = 34, TARGET = 5;
const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
  upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1] };
const r = { ranged_hit: false, downed_seen: false, revived: false };

class Bot {
  constructor(name, cls, role) {
    this.name = name; this.role = role; this.id = null; this.depth = 1;
    this.known = Array.from({ length: H }, () => Array(W).fill(' '));
    this.me = null; this.others = []; this.monsters = []; this.mask = null;
    this.ws = new WebSocket('ws://localhost:3000');
    this.ws.on('open', () => this.send({ t: 'join', name, cls }));
    this.ws.on('message', (b) => this.onMsg(JSON.parse(b)));
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  onMsg(m) {
    if (m.t === 'welcome') this.id = m.id;
    if (m.t === 'log' && /strikes the/.test(m.text)) r.ranged_hit = true;
    if (m.t !== 'state') return;
    if (m.depth !== this.depth) { this.depth = m.depth; this.known = Array.from({ length: H }, () => Array(W).fill(' ')); }
    this.me = m.me; this.others = m.others; this.monsters = m.monsters; this.mask = m.mask;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y][x] !== '0') this.known[y][x] = m.grid[y][x];
  }
  pos() { const o = this.others.find(o => o.me); return o ? { x: o.x, y: o.y } : null; }
  walk(x, y) { const c = this.known[y]?.[x]; return c === '.' || c === '>' || c === '<' || c === '^'; }
  // BFS: first step toward nearest tile satisfying test(x,y); else toward unknown frontier
  stepTo(test) {
    const me = this.pos(); if (!me) return;
    const seen = Array.from({ length: H }, () => Array(W).fill(false));
    const q = [{ x: me.x, y: me.y, first: null }]; seen[me.y][me.x] = true;
    let frontier = null;
    while (q.length) {
      const cur = q.shift();
      if ((cur.x !== me.x || cur.y !== me.y) && test(cur.x, cur.y)) return this.send({ t: 'move', dir: cur.first });
      for (const [dir, d] of Object.entries(DIRS)) {
        const nx = cur.x + d[0], ny = cur.y + d[1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx]) continue;
        if (!this.walk(nx, ny)) { if (this.known[ny][nx] === ' ' && !frontier) frontier = cur.first || dir; continue; }
        seen[ny][nx] = true; q.push({ x: nx, y: ny, first: cur.first || dir });
      }
    }
    if (frontier) this.send({ t: 'move', dir: frontier });
  }
  adjacentMonster() { const me = this.pos(); return me && this.monsters.find(mo => Math.abs(mo.x-me.x)<=1 && Math.abs(mo.y-me.y)<=1); }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const heal = new Bot('Healer', 'warrior', 'healer');
const diver = new Bot('Diver', 'mage', 'diver');
await sleep(1200);

for (let t = 0; t < 700; t++) {
  for (const bot of [heal, diver]) {
    if (!bot.me) continue;
    if (bot.me.downed) continue;                       // wait to be rescued / respawn
    if (bot.role === 'diver' && bot.monsters.length) bot.send({ t: 'fire' });  // fire whenever a foe is in sight
    if (bot.depth < TARGET) {                          // descend together
      if (bot.me.onStairs === 'down') bot.send({ t: 'descend' });
      else bot.stepTo((x, y) => bot.known[y][x] === '>');
      continue;
    }
    if (bot.role === 'diver') {
      bot.send({ t: 'fire' });                          // chip ranged hits along the way
      if (bot.adjacentMonster()) { const m = bot.adjacentMonster(); const me = bot.pos();
        bot.send({ t: 'move', dir: dirTo(me, m) }); }   // ram it (attack) — mage is fragile
      else bot.stepTo((x, y) => bot.monsters.some(mo => mo.x === x && mo.y === y));
    } else { // healer: revive a downed ally if visible, else stay near the diver
      const fallen = heal.others.find(o => o.downed);
      if (fallen) heal.stepTo((x, y) => x === fallen.x && y === fallen.y);
      else heal.stepTo((x, y) => heal.monsters.some(mo => mo.x === x && mo.y === y) === false && false); // idle
    }
  }
  if (diver.me?.downed) r.downed_seen = true;
  if (r.downed_seen && diver.me?.alive && !diver.me?.downed) { r.revived = true; break; }
  await sleep(170);
}

function dirTo(a, b) {
  const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
  if (dx && dy) return dy < 0 ? (dx < 0 ? 'upleft' : 'upright') : (dx < 0 ? 'downleft' : 'downright');
  return dx ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
}

console.log(JSON.stringify(r, null, 2));
const ok = r.ranged_hit && r.downed_seen && r.revived;
console.log(ok ? 'PASS ✅ ranged combat + downed/revive co-op all work' : 'FAIL ❌ (see flags)');
try { heal.ws.close(); diver.ws.close(); } catch {}
process.exit(ok ? 0 : 1);
