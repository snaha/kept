import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBrowseCollections, type BrowseInput } from '../src/lib/browse-view.ts';

const tile = (id: string, kind: 'album' | 'playlist', cover: string) =>
  ({ id, rawId: id, source: 'local' as const, kind, title: id, sub: '', cover, count: 1, available: true });
const input = (coversOnly: boolean): BrowseInput => ({
  tiles: [tile('covered', 'album', 'cover.jpg'), tile('bare', 'album', ''), tile('mix', 'playlist', '')],
  source: 'all', key: '', query: '', artist: '', show: 'all', favoritesOnly: false, coversOnly, sort: 'title',
  direction: 1, randomSeed: 0, colorOrder: {}, digActive: false,
  metadata: () => ({ favorite: false, genres: [] }), score: () => 1, tagged: () => false, plays: () => 0,
});

test('covers-only hides albums without cover art and is off by default', () => {
  assert.deepEqual(selectBrowseCollections(input(false)).map(t => t.id), ['bare', 'covered', 'mix']);
  assert.deepEqual(selectBrowseCollections(input(true)).map(t => t.id), ['covered', 'mix']);
});
