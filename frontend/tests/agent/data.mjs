// Shared local Subsonic catalog for deterministic browser checks.
export const albums = Array.from({ length: 240 }, (_, i) => ({
  id: `album-${i}`, name: i === 0 ? 'A very long album title with multiple editions and a complete collection of recordings' : `Album ${String(i).padStart(3, '0')}`,
  // album-0 is David Bowie so it stays the first tile under the default artist order as well as by title
  artist: i % 2 ? 'Various Artists' : 'David Bowie', songCount: 2,
  year: 1970 + i % 54, genre: i % 2 ? 'Rock' : 'Jazz', coverArt: `cover-${i}`, created: '2020-01-01T00:00:00Z',
}));
export const songs = albums.flatMap((album, i) => [1, 2].map(n => ({
  id: `song-${i}-${n}`, title: i === 0 ? `Included song ${n} with a longer title` : `Catalog song ${i} take ${n}`,
  artist: album.artist, album: album.name, albumId: album.id, duration: 180,
  track: i === 0 ? 1 : n, discNumber: i === 0 ? n : 1, genre: album.genre, coverArt: album.coverArt,
})));
export const artists = [...new Set(albums.map(album => album.artist))].map((name, i) => ({ id: `artist-${i}`, name, albumCount: albums.filter(album => album.artist === name).length, coverArt: 'cover-0' }));
export const playlists = [{ id: 'quiet-evenings', name: 'Quiet evenings', songCount: 3, coverArt: 'cover-0' }];
export const playlistSongs = [songs[0], songs[1], songs[0]];
