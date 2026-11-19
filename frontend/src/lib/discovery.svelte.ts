import { readJsonPreference, writePreference } from './preferences';
import { untrack } from 'svelte';
import { session } from './api.svelte';
import { listeningHistory, loadHistory, historyStats } from './listening-history.svelte';
import { artworkHue } from './artwork-palette';
import { localId, type Collection } from './music';
import { randomId } from './random-id';
import type { AlbumState, AlbumTarget, MigrationAlbum, TraitValues } from './catalog';
import { isVirtualCollection } from './virtual-catalog';
import { TRAIT_KEYS, isTraitValue, resolveTraits, hasReadings, type Traits, type EstimatedTraits } from './traits';

export type { Traits };
const MAX_AXIS_DISTANCE = 45, MIN_SCORED_AXES = 1, PERCENT = 100, FAMILIARITY_PER_DOUBLING = 20;
export type AlbumMetadata = { favorite?: boolean; genres?: string[]; year?: number; traits?: Partial<Traits>; hue?: number; colorRevision?: string; colorReady?: boolean };
export const catalog = $state({ items: {} as Record<string, AlbumMetadata>, estimated: {} as Record<string, EstimatedTraits>, colors: {} as Record<string, Pick<AlbumMetadata, 'hue' | 'colorRevision' | 'colorReady'>>, stats: {} as Record<string, { plays: number; lastPlayed: number }>, error: '', colorsLoading: false });
export const dig = $state({ open: false, moodOn: false, mood: 50, energy: 50, familiarity: 50, acoustic: 50, vocal: 50, preset: '' });
export const digActive = () => dig.moodOn || dig.familiarity !== 50 || dig.acoustic !== 50 || dig.vocal !== 50;
export const presets = [
  ['Rainy afternoon', 30, 25, 65, 50], ['Focus time', 50, 25, 50, 15], ['Chill like a chinchilla', 65, 20, 60, 50],
  ['Aperitivo with friends', 70, 45, 60, 70], ['Dance baby dance', 85, 85, 15, 65], ['Late night', 35, 30, 30, 40],
  ['Morning bird', 75, 55, 65, 65], ['Cooking at home', 70, 45, 65, 75], ['Dreaming space', 50, 20, 15, 15], ['Road trip', 75, 75, 35, 75]
] as const;
export function resetDig() { Object.assign(dig, { moodOn: false, mood: 50, energy: 50, familiarity: 50, acoustic: 50, vocal: 50, preset: '' }); }
export function choosePreset(preset: typeof presets[number]) {
  Object.assign(dig, { preset: preset[0], moodOn: true, mood: preset[1], energy: preset[2], acoustic: preset[3], vocal: preset[4] });
}
let storageKey = '', saveTimer: ReturnType<typeof setTimeout> | undefined, statsRevision = 0;
const accountKey = () => `music.catalog.v1:${window.desktop ? 'desktop' : session.base}:${session.username}`;
function clean(value: unknown): AlbumMetadata {
  if (!value || typeof value !== 'object') return {};
  const item = value as AlbumMetadata;
  const kept = item.traits && typeof item.traits === 'object' ? Object.fromEntries(TRAIT_KEYS.filter(key => isTraitValue(item.traits![key])).map(key => [key, item.traits![key]])) as Partial<Traits> : {};
  const traits = Object.keys(kept).length ? kept : undefined;
  return { favorite: typeof item.favorite === 'boolean' ? item.favorite : undefined,
    genres: Array.isArray(item.genres) ? item.genres.filter(genre => typeof genre === 'string').slice(0, 20) : undefined,
    year: Number.isInteger(item.year) && item.year! > 0 && item.year! <= 9999 ? item.year : undefined, traits,
    hue: Number.isFinite(item.hue) ? item.hue : undefined, colorRevision: typeof item.colorRevision === 'string' ? item.colorRevision : undefined, colorReady: item.colorReady === true };
}
export function loadCatalog() {
  const key = accountKey();
  if (storageKey === key) return;
  if (storageKey) flush();
  clearTimeout(saveTimer); colorQueue.clear();
  storageKey = key; catalog.stats = {}; catalog.estimated = {}; catalog.error = ''; resetDig();
  try { const data = readJsonPreference(key, {}); catalog.items = Object.fromEntries(Object.entries(data).map(([id, value]) => [id, clean(value)])); }
  catch { catalog.items = {}; }
  try { catalog.colors = Object.fromEntries(Object.entries(readJsonPreference(`${key}:colors`, {})).map(([id, value]) => [id, clean(value)])); } catch { catalog.colors = {}; }
  edited.clear(); syncRevision++;
  void syncDecisions();
  loadHistory();
}
// What the library last heard for an album whose edit is still in the user's hand.
const held = new Map<string, AlbumMetadata | undefined>();
/**
 * Saves on this device at once. `settled: false` is a control still moving, such as a slider
 * mid-drag: the library hears of it once, when the value settles, so one gesture is one change.
 */
