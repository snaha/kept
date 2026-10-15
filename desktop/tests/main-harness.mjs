import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

export async function until(predicate, message) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise(setImmediate);
  }
}

// Run the real main entrypoint with fake OS windows/children, but real HTTP ports
// and credential files. Keep every file and resource inside this temporary fixture.
export async function mainHarness({ setupComplete = false, migrationError } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-main-'));
  const key = crypto.randomUUID();
  const state = {
    directory, trace: [], windows: [], handlers: new Map(), children: [], databases: [],
    config: { setupComplete, musicFolders: [], musicFolder: '', source: 'empty' },
    profile: { name: 'review', root: directory, directory: path.join(directory, 'profile'), existingDirectory: path.join(directory, 'normal'), existing: false, portable: true },
    app: new EventEmitter(), migrationError, saveError: undefined,
  };
  state.migration = new Promise(resolve => { state.finishMigration = resolve; });
  Object.assign(state.app, {
    getVersion: () => 'test', getPath: name => name === 'music' ? path.join(directory, 'Music') : directory,
    setPath() {}, requestSingleInstanceLock: () => true, whenReady: async () => {}, isReady: () => true,
    quit() {
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      state.app.emit('before-quit', event);
      if (!event.prevented) state.stopped = true;
    },
  });
  state.event = (url = 'app://music/') => {
    const frame = { url };
    return { senderFrame: frame, sender: { mainFrame: frame } };
  };
  state.invoke = (name, ...args) => state.handlers.get(`desktop:${name}`)(state.event(), ...args);
  const fixtures = globalThis.__musicMainFixtures ??= new Map();
  fixtures.set(key, state);
  const access = `const state = globalThis.__musicMainFixtures.get(${JSON.stringify(key)});`;
  const mocks = {
    electron: `${access}
      import { EventEmitter } from 'node:events';
      export const app = state.app;
      export class BrowserWindow extends EventEmitter {
        webContents = Object.assign(new EventEmitter(), {
          send(_channel, status) { state.status = status; },
          setWindowOpenHandler() {}, executeJavaScript: async () => {},
        });
        constructor() { super(); state.windows.push(this); }
        async loadURL(url) { this.url = url; state.trace.push(['load', url]); }
        show() { this.visible = true; state.trace.push(['show', this.url]); }
        maximize() {} isVisible() { return this.visible; }
        static getAllWindows() { return state.windows; }
      }
      export const ipcMain = { handle(name, fn) { state.handlers.set(name, fn); } };
      export const protocol = { registerSchemesAsPrivileged() {}, handle() {} };
      export const Menu = { buildFromTemplate: () => [], setApplicationMenu() {} };
      export const dialog = { showErrorBox(_title, message) { state.fatal = message; } };
      export const net = { fetch: async () => ({ ok: true }) };
      export const session = { defaultSession: { flushStorageData() {} } };
      export const shell = {};
    `,
    profiles: `${access}
      import { existsSync, readFileSync } from 'node:fs';
      export const readJSON = (file, fallback = {}) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback;
      export const launchProfile = () => state.profile;
      export const loadProfile = () => state.config;
      export const saveProfile = () => { if (state.saveError) { const error = state.saveError; state.saveError = undefined; throw error; } };
      export function lockProfile() {} export function rememberProfile() {}
      export function assertProfileClosed() {} export function copyProfile() {}
      export function listProfiles() {} export function newProfile() {} export function selectedProfile() {}
    `,
    migration: `${access}
      export async function migrateStorage() {
        state.trace.push(['migrate', state.windows.some(window => window.visible)]);
        await state.migration;
        if (state.migrationError) throw state.migrationError;
      }
    `,
    database: `${access}
      export class MusicDatabase {
        constructor() { this.id = state.databases.length; state.databases.push(this); }
        async call() { return { databaseId: this.id }; }
        async close() { this.closed = true; }
      }
    `,
    child: `${access}
      import { EventEmitter } from 'node:events';
      export function spawn() {
        const child = new EventEmitter();
        Object.assign(child, { pid: 100 + state.children.length, exitCode: null, signalCode: null,
          kill() { this.exitCode = 0; this.emit('close'); return true; },
        });
        state.children.push(child);
        return child;
      }
    `,
  };
  const mapping = { electron: 'electron', './profiles.js': 'profiles', './storage-migration.js': 'migration', './music-database.js': 'database', 'node:child_process': 'child' };
  const dispose = async () => {
    state.finishMigration();
    state.app.quit();
    await until(() => state.stopped, 'Main fixture did not finish shutting down');
    fixtures.delete(key);
    await rm(directory, { recursive: true, force: true });
  };
  try {
    await mkdir(path.join(directory, 'dist'));
    await writeFile(path.join(directory, 'dist/index.html'), '<!doctype html><title>Fixture</title>');
    const outfile = path.join(directory, 'main.mjs');
    await build({
      entryPoints: [new URL('../main.js', import.meta.url).pathname], outfile,
      bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
      // ws is CommonJS and requires node builtins at load; an ESM bundle has no require of its own
      banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
      plugins: [{ name: 'main-fixture', setup(builder) {
        builder.onResolve({ filter: /^(electron|node:child_process|\.\/(profiles|storage-migration|music-database)\.js)$/ }, ({ path: name }) => ({ path: mapping[name], namespace: 'fixture' }));
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: name }) => ({ contents: mocks[name], loader: 'js' }));
      } }],
    });
    await import(pathToFileURL(outfile).href);
    await until(() => state.trace.some(([event]) => event === 'migrate') || state.fatal, 'Main fixture did not reach storage migration');
    return { state, dispose };
  } catch (error) { await dispose(); throw error; }
}
