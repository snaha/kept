// Synthetic local music only; no real account, files or audio output.
export const bootstrap = () => {
  const w = window;
  localStorage.clear();
  localStorage.setItem('motion', '0');
  const desktopStatus = {
    phase: 'ready', onboarding: false, error: '', url: location.origin, username: 'audit', password: 'test-only', frame: true,
    build: { version: 'audit', channel: 'preview', commit: '', branch: 'synthetic-core', builtAt: '', runUrl: '' },
    profile: { name: 'audit', label: 'Synthetic audit', directory: '/synthetic/Data/profiles/audit', existing: false, portable: true },
    musicFolder: '/synthetic/Music', musicFolders: ['/synthetic/Music'], defaultMusicFolder: '/synthetic/Music', defaultMusicFolderAvailable: true, source: 'local', canCopy: false,
  };
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

// A stand-in for the desktop catalog bridge over the fixture's synthetic albums, installed with ?catalog=bridge.
// It holds field provenance, locks and one route-authored change set in memory; no catalog is stored.
export const catalogStandIn = () => {
  const w = window;
  if (!new URLSearchParams(location.search).has('catalog')) return;
  const FIELDS = ['title', 'artist', 'year', 'genre'];
  const params = new URLSearchParams(location.search), estimates = params.get('estimates') === 'on', similar = params.get('similar');
  const ENERGY_STEP = 37, PERCENT = 100;
  const state = { version: 1, overrides: {}, locks: {}, history: [], route: { id: 'route-1', at: 1700000000000, album: 'album-2', undone: false } };
  let albumsPromise;
  const load = () => albumsPromise ??= fetch('/rest/getAlbumList2.view?size=500').then(r => r.json()).then(j => j['subsonic-response'].albumList2.album.map((a, i) => ({
    id: `album:${a.id}`, title: a.name, artist: a.artist, year: a.year, genre: a.genre, favorite: false, availability: 'available', traits: {},
    links: [{ sourceId: 'navidrome', externalId: a.id }], addedAt: 1700000000 + i, trackCount: a.songCount, version: 1,
  })));
  const shape = album => { const o = state.overrides[album.id] ?? {}; return { ...album, ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.value])) }; };
  const sorted = (items, sort) => [...items].sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'added' ? b.addedAt - a.addedAt : (a.artist ?? '').localeCompare(b.artist ?? '') || a.title.localeCompare(b.title));
  const tracksOf = album => [1, 2].map(n => ({ id: `occ-${album.id}-${n}`, albumId: album.id, assetId: `asset-${album.id}-${n}`, position: n, track: n, duration: 180, availability: 'available', title: `Catalog song ${album.id.replace(/^album:album-/, '')} take ${n}`, artist: album.artist, links: [{ sourceId: 'navidrome', externalId: `song-${album.id.replace(/^album:album-/, '')}-${n}` }] }));
  const words = q => q.toLowerCase().split(/\s+/).filter(Boolean);
  w.musicCatalog = {
    // ?estimates=on gives every album an anchor and an estimated energy, the way the analysed library does.
    albums: async () => ({ albums: estimates ? Object.fromEntries((await load()).map(a => [a.links[0].externalId, { albumId: a.id, favorite: false, availability: 'available', traits: {} }])) : {} }), setTrait: async () => ({ applied: true }), setFavorite: async () => ({ applied: true }), migrate: async () => ({ migrated: [], pending: [] }),
    consent: async () => ({}), setConsent: async () => ({}), tool: async () => ({}), onChange: () => () => {},
    estimatedTraits: async () => ({ albums: estimates ? Object.fromEntries((await load()).map((a, i) => [a.id, { energy: { value: (i * ENERGY_STEP) % PERCENT } }])) : {} }),
    // ?similar=sound answers with the next albums as sound neighbours, ?similar=listening with an album that is not analysed yet.
    similarAlbums: async ({ albumId }) => {
      if (similar === 'listening') return { analysed: false, albumIds: [] };
      const all = sorted((await load()).map(shape), 'artist');
      const at = all.findIndex(a => a.id === albumId);
      const SIMILAR_ALBUM_LIMIT = 5;
      return { analysed: true, albumIds: all.slice(at + 1, at + 1 + SIMILAR_ALBUM_LIMIT).map(a => a.id) };
    },
    catalogAlbums: async ({ offset = 0, limit = 100, sort = 'artist', artist } = {}) => { const all = sorted((await load()).map(shape).filter(a => artist === undefined || a.artist === artist), sort); return { albums: all.slice(offset, offset + limit), total: all.length, version: state.version }; },
    catalogAlbum: async ({ albumId }) => { const album = (await load()).map(shape).find(a => a.id === albumId); return { album: album && { ...album, tracks: tracksOf(album) }, version: state.version }; },
    catalogSearch: async request => {
      const all = (await load()).map(shape), ws = words(request.query);
      const hit = a => ws.every(x => `${a.title} ${a.artist}`.toLowerCase().split(/\s+/).some(t => t.startsWith(x)));
      const albums = all.filter(hit), page = (items, p) => p ? items.slice(p.offset, p.offset + p.limit) : [];
      const names = [...new Set(all.filter(a => ws.every(x => a.artist.toLowerCase().startsWith(x))).map(a => a.artist))];
      return { albums: page(albums, request.albums), artists: page(names.map(name => ({ name, albumCount: all.filter(a => a.artist === name).length })), request.artists), tracks: [], trackAlbums: [], version: state.version };
    },
    playbackLinks: async ({ assetIds }) => ({
      links: Object.fromEntries(assetIds.map(id => { const [, a, n] = /^asset-album:album-(\d+)-(\d)$/.exec(id) ?? []; return [id, [{ sourceId: 'navidrome', externalId: `song-${a}-${n}` }]] })),
      version: state.version,
    }),
    albumReview: async ({ albumId }) => {
      const album = (await load()).find(a => a.id === albumId), o = state.overrides[albumId] ?? {}, l = state.locks[albumId] ?? {};
      const routed = state.route.album === albumId.replace('album:', '') && !state.route.undone;
      return { version: state.version, fields: FIELDS.map(field => o[field] ? { field, value: o[field].value, origin: 'user', locked: !!l[field], undoable: true } : routed && field === 'year' ? { field, value: 1984, origin: 'route', by: 'Release lookup', locked: !!l[field], undoable: false } : { field, value: album[field], origin: 'tags', locked: !!l[field], undoable: false }) };
    },
    setField: async ({ albumId, field, value }) => { if (state.locks[albumId]?.[field] === 'kept') {} (state.overrides[albumId] ??= {})[field] = { value }; state.version++; return { applied: true }; },
    lockField: async ({ albumId, field, locked }) => { (state.locks[albumId] ??= {})[field] = locked; state.version++; return { applied: true }; },
    undoField: async ({ albumId, field }) => { delete state.overrides[albumId]?.[field]; state.version++; return { status: 'undone' }; },
    activity: async () => ({ total: 1, entries: [{ id: 'change-route-1', at: state.route.at, actor: 'kept', route: 'Release lookup', summary: 'Release lookup set the year of Album 002', undone: state.route.undone, undoable: !state.route.undone, operations: [{ index: 0, label: 'Year', before: '1972', after: '1984', undone: state.route.undone }] }] }),
    undo: async () => { state.route.undone = true; state.version++; return { status: 'undone' }; },
  };
};

