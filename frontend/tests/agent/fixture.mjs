// Synthetic local music only; no real account, files or audio output.
export const bootstrap = (controlAudit = false) => {
  const w = window;
  localStorage.clear();
  localStorage.setItem('motion', '0');
  const desktopStatus = {
    phase: 'ready', onboarding: false, error: '', url: location.origin, username: 'audit', password: 'test-only', frame: true,
    build: { version: 'audit', channel: 'preview', commit: '', branch: 'synthetic-core', builtAt: '', runUrl: '' },
    profile: { name: 'audit', label: 'Synthetic audit', directory: '/synthetic/Data/profiles/audit', existing: false, portable: true },
    musicFolder: '/synthetic/Music', musicFolders: ['/synthetic/Music'], defaultMusicFolder: '/synthetic/Music', defaultMusicFolderAvailable: true, source: 'local', canCopy: false,
  };
  if (controlAudit) desktopStatus.share = { webPort: Number(location.port), port: Number(location.port), password: 'share-test-only' };
  const listeners = new Set();
  w.__auditDesktopCommands = [];
  const changed = changes => { Object.assign(desktopStatus, changes); for (const listener of listeners) listener(structuredClone(desktopStatus)); };
  w.desktop = {
    status: async () => structuredClone(desktopStatus),
    onChange: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    profiles: async () => [], chooseFolder: async () => '/synthetic/Archive',
    start: async options => { const folders = options?.musicFolders || []; changed({ phase: 'ready', onboarding: false, source: folders.length ? 'local' : 'empty', musicFolders: folders, musicFolder: folders[0] || '' }); return structuredClone(desktopStatus); },
    finishSetup: async () => { changed({ onboarding: false }); return structuredClone(desktopStatus); },
    setFrame: async frame => { w.__auditDesktopCommands.push(['setFrame', frame]); changed({ frame }); },
    changeFolder: async (...args) => { w.__auditDesktopCommands.push(['changeFolder', ...args]); },
    switchProfile: async (...args) => { w.__auditDesktopCommands.push(['switchProfile', ...args]); },
    showData: async () => { w.__auditDesktopCommands.push(['showData']); return ''; },
    restart: async () => { w.__auditDesktopCommands.push(['restart']); }, lanIp: async () => '127.0.0.1',
  };
  if (controlAudit && new URLSearchParams(location.search).has('phone')) {
    delete w.desktop;
    localStorage.setItem('creds', JSON.stringify({ url: location.origin, username: 'share', password: 'share-test-only' }));
    localStorage.setItem('share.phone', JSON.stringify({ mode: 'control', password: 'share-test-only' }));
  }
  const scope = crypto.randomUUID();
  const historyCall = async (method, args) => {
    const response = await fetch(`/audit-history/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...args, scope: `${args.scope}:${scope}` }) });
    const reply = await response.json(); if (!response.ok) throw new Error(reply.error); return reply.value;
  };
  w.musicHistory = { stats: args => historyCall('stats', args), write: args => historyCall('write', args), list: args => historyCall('list', args), clear: scope => historyCall('clear', { scope }) };
  w.__auditCommands = [];
  w.__auditAlbumRevision = -1;
  w.__auditRequestedRevision = -1;
  const nativeFetch = w.fetch?.bind(w);
  if (nativeFetch) w.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    if (String(args[0]).includes('/rest/getAlbumList2')) w.__auditAlbumRevision = Number(response.headers.get('X-Audit-Revision'));
    return response;
  };
  w.__auditRefresh = async () => {
    const response = await fetch('/audit-library/refresh', { method: 'POST' });
    w.__auditRequestedRevision = Number(await response.text());
  };
  // Keep the real media element, decoder, timeupdate and seek behavior. Streams
  // are silent WAVs from the fixture server, never the user's music files.
  if (w.Audio) {
    const NativeAudio = w.Audio;
    w.__auditAudio = [];
    w.Audio = function (...args) { const audio = new NativeAudio(...args); w.__auditAudio.push(audio); return audio; };
    w.Audio.prototype = NativeAudio.prototype;
  }
  if (w.HTMLMediaElement) {
    for (const method of ['play', 'pause']) {
      const original = HTMLMediaElement.prototype[method];
      HTMLMediaElement.prototype[method] = function (...args) { w.__auditCommands.push([method, this.src]); return original.apply(this, args); };
    }
  }
};
