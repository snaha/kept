import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { attachControl } from './control-relay.js';

const passwords = { controlSecret: 'control-secret', hostPassword: 'admin-secret' };
const TEST_TIMEOUT_MS = 5000
// messages are buffered from the first frame: the relay's welcome can arrive in the handshake packet
const open = url => new Promise((resolve, reject) => {
  const ws = new WebSocket(url), inbox = [], waiting = [];
  ws.on('message', data => { const message = JSON.parse(String(data)); const waiter = waiting.shift(); if (waiter) waiter(message); else inbox.push(message); });
  ws.next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiting.push(resolve));
  ws.once('open', () => resolve(ws)); ws.once('error', reject);
});
const refused = async url => { try { await open(url); return false; } catch (error) { return /40[14]/.test(error.message); } };

function relayFixture(t) {
  const server = http.createServer()
  const control = attachControl(server, passwords)
  t.after(() => control.close())
  class Socket extends EventEmitter {
    readyState = WebSocket.OPEN
    messages = []
    response = ''
    send(data) { this.messages.push(JSON.parse(data)) }
    write(data) { this.response += data }
    end(data, done) { this.write(data); done() }
    destroy() { this.readyState = WebSocket.CLOSED }
  }
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', (_request, socket, _head, accept) => accept(socket))
  return {
    upgrade(url) {
      const socket = new Socket()
      server.emit('upgrade', { url }, socket, Buffer.alloc(0))
      return socket
    },
    control,
  }
}

test('a request target the URL parser cannot read is rejected without interrupting the relay', t => {
  const { upgrade } = relayFixture(t)
  const invalidTarget = { toString() { throw new TypeError('invalid fixture request target') } }
  const rejected = upgrade(invalidTarget)
  assert.match(rejected.response, /^HTTP\/1\.1 400 /)
  assert.equal(rejected.readyState, WebSocket.CLOSED)

  const host = upgrade('/control?h=admin-secret')
  const phone = upgrade('/control?c=control-secret')
  const command = { type: 'command', name: 'next' }
  phone.emit('message', JSON.stringify(command))
  assert.deepEqual(host.messages, [command])
})

test('a legacy Library password cannot open a phone control session', t => {
  const { upgrade, control } = relayFixture(t)
  for (const path of ['/control?p=share-secret', '/control?c=share-secret']) {
    assert.match(upgrade(path).response, /^HTTP\/1\.1 401 /)
  }
  assert.equal(control.phones, 0)
  upgrade('/control?c=control-secret')
  assert.equal(control.phones, 1)
})

