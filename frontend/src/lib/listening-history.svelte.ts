import { HISTORY_SCHEMA_VERSION, isListeningContext } from '../../../shared/contracts';
import { readJsonPreference, writePreference } from './preferences';
import { coverUrl, session } from './api.svelte';
import type { Collection, Track } from './music';

import type { PlaybackOrigin, ListeningContext, HistoryEntry } from '../../../shared/contracts';
export type { PlaybackOrigin, ListeningContext, HistoryEntry } from '../../../shared/contracts';
export type ListeningStats = Record<string, { plays: number; lastPlayed: number }>;
const browserStats = $state({ values: {} as ListeningStats });
export const listeningHistory = $state({ persistedRevision: 0, entries: [] as HistoryEntry[], total: 0, hasMore: false, loading: false, query: '', error: '' });
let account = '';
let persistenceTimer: ReturnType<typeof setTimeout> | undefined;
let operations: Promise<unknown> = Promise.resolve();
let queryRevision = 0;
let requestedWindow = 50;
let visibleQuery = '';
const pendingClears = new Set<string>();
const queuedContexts = new Map<string, Set<string>>();
const unsaved = new Map<string, ReturnType<typeof snapshot>[]>();
const scope = () => window.desktop ? `desktop:${session.username}` : key();
const key = () => `music.history.v1:${window.desktop ? 'desktop' : session.base}:${session.username}`;

