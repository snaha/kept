import { WebSocket, WebSocketServer } from 'ws';

// Phones control the player in the app window over a WebSocket on the frontend server. This is a relay only: the
// window is the single host, it owns playback and publishes its state; phones send commands and get every state.
// Phones use the Control code's secret. The host uses the admin password.
// ponytail: one host, last command wins, no per-phone ownership; add it when two phones fighting becomes a complaint
const HEARTBEAT_MS = 15000
const MAX_MESSAGE = 16 * 1024 * 1024;

function rejectUpgrade(socket, status) {
  socket.on('error', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

export function attachControl(server, { controlSecret, hostPassword }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  wss.on('error', error => console.error('Phone control relay:', error))
  const phones = new Set();
  const alive = new WeakSet()
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) { ws.terminate(); continue }
      alive.delete(ws)
      ws.ping()
    }
  }, HEARTBEAT_MS)
  heartbeat.unref()

  let host = null, last = null;
  let queueParts = []
  const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const hostMessage = () => ({ type: 'host', connected: !!host, state: last });

  const onUpgrade = (request, socket, head) => {
    let url;
    try {
      url = new URL(request.url, 'http://x');
    } catch {
      return rejectUpgrade(socket, '400 Bad Request');
    }
    if (url.pathname !== '/control') return rejectUpgrade(socket, '404 Not Found');
    const role = url.searchParams.get('h') ? 'host' : 'phone';
    const password = role === 'host' ? url.searchParams.get('h') : url.searchParams.get('c');
    if (!password || password !== (role === 'host' ? hostPassword : controlSecret)) return rejectUpgrade(socket, '401 Unauthorized');
    wss.handleUpgrade(request, socket, head, ws => {
      ws.on('error', () => ws.terminate())
      alive.add(ws)
      ws.on('pong', () => alive.add(ws))
      const parse = data => { try { const m = JSON.parse(String(data)); return m && typeof m === 'object' && typeof m.type === 'string' ? m : null; } catch { return null; } };
      if (role === 'host') {
        const old = host; host = ws; last = undefined; old?.close(4000, 'replaced'); // a reloaded window takes over
        queueParts = []
        for (const phone of phones) send(phone, hostMessage())
        ws.on('message', data => {
          const m = parse(data);
          if (host !== ws) return;
          if (m?.type === 'state' && m.state && typeof m.state === 'object') {
            if (last?.queueRevision !== m.state.queueRevision) queueParts = []
            last = m.state
          } else if (m?.type === 'queue' && typeof m.part === 'string' && last && m.queueRevision === last.queueRevision) {
            if (m.first) queueParts = []
            queueParts.push(m)
          } else return;
          for (const phone of phones) send(phone, m);
        });
        ws.on('close', () => {
          if (host !== ws) return;
          host = null; last = null; queueParts = [];
          for (const phone of phones) send(phone, hostMessage());
        });
        return;
      }
      phones.add(ws);
      send(ws, hostMessage());
      for (const part of queueParts) send(ws, part)
      ws.on('message', data => { const m = parse(data); if (m?.type === 'command' && host) send(host, m); });
      ws.on('close', () => phones.delete(ws));
    });
  };
  server.on('upgrade', onUpgrade);
  return {
    get host() { return host; }, get phones() { return phones.size; },
    close() {
      clearInterval(heartbeat)
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
