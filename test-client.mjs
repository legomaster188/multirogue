import { WebSocket } from 'ws';
const url = 'ws://localhost:3000';
let got = { welcome: 0, states: 0, sawTwoPlayers: false, moved: false };

function spawn(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let myId = null, firstX = null;
    ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name })));
    ws.on('message', (b) => {
      const m = JSON.parse(b);
      if (m.t === 'welcome') { got.welcome++; myId = m.id; }
      if (m.t === 'state') {
        got.states++;
        if (m.players.length >= 2) got.sawTwoPlayers = true;
        const me = m.players.find(p => p.id === myId);
        if (me) {
          if (firstX === null) { firstX = me.x; ws.send(JSON.stringify({ t: 'move', dir: 'right' })); }
          else if (me.x !== firstX) got.moved = true;
        }
        if (got.states > 12) { ws.close(); resolve(); }
      }
    });
    ws.on('error', (e) => { console.error('ws error', e.message); resolve(); });
  });
}

await Promise.all([spawn('Alice'), spawn('Bob')]);
console.log(JSON.stringify(got, null, 2));
const ok = got.welcome === 2 && got.states > 0 && got.sawTwoPlayers && got.moved;
console.log(ok ? 'PASS ✅ multiplayer state sync + movement working' : 'FAIL ❌');
process.exit(ok ? 0 : 1);
