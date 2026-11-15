import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { closeFrontend, isMusicDocument, listenFrontend } from './service-lifecycle.js';
import { MusicDatabase } from './music-database.js';

test('trusted music document permits in-document navigation and rejects other origins and paths', () => {
  for (const value of ['app://music/', 'app://music/?view=queue', 'app://music/#settings']) assert.equal(isMusicDocument(value), true);
  for (const value of ['app://music/other', 'app://other/', 'https://music/', 'app://user@music/', 'app://music:123/', 'invalid', undefined]) assert.equal(isMusicDocument(value), false);
});

test('frontend startup waits for listening, reports collisions, and releases the saved port for retry', async () => {
  const server = http.createServer((_request, response) => response.end('ready'));
  await listenFrontend(server, 0);
  const port = server.address().port;
  assert.equal(server.address().address, '0.0.0.0', 'HTTP sharing is reachable from the home network')
  const failed = http.createServer();
  try {
    await assert.rejects(listenFrontend(failed, port), /EADDRINUSE/);
    await closeFrontend(failed);
    await closeFrontend(server);
    const retry = http.createServer();
    try { await listenFrontend(retry, port); assert.equal(retry.address().port, port); }
    finally { await closeFrontend(retry); }
    await closeFrontend(server);
  } finally { await closeFrontend(failed); await closeFrontend(server); }
});

test('database cleanup terminates its worker even if graceful close fails', async () => {
  const database = new MusicDatabase(':memory:');
  database.call = () => Promise.reject(new Error('failed close'));
  await assert.rejects(database.close(), /failed close/);
  assert.equal(database.worker.threadId, -1);
  assert.equal(database.pending.size, 0);
});

test('storage migration is bounded, cleans up failures, and retries without marking a failed import complete', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-migration-'));
  await mkdir(path.join(directory, 'navidrome'));
  await writeFile(path.join(directory, 'navidrome', 'credentials.json'), JSON.stringify({ webPort: 1234, port: 1235 }));
  const state = { behavior: 'hang', windows: [], handlers: new Set() };
  globalThis.__musicMigrationTest = state;
  const output = await build({
    entryPoints: [new URL('./storage-migration.js', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm',
    plugins: [{ name: 'electron-fixture', setup(builder) {
      builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        const state = globalThis.__musicMigrationTest;
        export class BrowserWindow {
          destroyed = false;
          webContents = { executeJavaScript: async () => ({ values: {}, background: null }) };
          constructor() { state.windows.push(this); }
          loadURL() { return state.behavior === 'hang' ? new Promise(() => {}) : state.behavior === 'fail' ? Promise.reject(new Error('blocked storage')) : Promise.resolve(); }
          isDestroyed() { return this.destroyed; }
          destroy() { this.destroyed = true; }
        }
        export const protocol = {
          handle(scheme) { if (state.behavior === 'handle-fail') throw new Error('protocol busy'); state.handlers.add(scheme); },
          unhandle(scheme) { state.handlers.delete(scheme); }
        };
        export const net = { fetch() {} };
      `, loader: 'js' }));
    } }],
  });
  const { migrateStorage } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const profile = { directory };
  const config = { setupComplete: true };
  try {
    for (const behavior of ['hang', 'fail', 'handle-fail']) {
      state.behavior = behavior;
      await assert.rejects(migrateStorage(profile, config, 25), /timed out|blocked storage|protocol busy/);
      assert.equal(config.storageOrigin, undefined);
      assert.equal(config.setupComplete, true);
      assert.equal(state.windows.at(-1).destroyed, true);
      assert.equal(state.handlers.size, 0);
    }
    state.behavior = 'success';
    await migrateStorage(profile, config, 100);
    assert.equal(config.storageOrigin, 'app://music');
    assert.equal(JSON.parse(await readFile(path.join(directory, 'profile.json'), 'utf8')).storageOrigin, 'app://music');
    const windows = state.windows.length;
    await migrateStorage(profile, config, 100);
    assert.equal(state.windows.length, windows, 'completed imports are not repeated');
  } finally { delete globalThis.__musicMigrationTest; await rm(directory, { recursive: true, force: true }); }
});
