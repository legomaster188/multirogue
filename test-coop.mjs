// Co-op test (deterministic). Requires the server started with MR_TEST=1.
// Diver (mage) explores depth 1, fires to confirm ranged combat, then takes a fatal
// test-only hit; the Healer (warrior) walks to the fallen ally and revives them.
import { WebSocket } from 'ws';
const W = 60, H = 34;
const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
  upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1] };
const r = { ranged_hit: false, downed_seen: false, revived: false };

class Bot {
  constructor(name, cls, role) {
    this.role = role; this.id = null; this.depth = 1;
    this.known = Array.from({ length: H }, () => Array(W).fill(' '));
    this.me = null; this.others = []; this.monsters = [];
    this.ws = new WebSocket('ws://localhost:3000');
    this.ws.on('open', () => this.send({ t: 'join', name, cls }));
    this.ws.on('message', (b) => this.onMsg(JSON.parse(b)));
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  onMsg(m) {
    if (m.t === 'welcome') this.id = m.id;
    if (m.t === 'log' && /strikes the/.test(m.text)) r.ranged_hit = true;
    if (m.t !== 'state') return;
    this.me = m.me; this.others = m.others; this.monsters = m.monsters;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y][x] !== '0') this.known[y][x] = m.grid[y][x];
  }
  pos() { const o = this.others.find(o => o.me); return o ? { x: o.x, y: o.y } : null; }
  walk(x, y) { const c = this.known[y]?.[x]; return c === '.' || c === '>' || c === '<' || c === '^'; }
  stepTo(test) {
    const me = this.pos(); if (!me) return false;
    const seen = Array.from({ length: H }, () => Array(W).fill(false));
    const q = [{ x: me.x, y: me.y, first: null }]; seen[me.y][me.x] = true;
    let frontier = null;
    while (q.length) {
      const cur = q.shift();
      if ((cur.x !== me.x || cur.y !== me.y) && test(cur.x, cur.y)) { this.send({ t: 'move', dir: cur.first }); return true; }
      for (const [dir, d] of Object.entries(DIRS)) {
        const nx = cur.x + d[0], ny = cur.y + d[1];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx]) continue;
        if (!this.walk(nx, ny)) { if (this.known[ny][nx] === ' ' && !frontier) frontier = cur.first || dir; continue; }
        seen[ny][nx] = true; q.push({ x: nx, y: ny, first: cur.first || dir });
      }
    }
    if (frontier) this.send({ t: 'move', dir: frontier });
    return false;
  }
}

const sleep = (ms) => new Promise(res => setTimeout(res, ms));
const heal = new Bot('Healer', 'warrior', 'healer');
const diver = new Bot('Diver', 'mage', 'diver');
await sleep(1200);

let killed = false;
for (let t = 0; t < 500; t++) {
  if (!diver.me || !heal.me) { await sleep(150); continue; }

  // Phase 1: confirm a ranged hit by finding any monster and firing.
  if (!r.ranged_hit) {
    if (diver.monsters.length) diver.send({ t: 'fire' });
    diver.stepTo((x, y) => diver.monsters.some(mo => mo.x === x && mo.y === y) || false) || diver.stepTo(() => false);
  } else if (!killed && !diver.me.downed) {
    // Phase 2: trigger a deterministic death.
    diver.send({ t: '_hurt', n: 999 }); killed = true;
  }

  // Healer: once the diver is downed, walk to it and revive.
  if (diver.me.downed) {
    r.downed_seen = true;
    const fallen = heal.others.find(o => o.downed);
    if (fallen) heal.stepTo((x, y) => x === fallen.x && y === fallen.y);
  }

  if (r.downed_seen && diver.me.alive && !diver.me.downed) { r.revived = true; break; }
  await sleep(150);
}

console.log(JSON.stringify(r, null, 2));
const ok = r.ranged_hit && r.downed_seen && r.revived;
console.log(ok ? 'PASS ✅ ranged combat + downed/revive co-op all work' : 'FAIL ❌ (see flags)');
try { heal.ws.close(); diver.ws.close(); } catch {}
process.exit(ok ? 0 : 1);
