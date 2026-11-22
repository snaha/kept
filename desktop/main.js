import { validateDesktopRequest, validateHistoryEnvelope } from '../shared/contracts.js';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session as electronSession, shell, utilityProcess } from 'electron';
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
import { CATALOG_BRIDGE_METHODS, CATALOG_CHANGING_OPERATIONS, createCatalogBridge, validateCatalogBridgeRequest } from '../shared/catalog-bridge.js'
import { createLibraryService } from './library-service.js'
import { ResourcePolicy } from './resource-policy.js'
import { createLanCatalog, createLanShare, LAN_PREFIX } from './lan-catalog.js'
import { createToolRunner } from '../shared/tool-runner.js'
import { createHistoryStats } from './tool-services.js'
import { createAssistant } from './assistant.js'
import { createAssistantService } from './assistant-service.js'
import { createAssistantSettings } from './assistant-settings.js'
import { createSpotifyService, defaultSpotifyClientId, loopbackAuthorize } from './spotify.js'
import { readFeatures } from './features.js'
import { featureArgument } from './feature-argument.js'
import { SPOTIFY_CONSENT, SPOTIFY_SOURCE } from '../shared/spotify-source.js'
import { CatalogDatabase } from './catalog-database.js'
import { markUnavailableSources, startCatalogSync } from './catalog-ingest.js'
import { createTrackPathResolver } from './track-paths.js'
import { createAnalysis } from './analysis-jobs.js'
import { resolveFfmpeg, resolveModelDir } from './analysis/ffmpeg.js'
import { FeatureDatabase } from './feature-database.js'
import { createFeatureSource, createSoundSimilarity } from './feature-source.js'
import { createEstimatedTraits } from './estimated-traits.js'
import { currentMethod } from './analysis/methods.js'

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, 'dist');
const navidromeBin = app.isPackaged ? path.join(process.resourcesPath, 'navidrome') : path.join(here, 'bin', 'navidrome');
const page = 'app://music/';
// Kept is offline by default: Navidrome never calls out; consented lookups are Kept's own.
const OFFLINE_ENV = {
  ND_ENABLEEXTERNALSERVICES: 'false', ND_LASTFM_ENABLED: 'false', ND_DEEZER_ENABLED: 'false', ND_LISTENBRAINZ_ENABLED: 'false',
  ND_PLUGINS_ENABLED: 'false', ND_COVERARTPRIORITY: 'cover.*, folder.*, front.*, embedded', ND_ARTISTARTPRIORITY: 'artist.*, album/artist.*',
}
// pnpm dev:hot: the Vite dev server answers app://music/ so the window keeps its origin and gets hot reload
const devServer = app.isPackaged ? '' : process.env.MUSIC_DEV_SERVER || '';
async function fetchDevServer(target, tries = 50) { // Vite may still be starting when the window opens
  try { return await net.fetch(target); }
  catch (error) { if (!tries) throw error; await new Promise(resolve => setTimeout(resolve, 100)); return fetchDevServer(target, tries - 1); }
}
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
const build = readJSON(path.join(here, 'build-info.json'), { version: app.getVersion(), channel: 'stable', commit: '', branch: '', builtAt: '', runUrl: '' });
app.setName(build.channel === 'preview' ? 'Kept Preview' : 'Kept')
let profile, config, trialFeatures = {}, launchError = '', hasInstanceLock = false;
try {
  profile = launchProfile({ argv: process.argv.slice(1), env: process.env, appData: app.getPath('appData'), channel: build.channel });
  mkdirSync(profile.directory, { recursive: true, mode: 0o700 });
  trialFeatures = readFeatures(profile.directory);
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

// HTTP frontend for sharing on the user's trusted home network or Tailscale.
const MIME = { '.html': 'text/html', '.webmanifest': 'application/manifest+json', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
const HTTP_OK = 200
const HTTP_BAD_REQUEST = 400
const HTTP_NOT_FOUND = 404
const HTTP_SERVER_ERROR = 500
function createFrontend() {
  return http.createServer((req, res) => {
    // The read-only catalog for phones: the page's own origin, authenticated per device.
    if (lanCatalog && req.url?.startsWith(LAN_PREFIX) && lanCatalog.handle(req, res, new URL(req.url, 'http://x').pathname)) return
    const fail = status => {
      if (res.destroyed) return
      if (res.headersSent) res.destroy()
      else {
        res.writeHead(status, { 'Content-Type': 'text/plain' })
        res.end('Unable to serve this request')
      }
    }
    let pathname
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname)
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('Invalid path')
    } catch {
      fail(HTTP_BAD_REQUEST)
      return
    }
    try {
      let file = path.resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
      const relative = path.relative(dist, file)
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail(HTTP_NOT_FOUND)
        return
      }
      if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html')
      const stream = createReadStream(file)
      // Open failures and disconnects belong to this request, never the host process.
      stream.once('error', () => fail(HTTP_SERVER_ERROR))
      res.once('close', () => stream.destroy())
      stream.once('open', () => {
        if (res.destroyed) {
          stream.destroy()
          return
        }
        res.writeHead(HTTP_OK, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
        stream.pipe(res)
      })
    } catch { fail(HTTP_SERVER_ERROR) }
  })
}

