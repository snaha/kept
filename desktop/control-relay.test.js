import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocket } from 'ws';
import { attachControl } from './control-relay.js';

const passwords = { sharePassword: 'share-secret', hostPassword: 'admin-secret' };
// messages are buffered from the first frame: the relay's welcome can arrive in the handshake packet
const open = url => new Promise((resolve, reject) => {
  const ws = new WebSocket(url), inbox = [], waiting = [];
  ws.on('message', data => { const message = JSON.parse(String(data)); const waiter = waiting.shift(); if (waiter) waiter(message); else inbox.push(message); });
  ws.next = () => inbox.length ? Promise.resolve(inbox.shift()) : new Promise(resolve => waiting.push(resolve));
  ws.once('open', () => resolve(ws)); ws.once('error', reject);
});
const refused = async url => { try { await open(url); return false; } catch (error) { return /40[14]/.test(error.message); } };

test('control relay authenticates both roles, replays the last state and forwards commands to the host only', async t => {
  const server = http.createServer((_request, response) => response.end('ok'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const control = attachControl(server, passwords);
  const base = `ws://127.0.0.1:${server.address().port}/control`;
  t.after(async () => { control.close(); await new Promise(resolve => server.close(resolve)); });

  assert.equal(await refused(`${base}?p=wrong`), true, 'a wrong share password is refused');
  assert.equal(await refused(`${base}?h=share-secret`), true, 'the share password does not open the host role');
  assert.equal(await refused(`ws://127.0.0.1:${server.address().port}/other?p=share-secret`), true, 'other paths are not upgraded');

  const phone = await open(`${base}?p=share-secret`);
  assert.deepEqual(await phone.next(), { type: 'host', connected: false, state: null }, 'a phone learns there is no host yet');

  const host = await open(`${base}?h=admin-secret`);
  assert.deepEqual(await phone.next(), { type: 'host', connected: true, state: null }, 'phones hear the host arrive');
  const state = { playing: true, song: { id: 'local:track:1', title: 'Song' }, time: 3 };
  host.send(JSON.stringify({ type: 'state', state }));
  assert.deepEqual(await phone.next(), { type: 'state', state }, 'host state reaches the phone');

  const late = await open(`${base}?p=share-secret`);
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
  replacement.send(JSON.stringify({ type: 'state', state: { playing: false } }));
  assert.deepEqual(await phone.next(), { type: 'state', state: { playing: false } }, 'the replacement host publishes');

  replacement.close();
  assert.deepEqual(await phone.next(), { type: 'host', connected: false, state: null }, 'phones hear the host leave and the stale state is dropped');
  phone.close(); late.close();
});
