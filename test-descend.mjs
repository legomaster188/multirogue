// Bot that explores, finds down-stairs, descends, then ascends back.
import { WebSocket } from 'ws';
const W = 60, H = 34;
const DIRS = { up:[0,-1], down:[0,1], left:[-1,0], right:[1,0] };
const known = Array.from({ length: H }, () => Array(W).fill(' '));
let me = null, depth = 1, reachedDepth = 1, climbedBack = false, ticks = 0;

const ws = new WebSocket('ws://localhost:3000');
ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name: 'Scout' })));
ws.on('message', (b) => {
  const m = JSON.parse(b);
  if (m.t !== 'state') return;
  ticks++;
  depth = m.depth;
  reachedDepth = Math.max(reachedDepth, depth);
  me = m.others.find(o => o.me);
  // learn terrain from anything explored/visible
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++)
    if (m.mask[y][x] !== '0') known[y][x] = m.grid[y][x];
  if (!me) return;

  // success: descended at least once and climbed back to depth 1
  // (ascending lands you ON the upper level's down-stairs — that's correct, so don't exclude it)
  if (reachedDepth >= 2 && depth === 1) { climbedBack = true; finish(); return; }

  if (depth === 1 && reachedDepth === 1) {
    if (m.me.onStairs === 'down') { ws.send(JSON.stringify({ t: 'descend' })); return; }
    step('>');                                   // head for down-stairs
  } else if (depth >= 2) {
    if (m.me.onStairs === 'up') { ws.send(JSON.stringify({ t: 'ascend' })); return; }
    step('<');                                    // head back to up-stairs
  }
  if (ticks > 600) finish();                       // ~120s budget
});
ws.on('error', (e) => { console.error('ws error', e.message); finish(); });

function walkable(x, y) { const c = known[y]?.[x]; return c === '.' || c === '>' || c === '<' || c === '^'; }

// BFS from me to nearest cell matching target char, else to nearest frontier (known cell next to unknown)
function step(targetChar) {
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const q = [{ x: me.x, y: me.y, first: null }];
  seen[me.y][me.x] = true;
  let frontierMove = null;
  while (q.length) {
    const cur = q.shift();
    if (known[cur.y][cur.x] === targetChar && (cur.x !== me.x || cur.y !== me.y)) { return moveTo(cur.first); }
    for (const [dir, d] of Object.entries(DIRS)) {
      const nx = cur.x + d[0], ny = cur.y + d[1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny][nx]) continue;
      if (!walkable(nx, ny)) {
        if (known[ny][nx] === ' ' && !frontierMove) frontierMove = cur.first || dir; // explore toward unknown
        continue;
      }
      seen[ny][nx] = true;
      q.push({ x: nx, y: ny, first: cur.first || dir });
    }
  }
  if (frontierMove) moveTo(frontierMove);
}
function moveTo(dir) { if (dir) ws.send(JSON.stringify({ t: 'move', dir })); }

function finish() {
  const ok = reachedDepth >= 2 && climbedBack;
  console.log(JSON.stringify({ reachedDepth, climbedBack, finalDepth: depth, ticks }, null, 2));
  console.log(ok ? 'PASS ✅ explore → descend → ascend round-trip works' : 'FAIL ❌');
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}