async function waitFor(url, child) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) throw new Error('The bundled music server could not start. Restart Kept or try a fresh profile.');
    try { if ((await net.fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('navidrome did not start');
}

let navidrome;
let musicDatabase;
// library.sqlite belongs to the profile, not to the music server: it stays open across server restarts.
let catalogDatabase, catalogBridge, catalogSync, library, lanCatalog
const CATALOG_CHANGE_DELAY_MS = 200
let catalogChangeTimer
// features.sqlite holds what the analyser computed. It can be deleted: the library is then analysed again.
let featureDatabase

// Job handlers run in a utility process of their own, so the window and the catalog never share a core with heavy work.
const electronFork = (file, name) => {
  const child = utilityProcess.fork(fileURLToPath(file), [], { serviceName: `Kept ${name}`, stdio: 'inherit' })
  return { post: message => child.postMessage(message), onMessage: callback => child.on('message', callback), onExit: callback => child.on('exit', callback), kill: () => child.kill() }
}
const sendToWindows = (channel, value) => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, value) }
function broadcastRepairs() {
  if (shuttingDown || catalogChangeTimer !== undefined) return
  catalogChangeTimer = setTimeout(() => {
    catalogChangeTimer = undefined
    sendToWindows('catalog:changed')
  }, CATALOG_CHANGE_DELAY_MS)
}

let frontendServer;
let bootstrapping = true;
let phase = 'setup', startupError = '', startupWarning = '', startPromise;
let st, local = '';
function shareAddresses() {
  if (phase !== 'ready' || !st?.webPort || !st.port) return undefined
  const ip = lanIp()
  return { origin: new URL(`http://${ip}:${st.webPort}`).origin, server: new URL(`http://${ip}:${st.port}`).origin }
}
const desktopStatus = () => ({
  phase, error: startupError, warning: startupWarning, onboarding: !config.setupComplete,
  url: local, username: st?.username || '', password: st?.password || '', frame: st?.frame ?? true,
  share: st ? { webPort: st.webPort, port: st.port, password: st.sharePassword } : undefined,
  build, profile: { name: profile.name, label: config.label || (profile.existing ? 'Kept' : profile.name === 'default' ? 'Preview' : profile.name), directory: profile.directory, existing: profile.existing, portable: profile.portable },
  musicFolder: config.musicFolder || '', musicFolders: profileMusicFolders(config),
  defaultMusicFolder: app.getPath('music'), defaultMusicFolderAvailable: existsSync(app.getPath('music')), source: config.source,
  canCopy: !profile.existing && existsSync(path.join(profile.existingDirectory, 'navidrome', 'credentials.json')),
});
const changed = () => { for (const win of BrowserWindow.getAllWindows()) win.webContents.send('desktop:changed', desktopStatus()); };
const trusted = event => {
  if (event.senderFrame !== event.sender.mainFrame || !isMusicDocument(event.senderFrame?.url)) throw new Error('This action is available only in Kept.');
};

