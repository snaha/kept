// Credentials and startup state are read after the selected profile is ready.
import { contextBridge, ipcRenderer } from 'electron';
import { featuresFromArgv } from './feature-argument.js';
const desktopCall = async (name, ...args) => {
  const reply = await ipcRenderer.invoke(`desktop:${name}`, ...args);
  if (reply.error) throw new Error(reply.error);
  return reply.value;
};
contextBridge.exposeInMainWorld('desktop', {
  status: () => desktopCall('status'), start: options => desktopCall('start', options),
  chooseFolder: () => desktopCall('choose-folder'), finishSetup: () => desktopCall('finish-setup'),
  profiles: () => desktopCall('profiles'), switchProfile: (mode, name) => desktopCall('switch-profile', mode, name),
  showData: () => desktopCall('show-data'), changeFolder: (mode, folder) => desktopCall('change-folder', mode, folder),
  restart: () => desktopCall('restart'),
  lanIp: () => desktopCall('lan-ip'), setFrame: on => desktopCall('set-frame', on),
  lanShare: () => desktopCall('lan-share'),
  onChange: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('desktop:changed', listener);
    return () => ipcRenderer.removeListener('desktop:changed', listener);
  },
});

contextBridge.exposeInMainWorld('musicHistory', {
  stats: (query) => ipcRenderer.invoke('music-history:stats', query),
  write: (batch) => ipcRenderer.invoke('music-history:write', batch),
  list: (query) => ipcRenderer.invoke('music-history:list', query),
  clear: (scope) => ipcRenderer.invoke('music-history:clear', { scope }),
});

// The identity spine: decisions and consent, the catalog the window browses, and the review of its fields.
const catalogCall = async (operation, ...args) => {
  const reply = await ipcRenderer.invoke(`catalog:${operation}`, ...args)
  if (reply.error) throw new Error(reply.error)
  return reply.value
}
contextBridge.exposeInMainWorld('musicCatalog', {
  albums: () => catalogCall('albums'),
  setTrait: request => catalogCall('set-trait', request),
  setFavorite: request => catalogCall('set-favorite', request),
  migrate: request => catalogCall('migrate', request),
  consent: () => catalogCall('consent'),
  setConsent: request => catalogCall('set-consent', request),
  activity: request => catalogCall('activity', ...(request === undefined ? [] : [request])),
  undo: request => catalogCall('undo', request),
  tool: request => catalogCall('tool', request),
  estimatedTraits: () => catalogCall('estimated-traits'),
  similarAlbums: request => catalogCall('similar-albums', request),
  catalogAlbums: request => catalogCall('catalog-albums', ...(request === undefined ? [] : [request])),
  catalogAlbum: request => catalogCall('catalog-album', request),
  catalogSearch: request => catalogCall('catalog-search', request),
  playbackLinks: request => catalogCall('playback-links', request),
  albumReview: request => catalogCall('album-review', request),
  setField: request => catalogCall('set-field', request),
  lockField: request => catalogCall('lock-field', request),
  undoField: request => catalogCall('undo-field', request),
  onChange: callback => {
    const listener = () => callback()
    ipcRenderer.on('catalog:changed', listener)
    return () => ipcRenderer.removeListener('catalog:changed', listener)
  },
})

// Background jobs: the window tells the library worker what the audio element is doing, so playback
// is never starved, and shows how far the work has got.
contextBridge.exposeInMainWorld('musicJobs', {
  reportPlayback: report => ipcRenderer.send('jobs:playback', report),
  status: async () => {
    const reply = await ipcRenderer.invoke('jobs:status')
    if (reply.error) throw new Error(reply.error)
    return reply.value
  },
  onChange: callback => {
    const listener = (_event, status) => callback(status)
    ipcRenderer.on('jobs:changed', listener)
    return () => ipcRenderer.removeListener('jobs:changed', listener)
  },
})

// The optional assistant. The key is typed once into Settings and kept by the main process: the window can learn that one exists.
const assistantCall = async (operation, request) => {
  const reply = await ipcRenderer.invoke(`assistant:${operation}`, request)
  if (reply.error) throw new Error(reply.error)
  return reply.value
}
contextBridge.exposeInMainWorld('musicAssistant', {
  status: () => assistantCall('status'),
  save: change => assistantCall('save', change),
  ask: request => assistantCall('ask', request),
  cancel: id => assistantCall('cancel', id),
})

// Spotify, playback only. The main process holds the tokens: the window gets a status and a few commands.
const spotifyCall = async (operation, request) => {
  const reply = await ipcRenderer.invoke(`spotify:${operation}`, request)
  if (reply.error) throw new Error(reply.error)
  return reply.value
}
// A trial feature: only a profile that turned it on gets the bridge (features.js).
if (featuresFromArgv(process.argv).has('spotify')) {
  contextBridge.exposeInMainWorld('musicSpotify', {
    status: () => spotifyCall('status'),
    connect: clientId => spotifyCall('connect', clientId),
    disconnect: () => spotifyCall('disconnect'),
    devices: () => spotifyCall('devices'),
    selectDevice: id => spotifyCall('select-device', id),
    search: query => spotifyCall('search', query),
    command: (action, value) => spotifyCall('command', { action, value }),
    playback: () => spotifyCall('playback'),
    onChange: callback => {
      const listener = (_event, status) => callback(status)
      ipcRenderer.on('spotify:changed', listener)
      return () => ipcRenderer.removeListener('spotify:changed', listener)
    },
  })
}
