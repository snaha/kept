import { validateDesktopRequest, validateHistoryEnvelope } from '../shared/contracts.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, session as electronSession, shell } from 'electron';
import { MusicDatabase } from './music-database.js';
import { closeFrontend, isMusicDocument, listenFrontend, stopMusicServer } from './service-lifecycle.js';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertProfileClosed, copyProfile, launchProfile, listProfiles, loadProfile, lockProfile, newProfile, readJSON, rememberProfile, saveProfile, selectedProfile } from './profiles.js';
import { migrateStorage } from './storage-migration.js';
import { normalizeMusicFolders, prepareMusicRoot, profileMusicFolders } from './music-folders.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const navidromeBin = app.isPackaged ? path.join(process.resourcesPath, 'navidrome') : path.join(here, 'bin', 'navidrome');
const page = 'app://music/';
// pnpm dev:hot: the Vite dev server answers app://music/ so the window keeps its origin and gets hot reload
const devServer = app.isPackaged ? '' : process.env.MUSIC_DEV_SERVER || '';
async function fetchDevServer(target, tries = 50) { // Vite may still be starting when the window opens
  try { return await net.fetch(target); }
  catch (error) { if (!tries) throw error; await new Promise(resolve => setTimeout(resolve, 100)); return fetchDevServer(target, tries - 1); }
}
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const build = readJSON(path.join(here, 'build-info.json'), { version: app.getVersion(), channel: 'stable', commit: '', branch: '', builtAt: '', runUrl: '' });
let profile, config, launchError = '', hasInstanceLock = false;
try {
  profile = launchProfile({ argv: process.argv.slice(1), env: process.env, appData: app.getPath('appData'), channel: build.channel });
  mkdirSync(profile.directory, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile.directory);
  app.setPath('sessionData', profile.directory);
  hasInstanceLock = app.requestSingleInstanceLock();
  if (hasInstanceLock) {
    lockProfile(profile.directory);
    config = loadProfile(profile, app.getPath('music'));
    rememberProfile(profile);
  }
} catch (error) { launchError = error.message; }
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows().find(window => window.isVisible());
  if (win?.isMinimized()) win.restore();
  win?.focus();
});

const isFree = (port) => new Promise((resolve) => {
  const s = createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
});
const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '0.0.0.0', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// generated on first run and kept in the app's data folder: admin + share passwords and the two ports,
// so QR codes and bookmarks stay valid across restarts; also the window frame choice
const save = (dataDir, st) => writeFileSync(path.join(dataDir, 'credentials.json'), JSON.stringify(st), { mode: 0o600 });
async function state(dataDir) {
  const file = path.join(dataDir, 'credentials.json');
  const st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { username: 'admin', password: randomBytes(18).toString('base64url') };
  st.sharePassword ??= randomBytes(12).toString('base64url');
  st.frame ??= true; // the OS's own title bar and window buttons
  if (!st.port || !(await isFree(st.port))) st.port = await freePort();
  if (!st.webPort || !(await isFree(st.webPort))) st.webPort = await freePort();
  save(dataDir, st);
  return st;
}

function lanIp() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}