app.whenReady().then(async () => {
  if (launchError) { dialog.showErrorBox('Cannot open Kept', launchError); app.quit(); return; }
  if (!hasInstanceLock) { app.quit(); return; }
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  protocol.handle('app', request => {
    const url = new URL(request.url);
    if (url.hostname !== 'music') return new Response('Not found', { status: 404 });
    if (url.pathname === '/__music_starting') return new Response('<!doctype html><meta name=viewport content="width=device-width"><title>Kept</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#18181b;color:#eee;font:16px system-ui}</style><p role=status>Opening your library…</p>', { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/__music_storage_migration') return new Response('<!doctype html><title>Kept storage migration</title>', { headers: { 'content-type': 'text/html' } });
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
  catalogDatabase = new CatalogDatabase(path.join(profile.directory, 'library.sqlite'))
  featureDatabase = new FeatureDatabase(path.join(profile.directory, 'features.sqlite'))
  const method = currentMethod()
  const features = createFeatureSource({ features: featureDatabase.store, method })
  // Tools read the history of the signed-in account and the sound features the analyser has stored.
  const toolRunner = createToolRunner({
    catalog: catalogDatabase.service,
    features,
    history: createHistoryStats({
      stats: async () => (musicDatabase && st ? musicDatabase.call('stats', { scope: `desktop:${st.username}` }) : {}),
    }),
  })
  catalogBridge = createCatalogBridge(catalogDatabase.service, {
    tools: toolRunner,
    estimates: createEstimatedTraits({ features: featureDatabase.store, method }),
    soundSimilarity: createSoundSimilarity({ catalog: catalogDatabase.service, features: featureDatabase.store, method }),
  })
  lanCatalog = createLanCatalog({ bridge: catalogBridge, sharePassword: () => st?.sharePassword, shareAddresses })
  // An unplugged drive keeps its albums and tags: they are shown as unavailable, never dropped.
  void markUnavailableSources({ catalog: catalogDatabase.service, folders: profileMusicFolders(config) }).catch(error => console.error('Kept catalog:', error.message))
  for (const [operation, method] of Object.entries(CATALOG_BRIDGE_METHODS)) ipcMain.handle(`catalog:${operation}`, async (event, ...args) => {
    trusted(event)
    try {
      const request = validateCatalogBridgeRequest(operation, args)
      const value = await catalogBridge[method](request)
      // An undo, a correction or a lock changes what every window shows: titles, provenance and the Activity list.
      if (CATALOG_CHANGING_OPERATIONS.includes(operation) && (value.status === 'undone' || value.applied)) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('catalog:changed')
      if (operation === 'set-consent') {
        // Running jobs must drop their saved permission and reread the cluster.
        if (request.consent === 'online-lookups' && request.value === 'denied') await library.reconstruct.interrupt()
        void queueReconstruction()
      }
      return { value }
    } catch (error) { return { error: error.message } }
  })
  // Background jobs wait for playback: the window reports its audio element, the library worker obeys.
  // Measuring the policy against its absence: KEPT_JOBS_POLICY=off lets background work run at full tilt.
  const policy = new ResourcePolicy()
  policy.enabled = process.env.KEPT_JOBS_POLICY !== 'off'
  // Sound analysis: its own low-priority process, the bundled decoder and a model that never leaves this computer.
  // KEPT_ANALYSIS=off leaves it out, to measure the app without it.
  const locations = { packaged: app.isPackaged, resources: process.resourcesPath, desktop: here }
  const analysis = process.env.KEPT_ANALYSIS === 'off' ? undefined : createAnalysis({
    catalog: catalogDatabase.store, features: featureDatabase.store, folders: () => profileMusicFolders(config),
    ffmpeg: resolveFfmpeg(locations)?.file, modelDir: resolveModelDir(locations),
    onError: error => console.error('Kept analysis:', error.message),
  })
  if (analysis?.missing) console.error(`Kept analysis: off, ${analysis.missing}`)
  library = createLibraryService({
    store: catalogDatabase.store, fork: electronFork, policy, appVersion: app.getVersion(), analysis,
    onProgress: status => sendToWindows('jobs:changed', status),
    onCatalogChange: broadcastRepairs,
    onError: error => console.error('Kept jobs:', error.message),
  })
  // What earlier launches left unanalysed is queued again at once; a finished scan queues what is new.
  void library.start().then(() => library.analyse()).catch(error => console.error('Kept jobs:', error.message))
  ipcMain.on('jobs:playback', (event, report) => {
    try { trusted(event); library.reportPlayback(report) } catch (error) { console.error('Kept jobs:', error.message) }
  })
  ipcMain.handle('jobs:status', async event => {
    trusted(event)
    try { return { value: await library.status() } } catch (error) { return { error: error.message } }
  })
  // The optional assistant: off until the user opts in, called from here with a key that only this process can read.
  const assistantService = createAssistantService({
    settings: createAssistantSettings({ directory: profile.directory, safeStorage }),
    assistant: createAssistant({ runner: toolRunner }),
    folders: () => profileMusicFolders(config),
  })
  const assistantRequests = {
    status: () => assistantService.status(),
    save: change => assistantService.save(change),
    ask: (request, sender) => assistantService.ask(request, sender),
    cancel: (id, sender) => assistantService.cancel(id, sender),
  }
  for (const [name, call] of Object.entries(assistantRequests)) ipcMain.handle(`assistant:${name}`, async (event, request) => {
    trusted(event)
    try { return { value: await call(request, event.sender) } } catch (error) { return { error: error.message } }
  })
  // Spotify is a trial feature: without "spotify": true in the profile's features.json it is never started and the
  // window gets no bridge, so nothing of it shows.
  if (trialFeatures.spotify) {
    // Spotify, playback only and off until the user signs in. Signing in is the consent; signing out withdraws it.
    // Its tokens are encrypted here and never reach the window. A known client ID makes sign-in one button.
    const spotifyService = createSpotifyService({
      directory: path.join(profile.directory, 'spotify'), safeStorage,
      defaultClientId: () => defaultSpotifyClientId({ env: process.env, build, existingDirectory: profile.existing ? '' : profile.existingDirectory }),
      authorize: loopbackAuthorize({ openExternal: url => shell.openExternal(url) }),
      onChange: status => sendToWindows('spotify:changed', status),
      onConsent: async value => {
        await catalogDatabase.service.registerSource(SPOTIFY_SOURCE)
        await catalogDatabase.service.setConsent({ consent: SPOTIFY_CONSENT, value, decidedAt: Date.now() })
      },
    })
    const spotifyInitialized = spotifyService.init()
    void spotifyInitialized.catch(error => console.error('Kept Spotify:', error.message))
    const spotifyRequests = {
      status: () => spotifyService.status(), connect: clientId => spotifyService.connect(clientId), disconnect: () => spotifyService.disconnect(),
      devices: () => spotifyService.devices(), 'select-device': id => spotifyService.selectDevice(id), search: query => spotifyService.search(query),
      command: ({ action, value }) => spotifyService.command(action, value), playback: () => spotifyService.playback(),
    }
    for (const [name, call] of Object.entries(spotifyRequests)) ipcMain.handle(`spotify:${name}`, async (event, request) => {
      trusted(event)
      try {
        await spotifyInitialized
        return { value: await call(request) }
      } catch (error) { return { error: error.message } }
    })
  }
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
      title: `${build.channel === 'preview' ? 'Kept Preview' : 'Kept'} · ${config.label || profile.name}`,
      frame: st?.frame ?? true, show: false, backgroundColor: '#18181b', ...bounds,
      webPreferences: { backgroundThrottling: false, preload: path.join(here, 'preload.bundle.cjs'), additionalArguments: [featureArgument(trialFeatures)] },
    });
    const contents = win.webContents;
    win.on('page-title-updated', event => event.preventDefault());
    // A window that reloads or dies is not playing any more.
    contents.on('did-start-navigation', details => { if (details.isMainFrame) library?.playbackEnded() });
    contents.on('render-process-gone', () => library?.playbackEnded());
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
  handleDesktop('lan-share', () => createLanShare(st?.sharePassword, shareAddresses()))
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
          type: 'warning', message: 'Open your normal Kept profile?', detail: 'Quit the other version first. This preview will write to your normal library data. A copied profile keeps those changes separate.', buttons: ['Cancel', 'Use existing profile'], defaultId: 0, cancelId: 0,
        });
        if (result.response !== 1) return;
        scheduleRelaunch(['--use-existing']); return;
      }
      if (mode === 'fresh') target = newProfile(profile);
      else if (mode === 'copy') {
        if (profile.existing) throw new Error('Open an isolated preview and quit Kept before copying its profile.');
        target = newProfile(profile, 'copy');
        const source = { ...profile, directory: profile.existingDirectory, existing: true, name: 'existing' };
        const credentials = readJSON(path.join(source.directory, 'navidrome', 'credentials.json'), {});
        if ((credentials.port && !(await isFree(credentials.port))) || (credentials.webPort && !(await isFree(credentials.webPort)))) throw new Error('Quit Kept before copying its profile, then try again.');
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
          if ((old.port && !(await isFree(old.port))) || (old.webPort && !(await isFree(old.webPort)))) throw new Error('Another Kept version is using this profile. Quit it before continuing.');
        }
        config.combinedMusicFolders ||= folders.length > 1;
        const music = folders.length ? prepareMusicRoot(profile.directory, config.musicFolders, config.combinedMusicFolders) : path.join(profile.directory, 'empty-music');
        if (!folders.length) mkdirSync(music, { recursive: true, mode: 0o700 });
        st = await state(dataDir); local = `http://127.0.0.1:${st.port}`;
        const child = spawn(navidromeBin, [], {
          stdio: 'inherit', env: { ...process.env, ND_ADDRESS: '0.0.0.0', ND_PORT: String(st.port), ND_DATAFOLDER: dataDir, ND_CACHEFOLDER: path.join(dataDir, 'cache'), ND_MUSICFOLDER: music,
            ND_DEVAUTOCREATEADMINPASSWORD: st.password, ND_ENABLEINSIGHTSCOLLECTOR: 'false', ...OFFLINE_ENV, ND_SCANNER_SCHEDULE: '1h', ND_SCANNER_FOLLOWSYMLINKS: 'true', ND_SUBSONIC_DEFAULTREPORTREALPATH: 'true', ND_LOGLEVEL: 'warn' },
        });
        navidrome = child;
        child.on('error', error => { if (navidrome !== child) return; startupError = `Cannot start the bundled music server: ${error.message}`; phase = 'error'; changed(); });
        child.on('exit', (code, signal) => { if (navidrome === child && !app.isQuitting && phase === 'ready') { startupError = `The music server stopped (${signal || `exit ${code}`}). Restart Kept to reconnect.`; phase = 'error'; changed(); } });
        await waitFor(`${local}/rest/ping`, child);
        frontendServer = createFrontend();
        await listenFrontend(frontendServer, st.webPort);
        musicDatabase = new MusicDatabase(path.join(profile.directory, 'music.sqlite'));
        if (folders.length) startCatalog(music, config.musicFolders)
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
  const queueReconstruction = () => library?.reconstruct?.enqueuePending({ folders: profileMusicFolders(config) })?.catch(error => console.error('Kept jobs:', error.message))
  // After every finished scan the identity spine learns the files Navidrome found.
  function startCatalog(root, folders) {
    const resolver = createTrackPathResolver({ root, folders, combined: Boolean(config.combinedMusicFolders) })
    catalogSync = startCatalogSync({
      connection: { base: local, username: st.username, password: st.password }, catalog: catalogDatabase.store, folders,
      resolveFile: song => resolver.resolve(song).file,
      prefetchHashes: library.hashJobs.prefetch, hashFile: library.hashJobs.hash,
      onChange: result => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('catalog:changed')
        // A finished scan: albums that are new or changed go through the reconstruction ladder.
        if (result) void queueReconstruction()
        // A finished scan: the assets it found are queued for analysis.
        if (result) void library.analyse()
      },
      onError: error => console.error('Kept catalog:', error.message),
    })
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
    startupWarning = 'Some settings from an older version could not be imported. Your music is still available. Restart Kept to retry the import.';
  }
  await initialWindow.loadURL(page);
  bootstrapping = false;
  if (config.setupComplete) void start().catch(() => {});
}).catch(error => { dialog.showErrorBox('Cannot open Kept', error.message); app.quit(); });