// The optional assistant, as the desktop preload would give it. ?assistant=on answers with a queue from the
// catalog stand-in, ?assistant=off is the opt-in state, ?assistant=fail answers with an API error. Combine with ?catalog=bridge.
export const assistantStandIn = () => {
  const mode = new URLSearchParams(location.search).get('assistant');
  if (!mode) return;
  const status = { enabled: mode !== 'off', provider: 'anthropic', model: 'claude-sonnet-5-5', models: { anthropic: 'claude-sonnet-5-5', local: '' }, baseUrl: 'http://localhost:11434/v1', hasKey: mode !== 'off', canStoreKey: true };
  const queue = [1, 2, 3].flatMap(a => [1, 2].map(n => ({ occurrenceId: `occ-album:album-${a}-${n}`, albumId: `album:album-${a}`, title: `Catalog song ${n}`, artist: `Artist ${a}`, album: `Album 00${a}` })));
  window.musicAssistant = {
    status: async () => ({ ...status }),
    save: async change => Object.assign(status, { enabled: change.enabled ?? status.enabled, hasKey: change.apiKey ? true : change.clearKey ? false : status.hasKey }),
    cancel: async () => {},
    ask: async ({ request }) => {
      await new Promise(resolve => setTimeout(resolve, 600));
      if (mode === 'fail') throw new Error('The API key was not accepted. Check it in Settings.');
      return { message: `Here is a queue for "${request}".`, queue, steps: [{ tool: 'search_catalog', ok: true, detail: '12 results' }, { tool: 'build_queue', ok: true, detail: '6 tracks' }] };
    },
  };
};