// serves the built frontend on the LAN so phones can open the share link; the window uses it too
const MIME = { '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
function createFrontend() {
  return http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = path.join(dist, p === '/' ? 'index.html' : p);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
}

async function waitFor(url, child) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) throw new Error('The bundled music server could not start. Restart Music or try a fresh profile.');
    try { if ((await net.fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('navidrome did not start');
}

let navidrome;
let musicDatabase;

let frontendServer;
let bootstrapping = true;
let phase = 'setup', startupError = '', startupWarning = '', startPromise;
let st, local = '';
const desktopStatus = () => ({
  phase, error: startupError, warning: startupWarning, onboarding: !config.setupComplete,
  url: local, username: st?.username || '', password: st?.password || '', frame: st?.frame ?? true,
  share: st ? { webPort: st.webPort, port: st.port, password: st.sharePassword } : undefined,
  build, profile: { name: profile.name, label: config.label || (profile.existing ? 'Music' : profile.name === 'default' ? 'Preview' : profile.name), directory: profile.directory, existing: profile.existing, portable: profile.portable },
  musicFolder: config.musicFolder || '', musicFolders: profileMusicFolders(config),
  defaultMusicFolder: app.getPath('music'), defaultMusicFolderAvailable: existsSync(app.getPath('music')), source: config.source,
  canCopy: !profile.existing && existsSync(path.join(profile.existingDirectory, 'navidrome', 'credentials.json')),
});
const changed = () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:changed', desktopStatus()); };
const trusted = event => {
  if (event.senderFrame !== event.sender.mainFrame || !isMusicDocument(event.senderFrame?.url)) throw new Error('This action is available only in Music.');
};

app.whenReady().then(async () => {
  if (launchError) { dialog.showErrorBox('Cannot open Music', launchError); app.quit(); return; }
  if (!hasInstanceLock) { app.quit(); return; }
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  protocol.handle('app', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'music') return new Response('Not found', { status: 404 });
    if (url.pathname === '/__music_starting') return new Response('<!doctype html><meta name=viewport content="width=device-width"><title>Music</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#18181b;color:#eee;font:16px system-ui}</style><p role=status>Opening your library…</p>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/__music_storage_migration') return new Response('<!doctype html><title>Music storage migration</title>', { headers: { 'content-type': 'text/html' } });
    if (devServer) return fetchDevServer(devServer + url.pathname + url.search);
    const file = path.resolve(dist, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (path.relative(dist, file).startsWith('..') || !existsSync(file) || !statSync(file).isFile()) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });
  const dataDir = path.join(profile.directory, 'navidrome');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  st = readJSON(path.join(dataDir, 'credentials.json'), null);
  if (profileMusicFolders(config).some(folder => !existsSync(folder))) { config.setupComplete = false; startupError = 'A music folder is unavailable. Reconnect its drive or remove it before opening your library.'; }
  phase = config.setupComplete ? 'starting' : 'setup';
  for (const method of ['write', 'list', 'clear', 'stats']) ipcMain.handle(`music-history:${method}`, async (event, args) => {
    trusted(event);
    validateHistoryEnvelope(method, args);
    if (!musicDatabase) throw new Error('Your library is still starting.');
    return musicDatabase.call(method, args);
  });
  // a frame can't be added to or removed from an open window, so the window is built anew for it
  async function open(bounds, maximized, initializing = false) {
    const win = new BrowserWindow({
      width: 980, height: 760, minWidth: 360, minHeight: 560,
      title: `${build.channel === 'preview' ? 'Music Preview' : 'Music'} · ${config.label || profile.name}`,
      frame: st?.frame ?? true, show: false, backgroundColor: '#18181b', ...bounds,
      webPreferences: { backgroundThrottling: false, preload: path.join(here, 'preload.bundle.cjs') },
    });
    const contents = win.webContents;
    win.on('page-title-updated', event => event.preventDefault());
    if (process.env.MUSIC_DIAGNOSTICS === '1') {
      contents.on('console-message', event => { if (event.message?.startsWith('[music-metrics]') || event.level === 'error') console.log(event.message, event.sourceId, event.lineNumber); });
      contents.once('did-finish-load', () => void contents.executeJavaScript(`(() => {
        let frames = 0, previous = performance.now(), maxFrame = 0, last = previous;
        const tick = now => { frames++; maxFrame = Math.max(maxFrame, now - previous); previous = now;
          if (now - last >= 10000) { console.log('[music-metrics] ' + JSON.stringify({ fps: frames * 1000 / (now - last), maxFrame, heapMB: performance.memory?.usedJSHeapSize / 1e6, nodes: document.querySelectorAll('*').length })); frames = 0; maxFrame = 0; last = now; }
          requestAnimationFrame(tick);
        }; requestAnimationFrame(tick);
      })()`));
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (!isMusicDocument(url)) event.preventDefault(); });
    win.webContents.on('before-input-event', (e, input) => { // Ctrl+Q quits, also without window chrome (Cmd+Q on macOS comes from the app menu)
      if (input.control && input.key.toLowerCase() === 'q') { e.preventDefault(); app.quit(); }
    });
    await win.loadURL(initializing ? 'app://music/__music_starting' : page);
    if (maximized) win.maximize();
    win.show();
    return win;
  }
  // the old window closes only once the new one shows, so the app never has no window (which would quit it)
  const handleDesktop = (name, fn) => ipcMain.handle(`desktop:${name}`, async (event, ...args) => {
    trusted(event);
    try { validateDesktopRequest(name, args); return { value: await fn(event, ...args) }; }
    catch (error) { return { error: error.message }; }
  });
  handleDesktop('status', () => desktopStatus());
  handleDesktop('lan-ip', () => lanIp());
  handleDesktop('choose-folder', async (event) => {
    const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Choose your music folder', defaultPath: config.musicFolder || app.getPath('music'), properties: ['openDirectory'] });
    return result.canceled ? null : normalizeMusicFolders([result.filePaths[0]], profile.directory)[0];
  });
  handleDesktop('finish-setup', () => {
    if (phase !== 'ready') throw new Error('Wait for your library to finish starting.');
    config.setupComplete = true; saveProfile(profile, config); changed(); return desktopStatus();
  });
  handleDesktop('profiles', () => listProfiles(profile));
  handleDesktop('show-data', () => shell.openPath(profile.directory));
  handleDesktop('restart', () => scheduleRelaunch(profile.existing ? ['--use-existing'] : ['--data-dir', profile.root, '--profile', profile.name]));
  handleDesktop('switch-profile', async (event, mode, name) => {
    if (startPromise || switchingProfile) throw new Error('Wait for the current operation to finish.');
    switchingProfile = true;
    try {
      let target;
      if (mode === 'existing') {
        const result = await dialog.showMessageBox(BrowserWindow.fromWebContents(event.sender), {
          type: 'warning', message: 'Open your normal Music profile?', detail: 'Quit the other version first. This preview will write to your normal library data. A copied profile keeps those changes separate.', buttons: ['Cancel', 'Use existing profile'], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) return;
        scheduleRelaunch(['--use-existing']); return;
      }
      if (mode === 'fresh') target = newProfile(profile);
      else if (mode === 'copy') {
        if (profile.existing) throw new Error('Open an isolated preview and quit Music before copying its profile.');
        target = newProfile(profile, 'copy');
        const source = { ...profile, directory: profile.existingDirectory, existing: true, name: 'existing' };
        const credentials = readJSON(path.join(source.directory, 'navidrome', 'credentials.json'), {});
        if ((credentials.port && !(await isFree(credentials.port))) || (credentials.webPort && !(await isFree(credentials.webPort)))) throw new Error('Quit Music before copying its profile, then try again.');
        await copyProfile(source, target, app.getPath('music'));
      } else if (mode === 'continue') {
        target = selectedProfile(profile, name);
        if (!existsSync(path.join(target.directory, 'profile.json'))) throw new Error('This profile is no longer available. Choose another one or start fresh.');
        assertProfileClosed(target.directory);
      } else throw new Error('Choose Fresh, Copy existing, or an available profile.');
      rememberProfile(target);
      scheduleRelaunch(['--data-dir', profile.root, '--profile', target.name]);
    } finally { switchingProfile = false; }
  });
  handleDesktop('set-frame', async (event, on) => {
    if (!st) return;
    const old = BrowserWindow.fromWebContents(event.sender);
    st.frame = !!on; save(dataDir, st);
    await open(old.getNormalBounds(), old.isMaximized());
    old.destroy(); changed();
  });
  async function start(options = {}) {
    if (phase === 'ready') return desktopStatus();
    if (startPromise) return startPromise;
    const task = (async () => {
      try {
        if (options.source && !['folder', 'empty'].includes(options.source)) throw new Error('Choose your music folders.');
        if (options.source === 'folder') {
          config.musicFolders = normalizeMusicFolders(options.musicFolders ?? [options.musicFolder], profile.directory);
          config.musicFolder = config.musicFolders[0]; config.source = 'local';
        } else if (options.source) { config.musicFolder = ''; config.musicFolders = []; config.source = options.source; }
        const folders = profileMusicFolders(config);
        if (folders.length) config.musicFolders = normalizeMusicFolders(folders, profile.directory);
        phase = 'starting'; startupError = ''; changed();
        await stopServices();
        // An older build does not take our profile lock. Its saved listening ports
        // provide a conservative guard against opening its live databases.
        if (profile.existing) {
          const old = readJSON(path.join(dataDir, 'credentials.json'), {});
          if ((old.port && !(await isFree(old.port))) || (old.webPort && !(await isFree(old.webPort)))) throw new Error('Another Music version is using this profile. Quit it before continuing.');
        }
        config.combinedMusicFolders ||= folders.length > 1;
        const music = folders.length ? prepareMusicRoot(profile.directory, config.musicFolders, config.combinedMusicFolders) : path.join(profile.directory, 'empty-music');
        if (!folders.length) mkdirSync(music, { recursive: true, mode: 0o700 });
        st = await state(dataDir); local = `http://127.0.0.1:${st.port}`;
        const child = spawn(navidromeBin, [], {
          stdio: 'inherit', env: { ...process.env, ND_ADDRESS: '0.0.0.0', ND_PORT: String(st.port), ND_DATAFOLDER: dataDir, ND_CACHEFOLDER: path.join(dataDir, 'cache'), ND_MUSICFOLDER: music,
            ND_DEVAUTOCREATEADMINPASSWORD: st.password, ND_ENABLEINSIGHTSCOLLECTOR: 'false', ND_SCANNER_SCHEDULE: '1h', ND_SCANNER_FOLLOWSYMLINKS: 'true', ND_LOGLEVEL: 'warn' },
        });
        navidrome = child;
        child.on('error', error => { if (navidrome !== child) return; startupError = `Cannot start the bundled music server: ${error.message}`; phase = 'error'; changed(); });
        child.on('exit', (code, signal) => { if (navidrome === child && !app.isQuitting && phase === 'ready') { startupError = `The music server stopped (${signal || `exit ${code}`}). Restart Music to reconnect.`; phase = 'error'; changed(); } });
        await waitFor(`${local}/rest/ping`, child);
        frontendServer = createFrontend();
        await listenFrontend(frontendServer, st.webPort);
        musicDatabase = new MusicDatabase(path.join(profile.directory, 'music.sqlite'));
        phase = 'ready';
        if (options.source) config.setupComplete = true;
        saveProfile(profile, config); changed();
        return desktopStatus();
      } catch (error) {
        await stopServices();
        phase = 'error'; startupError ||= error.message; changed(); throw new Error(startupError);
      }
    })();
    startPromise = task;
    try { return await task; }
    finally { if (startPromise === task) startPromise = null; }
  }
  handleDesktop('start', (_event, options) => start(options));
  handleDesktop('change-folder', async (event, mode = 'replace', folder) => {
    if (!['replace', 'add', 'remove'].includes(mode)) throw new Error('Choose how to update your music folders.');
    if (mode === 'remove') {
      config.musicFolders = profileMusicFolders(config).filter(item => item !== folder);
    } else {
      const result = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), { title: 'Choose your music folder', defaultPath: config.musicFolder || app.getPath('music'), properties: ['openDirectory'] });
      if (result.canceled) return;
      config.musicFolders = normalizeMusicFolders([...(mode === 'add' ? profileMusicFolders(config) : []), result.filePaths[0]], profile.directory);
    }
    config.musicFolder = config.musicFolders[0] || ''; config.source = config.musicFolders.length ? 'local' : 'empty'; config.setupComplete = true;
    saveProfile(profile, config);
    scheduleRelaunch(profile.existing ? ['--use-existing'] : ['--data-dir', profile.root, '--profile', profile.name]);
  });
  const initialWindow = await open({}, config.setupComplete, true);
  try { await migrateStorage(profile, config); }
  catch (error) {
    console.error('Storage migration:', error.message);
    startupWarning = 'Some settings from an older version could not be imported. Your music is still available. Restart Music to retry the import.';
  }
  await initialWindow.loadURL(page);
  bootstrapping = false;
  if (config.setupComplete) void start().catch(() => {});
}).catch(error => { dialog.showErrorBox('Cannot open Music', error.message); app.quit(); });

let switchingProfile = false;
function scheduleRelaunch(args) {
  app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...args] });
  // Let the invoking renderer receive its result before shutdown destroys it.
  setTimeout(() => app.quit(), 150);
}
async function stopServices() {
  const database = musicDatabase, server = frontendServer, child = navidrome;
  musicDatabase = null;
  frontendServer = null;
  navidrome = null;
  const results = await Promise.allSettled([database?.close(), closeFrontend(server), stopMusicServer(child)]);
  for (const result of results) if (result.status === 'rejected') console.error('Music cleanup:', result.reason);
}

let shutdownComplete = false, shuttingDown = false;
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true; app.isQuitting = true;
  void (async () => {
    await stopServices();
    if (app.isReady() && hasInstanceLock) electronSession.defaultSession.flushStorageData();
  })().finally(() => { shutdownComplete = true; app.quit(); });
});
// Keep stale PID locks after crashes/exit. A new process reclaims them only when
// the former owner is gone, including Chromium's final storage flush.
app.on('window-all-closed', () => { if (!bootstrapping) app.quit(); });