let switchingProfile = false;
function scheduleRelaunch(args) {
  app.relaunch({ execPath: process.env.APPIMAGE || process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...args] });
  // Let the invoking renderer receive its result before shutdown destroys it.
  setTimeout(() => app.quit(), 150);
}
async function stopServices() {
  const database = musicDatabase, server = frontendServer, child = navidrome;
  const sync = catalogSync
  musicDatabase = null;
  frontendServer = null;
  lanCatalog?.revokeAll()
  navidrome = null;
  catalogSync = undefined
  // The run in flight is aborted and has left the catalog before the server it reads from goes away.
  const stopCatalog = async () => { await sync?.stop() }
  const results = await Promise.allSettled([database?.close(), closeFrontend(server), stopMusicServer(child), stopCatalog()]);
  for (const result of results) if (result.status === 'rejected') console.error('Kept cleanup:', result.reason);
}

let shutdownComplete = false, shuttingDown = false;
app.on('before-quit', event => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true; app.isQuitting = true;
  clearTimeout(catalogChangeTimer)
  void (async () => {
    await stopServices();
    await library?.stop().catch(error => console.error('Kept cleanup:', error))
    await featureDatabase?.close().catch(error => console.error('Kept cleanup:', error))
    await catalogDatabase?.close().catch(error => console.error('Kept cleanup:', error))
    if (app.isReady() && hasInstanceLock) electronSession.defaultSession.flushStorageData();
  })().finally(() => { shutdownComplete = true; app.quit(); });
});
// Keep stale PID locks after crashes/exit. A new process reclaims them only when
// the former owner is gone, including Chromium's final storage flush.
app.on('window-all-closed', () => { if (!bootstrapping) app.quit(); });
