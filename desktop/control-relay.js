import { WebSocket, WebSocketServer } from 'ws';

// Phones control the player in the app window over a WebSocket on the frontend server. This is a relay only: the
// window is the single host, it owns playback and publishes its state; phones send commands and get every state.
// A phone proves itself with the share password, the host with the admin password, so a phone cannot pose as host.
// ponytail: one host, last command wins, no per-phone ownership; add it when two phones fighting becomes a complaint
const MAX_MESSAGE = 256 * 1024; // a play command carries a collection or a page of tracks, never more

export function attachControl(server, { sharePassword, hostPassword }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE });
  const phones = new Set();
  let host = null, last = null;
  const send = (ws, message) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); };
  const hostMessage = () => ({ type: 'host', connected: !!host, state: last });

  const onUpgrade = (request, socket, head) => {
    const url = new URL(request.url, 'http://x');
    if (url.pathname !== '/control') { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; } // nothing else upgrades here
    const role = url.searchParams.get('h') ? 'host' : 'phone';
    const password = role === 'host' ? url.searchParams.get('h') : url.searchParams.get('p');
    if (password !== (role === 'host' ? hostPassword : sharePassword)) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      const parse = data => { try { const m = JSON.parse(String(data)); return m && typeof m === 'object' && typeof m.type === 'string' ? m : null; } catch { return null; } };
      if (role === 'host') {
        const had = !!host;
        host?.close(4000, 'replaced'); host = ws; // a reloaded window takes over
        if (!had) for (const phone of phones) send(phone, hostMessage());
        ws.on('message', data => {
          const m = parse(data);
          if (m?.type !== 'state') return;
          last = m.state ?? null;
          for (const phone of phones) send(phone, m);
        });
        ws.on('close', () => { if (host !== ws) return; host = null; last = null; for (const phone of phones) send(phone, hostMessage()); });
        return;
      }
      phones.add(ws);
      send(ws, hostMessage());
      ws.on('message', data => { const m = parse(data); if (m?.type === 'command' && host) send(host, m); });
      ws.on('close', () => phones.delete(ws));
    });
  };
  server.on('upgrade', onUpgrade);
  return {
    get host() { return host; }, get phones() { return phones.size; },
    close() {
      server.off('upgrade', onUpgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
