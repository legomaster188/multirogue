// Bot descends to depth 3, finds the merchant (P), opens the shop, and—if it has
// collected enough gold—buys a food ration. Also exercises typed-potion quaff.
import { WebSocket } from 'ws';
const W = 60, H = 34, TARGET = 3;
const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
  upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1] };
const r = { reachedShopFloor: false, sawMerchant: false, shopOpened: false, boughtOrTriedBuy: false, quaffOk: false };

const known = Array.from({ length: H }, () => Array(W).fill(' '));
let me = null, others = [], monsters = [], depth = 1, ticks = 0, shop = null, boughtAttempted = false, quaffed = false;
const ws = new WebSocket('ws://localhost:3000');
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Shopper', cls: 'warrior' })));
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.t === 'shop') { r.shopOpened = true; shop = m; tryBuy(); return; }
  if (m.t === 'log' && /quaff the/.test(m.text)) r.quaffOk = true;
  if (m.t !== 'state') return;
  ticks++;
  if (m.depth !== depth) { depth = m.depth; for (const row of known) row.fill(' '); }
  me = m.me; others = m.others; monsters = m.monsters;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m.mask[y][x] !== '0') known[y][x] = m.grid[y][x];
  if (depth >= TARGET) r.reachedShopFloor = true;
  step(m);
  if (ticks > 900) finish();
});
ws.on('error', (e) => { console.error('ws error', e.message); finish(); });

function pos() { const o = others.find(o => o.me); return o ? { x: o.x, y: o.y } : null; }
function walk(x, y) { const c = known[y]?.[x]; return c === '.' || c === '>' || c === '<' || c === '^'; }

function step(m) {
  if (!me || me.downed) return;
  // quaff our starting potion once (typed-potion path)
  if (!quaffed && me.potionCount > 0) { quaffed = true; ws.send(JSON.stringify({ t: 'quaff' })); }

  if (depth < TARGET) {
    if (me.onStairs === 'down') ws.send(JSON.stringify({ t: 'descend' }));
    else stepTo((x, y) => known[y][x] === '>');
    return;
  }
  // on the shop floor: head to the merchant 'P'
  const merch = monsters.find(mo => mo.g === 'P');
  if (merch) {
    r.sawMerchant = true;
    const me2 = pos();
    if (me2 && Math.abs(me2.x - merch.x) <= 1 && Math.abs(me2.y - merch.y) <= 1) {
      ws.send(JSON.stringify({ t: 'move', dir: dirTo(me2, merch) })); // bump = open shop
    } else stepTo((x, y) => x === merch.x && y === merch.y);
  } else {
    // explore to find the merchant
    stepTo(() => false);
  }
}

function tryBuy() {
  if (boughtAttempted) return;
  boughtAttempted = true; r.boughtOrTriedBuy = true;   // reaching here proves shop opened
  const food = shop.items.find(i => i.id === 'food');
  if (food) ws.send(JSON.stringify({ t: 'buy', id: 'food' }));
  setTimeout(finish, 800);
}

function stepTo(test) {
  const me2 = pos(); if (!me2) return;
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const q = [{ x: me2.x, y: me2.y, first: null }]; seen[me2.y][me2.x] = true;
  let frontier = null;
  while (q.length) {
    const cur = q.shift();
    if ((cur.x !== me2.x || cur.y !== me2.y) && test(cur.x, cur.y)) return ws.send(JSON.stringify({ t: 'move', dir: cur.first }));
    for (const [dir, d] of Object.entries(DIRS)) {
      const nx = cur.x + d[0], ny = cur.y + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx]) continue;
      if (!walk(nx, ny)) { if (known[ny][nx] === ' ' && !frontier) frontier = cur.first || dir; continue; }
      seen[ny][nx] = true; q.push({ x: nx, y: ny, first: cur.first || dir });
    }
  }
  if (frontier) ws.send(JSON.stringify({ t: 'move', dir: frontier }));
}
function dirTo(a, b) {
  const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
  if (dx && dy) return dy < 0 ? (dx < 0 ? 'upleft' : 'upright') : (dx < 0 ? 'downleft' : 'downright');
  return dx ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
}

let done = false;
function finish() {
  if (done) return; done = true;
  console.log(JSON.stringify(r, null, 2));
  const ok = r.reachedShopFloor && r.sawMerchant && r.shopOpened && r.quaffOk;
  console.log(ok ? 'PASS ✅ merchant + shop + typed potions work' : 'FAIL ❌ (see flags)');
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}
