import type { Collection, Source } from './music';

type Metadata = { favorite: boolean; genres: string[]; year?: number };
export type BrowseInput = {
  tiles: Collection[]; source: Source | 'all'; key: string; query: string; artist: string;
  show: string; favoritesOnly: boolean; coversOnly: boolean; sort: string; direction: number; randomSeed: number;
  colorOrder: Record<string, number>; digActive: boolean;
  metadata: (tile: Collection) => Metadata; score: (tile: Collection) => number;
  tagged: (tile: Collection) => boolean; plays: (id: string) => number;
};
export type BrowseOrder = { key: string; ids: string[] };
const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
function randomOrder(id: string, seed: number) {
  let hash = Math.floor(seed * 2147483647);
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function selectBrowseCollections(input: BrowseInput): Collection[] {
  const words = normalize(input.query).trim().split(/\s+/).filter(Boolean);
  const result = input.tiles.filter(tile => {
    const info = input.metadata(tile);
    return (input.source === 'all' || tile.source === input.source) &&
      (!input.favoritesOnly || info.favorite) && (!input.coversOnly || tile.kind !== 'album' || !!tile.cover) && (!input.artist || tile.sub === input.artist) &&
      (input.show !== 'favorites' || info.favorite) &&
      (!input.show.startsWith('genre:') || info.genres.includes(input.show.slice(6))) &&
      (input.show !== 'mood' || input.tagged(tile)) && input.score(tile) > 0 &&
      words.every(word => normalize(`${tile.title} ${tile.sub} ${info.genres.join(' ')}`).includes(word));
  });
  const title = (a: Collection, b: Collection) => collator.compare(a.title, b.title);
  const comparators: Record<string, (a: Collection, b: Collection) => number> = {
    recent: (a, b) => (b.addedAt ?? '').localeCompare(a.addedAt ?? ''),
    title, artist: (a, b) => collator.compare(a.sub, b.sub) || title(a, b),
    year: (a, b) => (input.metadata(a).year ?? 10000) - (input.metadata(b).year ?? 10000) || title(a, b),
    plays: (a, b) => input.plays(b.id) - input.plays(a.id) || title(a, b),
    color: (a, b) => (input.colorOrder[a.id] ?? 361) - (input.colorOrder[b.id] ?? 361) || title(a, b),
    random: (a, b) => randomOrder(a.id, input.randomSeed) - randomOrder(b.id, input.randomSeed),
  };
  const compare = comparators[input.sort];
  if (compare) result.sort(compare);
  if (input.direction === -1 && input.sort !== 'random') result.reverse();
  if (input.digActive) result.sort((a, b) => input.score(b) - input.score(a));
  return result;
}

export function reconcileBrowseOrder(previous: BrowseOrder, key: string, ranked: Collection[]): BrowseOrder {
  if (previous.key !== key) return { key, ids: ranked.map(tile => tile.id) };
  const matches = new Set(ranked.map(tile => tile.id)), known = new Set(previous.ids);
  return { key, ids: [...previous.ids.filter(id => matches.has(id)), ...ranked.filter(tile => !known.has(tile.id)).map(tile => tile.id)] };
}

export function orderedBrowseCollections(ranked: Collection[], order: BrowseOrder): Collection[] {
  const matches = new Map(ranked.map(tile => [tile.id, tile]));
  return order.ids.flatMap(id => { const tile = matches.get(id); return tile ? [tile] : []; });
}