// Keep signed local artwork URLs out of persisted history. Recreate them on use.
function storedTrack(track: Track): Track {
  const { albumInfo: _albumInfo, ...rest } = track;
  return { ...rest, playbackOrigin: rest.playbackOrigin ? { ...rest.playbackOrigin, cover: rest.playbackOrigin.source === 'local' ? '' : rest.playbackOrigin.cover } : undefined, cover: track.source === 'local' ? '' : track.cover };
}
export function historyTrack(track: Track): Track {
  return track.source === 'local' ? { ...track, cover: coverUrl(track.coverId || track.albumId?.replace(/^local:album:/, '') || track.rawId, 512) } : track;
}
export function loadHistory() {
  const next = key();
  if (next === account) return;
  clearTimeout(persistenceTimer);
  if (account && !window.musicHistory) void persist();
  browserStats.values = {};
  account = next; listeningHistory.entries = []; listeningHistory.query = ''; listeningHistory.total = 0; listeningHistory.hasMore = false; listeningHistory.error = '';
  queryRevision++;
  requestedWindow = 50;
  visibleQuery = '';
  try {
    const data = readJsonPreference<{ contexts?: unknown; entries?: unknown; stats?: unknown } | null>(account, null);
    if (!data || !Array.isArray(data.contexts) || !Array.isArray(data.entries)) throw new Error('No legacy history');
    const contexts = new Map<string, ListeningContext>(data.contexts.filter((c: ListeningContext) => isListeningContext(c)).map((c: ListeningContext) => [c.id, c]));
    listeningHistory.entries = data.entries.flatMap((e: HistoryEntry & { contextId: string }) => {
      const context = contexts.get(e.contextId);
      return context && Number.isInteger(e.index) && context.queue[e.index] && typeof e.id === 'string' && Number.isFinite(e.playedAt) && e.playedAt > 0 && e.playedAt <= 8640000000000000 ? [{ id: e.id, context, index: e.index, cursor: Number.isInteger(e.cursor) ? e.cursor : 0, playedAt: e.playedAt }] : [];
    }).slice(0, 100);
    if (data.stats && typeof data.stats === 'object') browserStats.values = Object.fromEntries(Object.entries(data.stats).filter(([, value]) => { const stat = value as ListeningStats[string]; return stat && Number.isInteger(stat.plays) && stat.plays >= 0 && Number.isFinite(stat.lastPlayed); })) as ListeningStats;
    else for (const entry of listeningHistory.entries) countEntry(entry, browserStats.values);
  } catch { /* Missing or corrupt history must never block playback. */ }
  listeningHistory.total = listeningHistory.entries.length;
  if (window.musicHistory) {
    const batch = snapshot();
    const bridge = window.musicHistory;
    const importKey = account;
    unsaved.set(batch.scope, [...(unsaved.get(batch.scope) || []), batch]);
    enqueue(async () => { await bridge.write({ ...batch, entries: [...batch.entries].reverse(), importKey }); if (importKey === account) listeningHistory.persistedRevision++; const pending = unsaved.get(batch.scope); if (pending) unsaved.set(batch.scope, pending.filter(item => item !== batch)); });
    void searchHistory('');
  }
}
function snapshot(entries = listeningHistory.entries, changedContext?: ListeningContext, onlyNew = false) {
  const contexts = new Map(entries.map(e => [e.context.id, e.context]));
  if (onlyNew) for (const id of contexts.keys()) if (queuedContexts.get(scope())?.has(id)) contexts.delete(id);
  if (changedContext) contexts.set(changedContext.id, changedContext);
  return $state.snapshot({ version: HISTORY_SCHEMA_VERSION, scope: scope(), contexts: [...contexts.values()].map(c => ({ ...c, origin: c.origin ? { ...c.origin, cover: c.origin.source === 'local' ? '' : c.origin.cover } : undefined, queue: c.queue.map(storedTrack) })), entries: entries.map(({ context, ...e }) => ({ ...e, contextId: context.id })) });
}
function enqueue(task: () => Promise<unknown>) {
  const activeAccount = account;
  const result = operations.then(task);
  operations = result.catch(() => {});
  void result.catch(() => { if (activeAccount === account) listeningHistory.error = 'History could not be saved or loaded. Your current session is still available. Try again.'; });
  return result;
}
function persist(entries = listeningHistory.entries, changedContext?: ListeningContext, onlyNew = false) {
  const batch = snapshot(entries, changedContext, onlyNew);
  if (window.musicHistory) {
    const bridge = window.musicHistory;
    const known = queuedContexts.get(batch.scope) || new Set<string>();
    for (const context of batch.contexts) known.add(context.id);
    queuedContexts.set(batch.scope, known);
    unsaved.set(batch.scope, [...(unsaved.get(batch.scope) || []), batch]);
    return enqueue(async () => {
      const pending = unsaved.get(batch.scope) || [];
      if (!pending.length) return;
      const contexts = new Map(pending.flatMap(item => item.contexts).map(context => [context.id, context]));
      const entries = new Map(pending.flatMap(item => item.entries).map(entry => [entry.id, entry]));
      await bridge.write({ version: HISTORY_SCHEMA_VERSION, scope: batch.scope, contexts: [...contexts.values()], entries: [...entries.values()] });
      unsaved.set(batch.scope, (unsaved.get(batch.scope) || []).filter(item => !pending.includes(item)));
      if (batch.scope === scope()) listeningHistory.persistedRevision++;
    });
  }
  if (writePreference(account, JSON.stringify({ ...batch, stats: $state.snapshot(browserStats.values) }))) { listeningHistory.persistedRevision++; listeningHistory.error = ''; }
  else listeningHistory.error = 'Browser storage is full. Your current session is still available.';
}
export function searchHistory(query = listeningHistory.query, more = false, retainLoaded = false) {
  return refreshHistory(query, { more, retainLoaded });
}
async function refreshHistory(query: string, { more = false, retainLoaded = false, reconcile = false }: { more?: boolean; retainLoaded?: boolean; reconcile?: boolean } = {}) {
  loadHistory();
  const revision = ++queryRevision;
  const activeAccount = account;
  const sameQuery = query === listeningHistory.query;
  const offset = more && sameQuery ? listeningHistory.entries.length : 0;
  if (!sameQuery || (!more && !retainLoaded)) requestedWindow = 50;
  else requestedWindow = Math.max(requestedWindow, listeningHistory.entries.length) + (more ? 50 : 0);
  // Playback reconciles one authoritative page, independent of loaded depth.
  // Explicit searches still refresh the user's requested window.
  const target = reconcile ? 50 : requestedWindow;
  listeningHistory.query = query;
  const bridge = window.musicHistory;
  const activeScope = scope();
  if (!bridge) return;
  listeningHistory.loading = true;
  try {
    const result = await enqueue(async () => {
      if (revision !== queryRevision || activeAccount !== account) return;
      if (pendingClears.has(activeScope) || unsaved.get(activeScope)?.length) throw new Error('Unsaved listening events');
      const entries: HistoryEntry[] = [];
      let total = 0, hasMore = false;
      do {
        const page = await bridge.list({ scope: activeScope, query, offset: offset + entries.length, limit: Math.min(50, target - offset - entries.length) });
        if (revision !== queryRevision || activeAccount !== account) return;
        if (!Array.isArray(page.entries) || !page.entries.every(entry => isListeningContext(entry.context) && Number.isInteger(entry.index) && !!entry.context.queue[entry.index]) || !Number.isInteger(page.total) || page.total < 0) throw new Error('Invalid history response');
        entries.push(...page.entries);
        total = page.total;
        hasMore = page.hasMore;
        if (!page.entries.length) break;
      } while (hasMore && offset + entries.length < target);
      return { entries, total, hasMore };
    }) as { entries: HistoryEntry[]; total: number; hasMore: boolean } | undefined;
    if (!result || revision !== queryRevision || activeAccount !== account) return;
    const contexts = new Map(listeningHistory.entries.map(entry => [entry.context.id, entry.context]));
    const entries = result.entries.map(entry => ({ ...entry, context: contexts.get(entry.context.id) || entry.context }));
    const existingIds = new Set(listeningHistory.entries.map(entry => entry.id));
    if (reconcile && visibleQuery === query) {
      // The last refreshed row must connect to the loaded tail. Without that
      // boundary, retaining old rows would make offset pagination skip a gap.
      const boundary = listeningHistory.entries.findIndex(entry => entry.id === entries.at(-1)?.id);
      listeningHistory.entries = boundary >= 0 ? [...entries, ...listeningHistory.entries.slice(boundary + 1)] : entries;
      requestedWindow = Math.max(50, listeningHistory.entries.length);
    } else {
      listeningHistory.entries = offset ? [...listeningHistory.entries, ...entries.filter(entry => !existingIds.has(entry.id))] : entries;
    }
    visibleQuery = query;
    listeningHistory.total = result.total;
    listeningHistory.hasMore = reconcile ? result.total > listeningHistory.entries.length : result.hasMore;
    listeningHistory.error = '';
  } catch { /* enqueue reports a recoverable error; keep the visible list. */ }
  finally { if (revision === queryRevision) listeningHistory.loading = false; }
}
export function recordHistory(context: ListeningContext, index: number, cursor: number) {
  loadHistory();
  const entry = { id: crypto.randomUUID(), context, index, cursor, playedAt: Date.now() };
  // Only unfiltered history can optimistically include a new listening event.
  if (!window.musicHistory || !listeningHistory.query.trim()) {
    listeningHistory.entries.unshift(entry);
    listeningHistory.total++;
  }
  if (window.musicHistory) {
    void persist([entry], undefined, true);
    void refreshHistory(listeningHistory.query, { retainLoaded: true, reconcile: true });
  } else {
    countEntry(entry, browserStats.values);
    saveHistory();
    listeningHistory.entries = listeningHistory.entries.slice(0, 100);
  }
}
export function saveHistory(context?: ListeningContext) {
  // Storage work follows the immediate playback response.
  clearTimeout(persistenceTimer);
  if (window.musicHistory) { void persist(context ? [] : listeningHistory.entries, context); return; }
  persistenceTimer = setTimeout(() => { void persist(); }, 250);
}
export function retryHistory() {
  if (pendingClears.has(scope())) clearHistory();
  else void persist();
  void refreshHistory(listeningHistory.query, { retainLoaded: true, reconcile: true });
}
export function clearHistory() {
  loadHistory(); clearTimeout(persistenceTimer); queryRevision++; requestedWindow = 50;
  browserStats.values = {};
  listeningHistory.entries = []; listeningHistory.total = 0; listeningHistory.hasMore = false; listeningHistory.loading = false;
  if (window.musicHistory) {
    const bridge = window.musicHistory; const activeScope = scope(); const activeAccount = account;
    const discarded = unsaved.get(activeScope) || [];
    queuedContexts.delete(activeScope);
    pendingClears.add(activeScope);
    void enqueue(async () => {
      await bridge.clear(activeScope);
      unsaved.set(activeScope, (unsaved.get(activeScope) || []).filter(item => !discarded.includes(item)));
      pendingClears.delete(activeScope);
      if (account === activeAccount) { listeningHistory.error = ''; listeningHistory.persistedRevision++; }
    });
  }
  else persist();
}