export function saveMetadata(id: string, patch: AlbumMetadata, { settled = true } = {}) {
  const before = catalog.items[id], after = clean({ ...before, ...patch });
  catalog.items[id] = after;
  persist();
  if (!settled) { if (!held.has(id)) held.set(id, before); return; }
  writeDecisions(id, held.has(id) ? held.get(id) : before, after);
  held.delete(id);
}
// The identity spine (desktop only) keeps hand-set traits and favourites as user decisions on
// an album anchor, so they survive a re-scan and a server re-ID. The window names an album by
// its server ID; the desktop resolves the anchor. Device preferences stay complete as the
// fallback: every edit is still written there, and nothing here deletes them.
const ALBUM_PREFIX = localId('album', ''), SPINE_SYNC_DELAY = 400;
const SPINE_ERROR = 'Your tags could not be saved to the library. They are still kept on this device.';
// An album of the library's own catalog is named by its anchor, one of the music server's by the server's ID.
const ANCHOR_PREFIX = 'album:';
const albumTarget = (id: string): AlbumTarget | undefined => {
  if (!id.startsWith(ALBUM_PREFIX)) return undefined;
  const raw = id.slice(ALBUM_PREFIX.length);
  return raw.startsWith(ANCHOR_PREFIX) ? { albumId: raw } : { providerAlbumId: raw };
};
const decisionQueue = new Map<string, () => Promise<unknown>>(), edited = new Map<string, number>();
let draining = false, editClock = 0, syncRevision = 0, syncTimer: ReturnType<typeof setTimeout> | undefined;
// One writer, in order. A newer value for the same album and axis replaces one still waiting.
async function drainDecisions() {
  draining = true;
  while (decisionQueue.size) {
    const [key, send] = decisionQueue.entries().next().value!;
    decisionQueue.delete(key);
    try { await send(); } catch { catalog.error = SPINE_ERROR; }
  }
  draining = false;
}
function writeDecisions(id: string, before: AlbumMetadata | undefined, after: AlbumMetadata) {
  const bridge = window.musicCatalog, album = albumTarget(id);
  if (!bridge || !album) return;
  edited.set(id, ++editClock);
  for (const trait of TRAIT_KEYS) {
    const value = after.traits?.[trait];
    if (before?.traits?.[trait] === value) continue;
    // The edit names its own change set, so sending it again after a lost reply applies nothing twice.
    const request = { ...album, trait, value, changeId: `change:${randomId()}` };
    decisionQueue.set(`${id}:${trait}`, () => bridge.setTrait(request).catch(() => bridge.setTrait(request)));
  }
  const favorite = after.favorite;
  if (favorite !== undefined && before?.favorite !== favorite) {
    const request = { ...album, value: favorite, changeId: `change:${randomId()}` };
    decisionQueue.set(`${id}:favorite`, () => bridge.setFavorite(request).catch(() => bridge.setFavorite(request)));
  }
  if (!draining) void drainDecisions();
}
function migrationAlbums(): MigrationAlbum[] {
  const albums: MigrationAlbum[] = [];
  for (const [id, item] of Object.entries(catalog.items)) {
    // What is kept under an anchor came from the library: only the music server's albums wait to be migrated.
    const album = albumTarget(id)?.providerAlbumId;
    if (album && (item.favorite !== undefined || item.traits)) albums.push({ providerAlbumId: album, favorite: item.favorite, traits: item.traits && { ...item.traits } });
  }
  return albums;
}
function splitTraits(traits: TraitValues) {
  const hand: Partial<Traits> = {}, estimated: EstimatedTraits = {};
  for (const key of TRAIT_KEYS) {
    const trait = traits[key];
    if (trait?.provenance === 'hand-set') hand[key] = trait.value; else if (trait) estimated[key] = { value: trait.value };
  }
  return { hand, estimated };
}
const sameTraits = (a: Partial<Traits> | undefined, b: Partial<Traits>) => TRAIT_KEYS.every(key => a?.[key] === b[key]);
/**
 * Replays the one-time migration of device tags into user decisions, then shows what the
 * spine holds for every album it has anchored. Safe to repeat: the migration carries the
 * time of its first run, so it never overrides a later choice. Albums not scanned yet keep
 * their device values and are migrated by a later run.
 */
