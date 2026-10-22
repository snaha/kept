import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';
import { compileModule } from '../../frontend/tests/runes-compiler.mjs';
import { MusicDatabase } from '../music-database.js';

let bundle;
async function freshHistoryModule() {
  // Compile once, instantiate separately: every test gets its own rune state.
  bundle ??= build({
    stdin: {
      contents: "export * from './src/lib/listening-history.svelte.ts'; export {session} from './src/lib/api.svelte.ts';",
      resolveDir: fileURLToPath(new URL('../../frontend/', import.meta.url)),
      loader: 'ts',
    },
    bundle: true, write: false, platform: 'node', format: 'esm', conditions: ['browser'],
    plugins: [{ name: 'runes', setup(builder) {
      builder.onLoad({ filter: /\.svelte\.ts$/ }, async ({ path: filename }) => {
        const source = await transform(await readFile(filename, 'utf8'), { loader: 'ts' });
        return { contents: compileModule(source.code, { filename, generate: 'client' }).js.code, loader: 'js' };
      });
    } }],
  }).then(output => Buffer.from(output.outputFiles[0].text).toString('base64'));
  return import(`data:text/javascript;base64,${await bundle}#${randomUUID()}`);
}

export async function waitForHistory(history) {
  const deadline = Date.now() + 5000;
  while (history.loading) {
    assert.ok(Date.now() < deadline, 'history refresh did not settle');
    await new Promise(setImmediate);
  }
}

function historyControls(database) {
  const requests = [];
  const rules = [];
  const failures = new Map();
  const holds = new Set();
  return {
    requests,
    failNext(method, error = new Error(`${method} unavailable`), matches = () => true) {
      rules.push({ method, matches, error });
    },
    setFailure(method, error) {
      if (error) failures.set(method, error);
      else failures.delete(method);
    },
    holdNext(method, matches = () => true) {
      const started = Promise.withResolvers();
      const completion = Promise.withResolvers();
      const hold = {
        started: started.promise,
        release: () => completion.resolve(),
        reject: (error = new Error(`${method} response lost`)) => completion.resolve(error),
      };
      rules.push({ method, matches, started, completion, hold });
      holds.add(hold);
      return hold;
    },
    reset() {
      failures.clear();
      rules.length = 0;
      for (const hold of holds) hold.release();
      holds.clear();
    },
    async call(method, args) {
      const request = { method, args: structuredClone(args) };
      requests.push(request);
      const index = rules.findIndex(rule => rule.method === method && rule.matches(args));
      const rule = index >= 0 ? rules.splice(index, 1)[0] : undefined;
      const error = rule?.error || failures.get(method);
      if (error) {
        rule?.started?.resolve({ ...request, error });
        if (rule?.hold) holds.delete(rule.hold);
        throw error;
      }
      try {
        const result = await database.call(method, args);
        if (rule?.hold) {
          // Capture the real DB result before delaying delivery. Rejecting a write
          // here simulates a lost acknowledgement after a successful commit.
          rule.started.resolve(request);
          const failure = await rule.completion.promise;
          if (failure) throw failure;
        }
        return result;
      } catch (error) {
        // Wake a waiting test even if SQLite failed before reaching the gate.
        rule?.started?.resolve({ ...request, error });
        throw error;
      } finally {
        if (rule?.hold) holds.delete(rule.hold);
      }
    },
  };
}

// Uses process globals; keep callers serial within a test file. Node's test-file
// isolation lets the normal desktop suite run separate files concurrently.
export async function createHistoryHarness(t, { username = 'history-test', stats = true } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-history-ui-'));
  const database = new MusicDatabase(path.join(directory, 'music.sqlite'));
  const controls = historyControls(database);
  const storage = new Map();
  const originals = new Map(['localStorage', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let module;
  let closing;
  const settle = async () => {
    try { await module.historyStats(); }
    finally { await waitForHistory(module.listeningHistory); }
  };
  const close = () => closing ??= (async () => {
    controls.reset();
    try {
      if (module) {
        module.disposeHistory();
        // Disposal invalidates reads; their obsolete loading flag need not clear.
        // Drain persistence before closing SQLite instead of waiting on UI state.
        await module.historyStats();
      }
    } finally {
      try { await database.close(); }
      finally {
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete globalThis[key];
        }
        await rm(directory, { recursive: true, force: true });
      }
    }
  })();
  t.after(close);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  globalThis.window = { desktop: {}, musicHistory: {
    write: args => controls.call('write', args),
    list: args => controls.call('list', args),
    clear: scope => controls.call('clear', { scope }),
    ...(stats ? { stats: args => controls.call('stats', args) } : {}),
  } };
  module = await freshHistoryModule();
  module.session.base = 'http://127.0.0.1:1234';
  module.session.username = username;
  return { module, database, controls, storage, settle, close };
}