function countEntry(entry: HistoryEntry, stats: ListeningStats) {
  const track = entry.context.queue[entry.index];
  for (const id of new Set([track?.playbackOrigin?.id || entry.context.origin?.id, track?.albumId].filter(Boolean) as string[])) {
    const old = stats[id]; stats[id] = { plays: (old?.plays || 0) + 1, lastPlayed: Math.max(old?.lastPlayed || 0, entry.playedAt) };
  }
}
export async function historyStats(): Promise<ListeningStats | undefined> {
  loadHistory();
  const activeAccount = account, activeScope = scope();
  // Read only after the serial persistence lane settles, including legacy import.
  await operations;
  if (account !== activeAccount) return;
  const bridge = window.musicHistory;
  if (!bridge) return $state.snapshot(browserStats.values);
  if (pendingClears.has(activeScope) || unsaved.get(activeScope)?.length) throw new Error('Unsaved listening events');
  if (bridge.stats) return bridge.stats({ scope: activeScope });
  // Older desktop bridges still expose the complete durable history through pages.
  const stats: ListeningStats = {};
  for (let offset = 0; ;) {
    const page = await bridge.list({ scope: activeScope, query: '', offset });
    if (account !== activeAccount) return;
    for (const entry of page.entries) countEntry(entry, stats);
    if (!page.hasMore || !page.entries.length) break;
    offset += page.entries.length;
  }
  return stats;
}

export function disposeHistory() { clearTimeout(persistenceTimer); queryRevision++; if (account) void persist(); }
