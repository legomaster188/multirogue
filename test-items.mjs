// Tests rings (stat bonus), wands (any class), and zap. Needs server with MR_TEST=1.
import { WebSocket } from 'ws';
const W = 60, H = 34;
const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
  upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1] };
const r = { ringEquipped: false, ringBoostsAtk: false, wandEquipped: false, zapHit: false };

const known = Array.from({ length: H }, () => Array(W).fill(' '));
let me = null, others = [], monsters = [], baseAtk = null, ticks = 0;
const ws = new WebSocket('ws://localhost:3000');
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Tinker', cls: 'warrior' })));
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.t === 'log' && /blasts the/.test(m.text)) r.zapHit = true;
  if (m.t !== 'state') return;
  ticks++;
  me = m.me; others = m.others; monsters = m.monsters;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y][x] !== '0') known[y][x] = m.grid[y][x];
  drive();
  if (ticks > 400) finish();
});
ws.on('error', (e) => { console.error('ws error', e.message); finish(); });

let phase = 0;
function drive() {
  if (!me) return;
  if (phase === 0) { baseAtk = me.atkTotal; ws.send(JSON.stringify({ t: '_give', what: 'ring', rtype: 'strength' })); phase = 1; return; }
  if (phase === 1) {
    if (me.rings.length >= 1) r.ringEquipped = true;
    if (baseAtk != null && me.atkTotal >= baseAtk + 3) r.ringBoostsAtk = true;
    ws.send(JSON.stringify({ t: '_give', what: 'wand' })); phase = 2; return;
  }
  if (phase === 2) { if (me.wands.length >= 1) { r.wandEquipped = true; phase = 3; } return; }
  if (phase === 3) {
    // find a monster, get within range, and zap it
    if (r.zapHit) { finish(); return; }
    ws.send(JSON.stringify({ t: 'zap' }));               // zap whenever something's in sight
    const mon = monsters[0];
    if (mon) stepTo((x, y) => Math.abs(x - mon.x) <= 6 && Math.abs(y - mon.y) <= 6);
    else stepTo(() => false);                            // explore to find a monster
  }
}

function pos() { const o = others.find(o => o.me); return o ? { x: o.x, y: o.y } : null; }
function walk(x, y) { const c = known[y]?.[x]; return c === '.' || c === '>' || c === '<' || c === '^'; }
function stepTo(test) {
  const m2 = pos(); if (!m2) return;
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const q = [{ x: m2.x, y: m2.y, first: null }]; seen[m2.y][m2.x] = true;
  let frontier = null;
  while (q.length) {
    const cur = q.shift();
    if ((cur.x !== m2.x || cur.y !== m2.y) && test(cur.x, cur.y)) return ws.send(JSON.stringify({ t: 'move', dir: cur.first }));
    for (const [dir, d] of Object.entries(DIRS)) {
      const nx = cur.x + d[0], ny = cur.y + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx]) continue;
      if (!walk(nx, ny)) { if (known[ny][nx] === ' ' && !frontier) frontier = cur.first || dir; continue; }
      seen[ny][nx] = true; q.push({ x: nx, y: ny, first: cur.first || dir });
    }
  }
  if (frontier) ws.send(JSON.stringify({ t: 'move', dir: frontier }));
}

let done = false;
function finish() {
  if (done) return; done = true;
  console.log(JSON.stringify(r, null, 2));
  const ok = r.ringEquipped && r.ringBoostsAtk && r.wandEquipped && r.zapHit;
  console.log(ok ? 'PASS ✅ rings + wands + zap work' : 'FAIL ❌ (see flags)');
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}