export async function syncDecisions() {
  const bridge = window.musicCatalog, key = storageKey;
  if (!bridge || !key) return;
  const revision = ++syncRevision, clock = editClock;
  try {
    const marker = readJsonPreference<{ decidedAt?: number }>(`${key}:spine`, {});
    const decidedAt = Number.isSafeInteger(marker.decidedAt) && marker.decidedAt! > 0 ? marker.decidedAt! : Date.now();
    if (decidedAt !== marker.decidedAt && !writePreference(`${key}:spine`, JSON.stringify({ decidedAt }))) return;
    const albums = migrationAlbums();
    if (albums.length) await bridge.migrate({ decidedAt, albums });
    const states = (await bridge.albums()).albums;
    // Computed energy is a view of the analysed sound. When it cannot be read, what is shown stays.
    const computed = typeof bridge.estimatedTraits === 'function' ? await bridge.estimatedTraits().then(reply => reply.albums, () => undefined) : undefined;
    // A newer run, another account or an edit made meanwhile owns what is on screen.
    if (key !== storageKey || revision !== syncRevision) return;
    const show = (id: string, state: AlbumState) => {
      const item = catalog.items[id];
      // An edit made meanwhile, or one still in the user's hand, owns what is on screen.
      if ((edited.get(id) ?? 0) > clock || held.has(id)) return;
      const { hand, estimated } = splitTraits(state.traits);
      // A hand value is never replaced: the reading shows it first, and this only fills an axis that has none.
      const energy = computed ? computed[state.albumId]?.energy : catalog.estimated[id]?.energy;
      if (energy && hand.energy === undefined) estimated.energy = energy;
      // The spine reports a favourite as yes or no. A device "no" still overrides the server's own star.
      const favorite = state.favorite ? true : item?.favorite === false ? false : undefined;
      if (!sameTraits(item?.traits, hand) || item?.favorite !== favorite) catalog.items[id] = clean({ ...item, traits: Object.keys(hand).length ? hand : undefined, favorite });
      if (JSON.stringify(catalog.estimated[id] ?? {}) !== JSON.stringify(estimated)) setEstimatedTraits(id, estimated);
    };
    // The same decisions under both names of an album: the music server's ID and the anchor the library's catalog lists it by.
    for (const [album, state] of Object.entries(states)) { show(localId('album', album), state); show(localId('album', state.albumId), state); }
  } catch { /* The device preferences keep serving until the next run. */ }
}
function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => void syncDecisions(), SPINE_SYNC_DELAY); }
/** Computed values never touch the saved preferences or the user's decisions; they come from the analysed sound. */
export function setEstimatedTraits(id: string, traits: EstimatedTraits | undefined) {
  if (traits && Object.keys(traits).length) catalog.estimated[id] = traits; else delete catalog.estimated[id];
}
export const traitReadings = (id: string) => resolveTraits(catalog.items[id]?.traits, catalog.estimated[id]);
export const hasTraitReadings = (id: string) => hasReadings(traitReadings(id));
function flush() {
  if (!storageKey) return;
  const items = writePreference(storageKey, JSON.stringify(catalog.items));
  const colors = writePreference(`${storageKey}:colors`, JSON.stringify(catalog.colors));
  // The preferences service owns retryable persistence errors.
  if (items && colors) catalog.error = '';
}
function persist() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 200); }
export function metadata(tile: Collection) {
  const item = catalog.items[tile.id];
  if (!isVirtualCollection(tile)) return { favorite: item?.favorite ?? tile.favorite ?? false, genres: item?.genres ?? tile.genres ?? [], year: item?.year ?? tile.year, traits: item?.traits };
  // An album of the library's catalog shows the catalog's genre and year, which are corrected and undone there.
  // What was typed on this device, also under the music server's ID, only fills what the catalog lacks.
  const typed = [item, ...(tile.aliases ?? []).map(id => catalog.items[id])];
  return {
    favorite: item?.favorite ?? tile.favorite ?? false, traits: item?.traits,
    genres: tile.genres?.length ? tile.genres : typed.find(entry => entry?.genres?.length)?.genres ?? [],
    year: tile.year ?? typed.find(entry => entry?.year)?.year,
  };
}
/** Plays of an album, counting those recorded under the ID the music server gave it. */
export const albumPlays = (tile: Pick<Collection, 'id' | 'aliases'>) => [tile.id, ...(tile.aliases ?? [])].reduce((plays, id) => plays + (catalog.stats[id]?.plays || 0), 0);
// An album is scored only on the axes it has values for, so a missing mood
// does not hide it and estimated values can fill some axes.
export function digScore(tile: Collection) {
  if (!digActive()) return 1;
  const readings = traitReadings(tile.id);
  const distances: number[] = [];
  const axes = [...(dig.moodOn ? ['mood', 'energy'] as const : []), ...(['acoustic', 'vocal'] as const).filter(key => dig[key] !== 50)];
  for (const key of axes) { const reading = readings[key]; if (reading) distances.push(Math.abs(reading.value - dig[key])); }
  if (dig.familiarity !== 50) {
    const plays = albumPlays(tile);
    const familiarity = Math.min(PERCENT, Math.log2(plays + 1) * FAMILIARITY_PER_DOUBLING);
    distances.push(Math.abs(familiarity - (PERCENT - dig.familiarity)));
  }
  return distances.length >= MIN_SCORED_AXES && Math.max(...distances) <= MAX_AXIS_DISTANCE ? 1 - distances.reduce((a, b) => a + b, 0) / distances.length / PERCENT : 0;
}
export function coverRevision(tile: Collection) {
  // A local artwork ID survives auth salts and profile port changes.
  // Other URLs retain their full identity so changed external artwork invalidates.
  let identity = tile.cover;
  try {
    const url = new URL(tile.cover);
    const id = url.searchParams.get('id');
    if (tile.source === 'local' && url.pathname.endsWith('/rest/getCoverArt') && id) identity = `local:${id}:${url.searchParams.get('size') || ''}`;
  } catch { /* Relative and external artwork keeps its original identity. */ }
  let hash = 2166136261;
  for (const char of identity) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(36);
}
const colorQueue = new Map<string, Collection>();
let colorRunning = false, colorLifetime = 0;
export function warmColors(tiles: Collection[]) {
  for (const tile of tiles) if (tile.cover && (!catalog.colors[tile.id]?.colorReady || catalog.colors[tile.id]?.colorRevision !== coverRevision(tile))) colorQueue.set(tile.id, tile);
  if (!colorRunning) void consumeColors();
}
async function consumeColors() {
  colorRunning = true; catalog.colorsLoading = true;
  while (colorQueue.size) {
    const batch = [...colorQueue.values()].slice(0, 3);
    for (const tile of batch) colorQueue.delete(tile.id);
    const key = storageKey, lifetime = colorLifetime;
    await Promise.all(batch.map(async tile => {
      const hue = await artworkHue(tile.cover);
      if (lifetime === colorLifetime && storageKey === key && (!colorQueue.has(tile.id) || coverRevision(colorQueue.get(tile.id)!) === coverRevision(tile))) { catalog.colors[tile.id] = { hue, colorRevision: coverRevision(tile), colorReady: true }; persist(); }
    }));
    await new Promise(resolve => setTimeout(resolve, 32));
  }
  colorRunning = false; catalog.colorsLoading = false;
}
export function startDiscovery() {
 const destroy = $effect.root(() => {
  $effect(() => { if (!session.api) return; session.username; session.base; untrack(loadCatalog); });
  $effect(() => {
    if (!session.api) return;
    listeningHistory.total; listeningHistory.persistedRevision; session.username; session.base;
    const revision = ++statsRevision;
    const timer = setTimeout(async () => {
      try { const stats = await historyStats(); if (stats && revision === statsRevision) catalog.stats = stats; }
      catch { /* Keep the last successful durable counts until a write completes or retries. */ }
    }, 250);
    return () => clearTimeout(timer);
  });
});
 // A finished scan anchors new albums: migrate what waited for them and show their decisions.
 const unwatch = window.musicCatalog?.onChange(scheduleSync);
 return () => { destroy(); unwatch?.(); clearTimeout(syncTimer); syncRevision++; statsRevision++; colorLifetime++; clearTimeout(saveTimer); colorQueue.clear(); flush(); };
}