test('the relay replays only the matching queue to phones joining before or during a reorder snapshot', { timeout: TEST_TIMEOUT_MS }, async t => {
  const server = http.createServer()
  const control = attachControl(server, passwords)
  t.after(async () => { control.close(); await new Promise(resolve => server.close(resolve)) })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${server.address().port}/control`
  const host = await open(`${base}?h=admin-secret`)
  const join = () => open(`${base}?c=control-secret`)
  const witness = await join()
  await witness.next()
  const publish = async message => {
    host.send(JSON.stringify(message))
    assert.deepEqual(await witness.next(), message)
  }
  const oldState = { queueRevision: 1, time: 0, index: 0, entryId: 'cinder', queueLength: 2 }
  const oldQueue = { type: 'queue', queueRevision: 1, first: true, complete: true, part: '[{"queueEntryId":"cinder"},{"queueEntryId":"orbit"}]' }
  await publish({ type: 'state', state: oldState })
  await publish(oldQueue)

  const state = { ...oldState, queueRevision: 2, time: 1, index: 1 }
  const start = { type: 'queue', queueRevision: 2, first: true, complete: false, part: '[{"queueEntryId":"orbit"},' }
  const end = { type: 'queue', queueRevision: 2, first: false, complete: true, part: '{"queueEntryId":"cinder"}]' }
  await publish({ type: 'state', state })
  const early = await join()
  assert.deepEqual(await early.next(), { type: 'host', connected: true, state })
  host.send(JSON.stringify(oldQueue))
  await publish(start)
  assert.deepEqual(await early.next(), start)
  const mid = await join()
  assert.deepEqual(await mid.next(), { type: 'host', connected: true, state })
  assert.deepEqual(await mid.next(), start)
  await publish(end)
  assert.deepEqual(await early.next(), end)
  assert.deepEqual(await mid.next(), end)

  const nextState = { ...state, time: 2 }
  await publish({ type: 'state', state: nextState })
  const late = await join()
  assert.deepEqual(await late.next(), { type: 'host', connected: true, state: nextState })
  assert.deepEqual(await late.next(), start)
  assert.deepEqual(await late.next(), end)
})

test('control relay authenticates both roles, replays the last state and forwards commands to the host only', async t => {
  const server = http.createServer((_request, response) => response.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const control = attachControl(server, passwords);
  const base = `ws://127.0.0.1:${server.address().port}/control`;
  t.after(async () => { control.close(); await new Promise(resolve => server.close(resolve)); });

  assert.equal(await refused(`${base}?c=wrong`), true, 'a wrong Control secret is refused');
  assert.equal(await refused(`${base}?h=control-secret`), true, 'the Control secret does not open the host role');
  assert.equal(await refused(`ws://127.0.0.1:${server.address().port}/other?c=control-secret`), true, 'other paths are not upgraded');

  const phone = await open(`${base}?c=control-secret`);
  assert.deepEqual(await phone.next(), { type: 'host', connected: false, state: null }, 'a phone learns there is no host yet');

  const host = await open(`${base}?h=admin-secret`);
  assert.deepEqual(await phone.next(), { type: 'host', connected: true }, 'phones hear the host arrive');
  const state = { playing: true, time: 0 };
  host.send(JSON.stringify({ type: 'state', state }));
  assert.deepEqual(await phone.next(), { type: 'state', state }, 'host state reaches the phone');

  state.time = 1
  host.send(JSON.stringify({ type: 'state', state }))
  assert.deepEqual(await phone.next(), { type: 'state', state })

  const late = await open(`${base}?c=control-secret`);
  assert.deepEqual(await late.next(), { type: 'host', connected: true, state }, 'a phone that connects later gets the last state');

  const command = { type: 'command', name: 'next' };
  phone.send(JSON.stringify(command));
  assert.deepEqual(await host.next(), command, 'commands reach the host');
  late.send(JSON.stringify({ type: 'state', state: { playing: false } }));
  phone.send('not json');
  phone.send(JSON.stringify({ type: 'command', name: 'toggle' }));
  assert.deepEqual(await host.next(), { type: 'command', name: 'toggle' }, 'a phone cannot publish state, and bad input is dropped');
  assert.equal(control.phones, 2);

  const replacement = await open(`${base}?h=admin-secret`);
  await new Promise(resolve => host.readyState === host.CLOSED ? resolve() : host.once('close', resolve));
  assert.deepEqual(await phone.next(), { type: 'host', connected: true })
  replacement.send(JSON.stringify({ type: 'state', state: { playing: false } }));
  assert.deepEqual(await phone.next(), { type: 'state', state: { playing: false } }, 'the replacement host publishes');

  replacement.close();
  assert.deepEqual(await phone.next(), { type: 'host', connected: false, state: null }, 'phones hear the host leave and the stale state is dropped');
  phone.close(); late.close();
});

const FIXTURE_PAYLOAD_LIMIT = 128

test('control relay survives a message size error from either role', { timeout: TEST_TIMEOUT_MS }, async t => {
  const upgrade = WebSocketServer.prototype.handleUpgrade
  t.mock.method(WebSocketServer.prototype, 'handleUpgrade', function (request, socket, head, accept) {
    // Exercise the real receiver with a small fixture instead of allocating a full-size queue.
    this.options.maxPayload = FIXTURE_PAYLOAD_LIMIT
    return upgrade.call(this, request, socket, head, accept)
  })
  const server = http.createServer()
  const control = attachControl(server, passwords)
  t.after(async () => {
    control.close()
    await new Promise(resolve => server.close(resolve))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `ws://127.0.0.1:${server.address().port}/control`
  const host = await open(`${base}?h=admin-secret`)
  const phone = await open(`${base}?c=control-secret`)
  await phone.next()

  const message = JSON.stringify({ title: 'Glowing Cinder'.repeat(FIXTURE_PAYLOAD_LIMIT) })
  const phoneClosed = once(phone, 'close')
  phone.send(message)
  await phoneClosed

  const secondPhone = await open(`${base}?c=control-secret`)
  assert.equal((await secondPhone.next()).connected, true)
  const command = { type: 'command', name: 'next' }
  secondPhone.send(JSON.stringify(command))
  assert.deepEqual(await host.next(), command)

  const hostClosed = once(host, 'close')
  host.send(message)
  await hostClosed
  assert.equal((await secondPhone.next()).connected, false)

  const secondHost = await open(`${base}?h=admin-secret`)
  assert.equal((await secondPhone.next()).connected, true)
  secondPhone.send(JSON.stringify(command))
  assert.deepEqual(await secondHost.next(), command)
})
