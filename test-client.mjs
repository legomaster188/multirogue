import { WebSocket } from 'ws';
const url = 'ws://localhost:3000';
const r = { welcome: 0, states: 0, moved: false, hasFog: false, sawOther: false,
  hasHUD: false, gotClass: false, mageRanged: false };

function spawn(name, drive, cls) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let myId = null, startX = null, n = 0;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name, cls })));
    ws.on('message', (b) => {
      const m = JSON.parse(b);
      if (m.t === 'welcome') { r.welcome++; myId = m.id; }
      if (m.t === 'state') {
        r.states++; n++;
        // fog: a fresh level must have unseen ('0') and visible ('2') cells
        const joined = m.mask.join('');
        if (joined.includes('0') && joined.includes('2')) r.hasFog = true;
        if (m.others.length >= 1) r.sawOther = true;
        if (m.me && typeof m.me.hunger === 'number' && typeof m.me.hp === 'number'
          && typeof m.me.atkTotal === 'number' && Array.isArray(m.me.rings) && Array.isArray(m.me.wands)) r.hasHUD = true;
        if (m.me && m.me.className) r.gotClass = true;
        if (m.me && cls === 'mage' && m.me.ranged) r.mageRanged = true;
        if (drive) {
          if (startX === null) { startX = pos(m); ws.send(JSON.stringify({ t: 'move', dir: 'right' })); }
          else if (pos(m) !== startX) r.moved = true;
          if (n === 3) { ws.send(JSON.stringify({ t: 'eat' })); ws.send(JSON.stringify({ t: 'quaff' }));
            ws.send(JSON.stringify({ t: 'fire' })); ws.send(JSON.stringify({ t: 'readmap' })); }
        }
        if (n > 14) { ws.close(); resolve(); }
      }
    });
    ws.on('error', (e) => { console.error('ws error', e.message); resolve(); });
  });
}
const pos = (m) => { const me = m.others.find(o => o.me); return me ? me.x + ',' + me.y : null; };

await Promise.all([spawn('Alice', true, 'mage'), spawn('Bob', false, 'warrior')]);
console.log(JSON.stringify(r, null, 2));
const ok = r.welcome === 2 && r.states > 0 && r.moved && r.hasFog && r.hasHUD && r.gotClass && r.mageRanged;
console.log(ok ? 'PASS ✅ fog, HUD, classes, ranged, movement all working' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
