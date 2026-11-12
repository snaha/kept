import http from 'node:http';
import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { attachControl } from '../../../desktop/control-relay.js';
import { MusicDatabase } from '../../../desktop/music-database.js';
const historyDirectory = await mkdtemp(path.join(os.tmpdir(), 'music-audit-'));
const history = new MusicDatabase(path.join(historyDirectory, 'music.sqlite'));
import { bootstrap } from './fixture.mjs';

const root = path.resolve(import.meta.dirname, '../../dist');
const port = Number(process.env.MUSIC_AUDIT_PORT || 4178);
import { albums, songs, artists, playlists, playlistSongs } from './data.mjs';
let revision = 0;
const sampleRate = 8000, byteLength = sampleRate * 180 * 2;
const wav = Buffer.alloc(44 + byteLength);
wav.write('RIFF', 0); wav.writeUInt32LE(36 + byteLength, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(byteLength, 40);
const controlAudit = process.env.MUSIC_AUDIT_CONTROL === '1';
const injection = `<script>(${bootstrap.toString()})(${controlAudit});</script>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname.startsWith('/audit-history/') && req.method === 'POST') {
    const method = url.pathname.split('/').pop();
    res.setHeader('Content-Type', 'application/json');
    try {
      if (!['write', 'list', 'clear', 'stats'].includes(method)) throw new Error('Unknown history operation');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const value = await history.call(method, JSON.parse(Buffer.concat(chunks).toString()));
      res.end(JSON.stringify({ value }));
    } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (url.pathname === '/audit-library/refresh' && req.method === 'POST') { revision++; res.end(String(revision)); return; }
  if (url.pathname.startsWith('/rest/')) {
    const method = url.pathname.split('/').pop().replace('.view', '');
    if (method === 'getCoverArt') { res.setHeader('Content-Type', 'image/svg+xml'); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><rect width="400" height="400" fill="#4b3c57"/><circle cx="200" cy="200" r="140" fill="#b1baa2"/></svg>'); return; }
    if (method === 'stream') {
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = range ? Number(range[1]) : 0, end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.setHeader('Content-Type', 'audio/wav'); res.setHeader('Accept-Ranges', 'bytes');
      if (start >= wav.length || end < start) { res.writeHead(416).end(); return; }
      if (range) { res.statusCode = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${wav.length}`); }
      res.setHeader('Content-Length', end - start + 1); res.end(wav.subarray(start, end + 1)); return;
    }
    if (method === 'getAlbumList2') res.setHeader('X-Audit-Revision', String(revision));
    const bodies = {
      ping: {}, getUser: { user: { username: 'audit', adminRole: true } },
      getAlbumList2: { albumList2: { album: albums.slice(Number(url.searchParams.get('offset') || 0), Number(url.searchParams.get('offset') || 0) + Number(url.searchParams.get('size') || 500)).map(album => ({ ...album, songCount: album.songCount + revision })) } },
      getPlaylists: { playlists: { playlist: playlists } },
      getAlbum: { album: { ...albums.find(album => album.id === url.searchParams.get('id')), song: songs.filter(song => song.albumId === url.searchParams.get('id')) } },
      getArtist: { artist: { ...artists.find(artist => artist.id === url.searchParams.get('id')), album: albums.filter(album => album.artist === artists.find(artist => artist.id === url.searchParams.get('id'))?.name) } },
      getPlaylist: { playlist: { ...playlists[0], entry: playlistSongs } },
      getScanStatus: { scanStatus: { scanning: false, count: songs.length + revision, lastScan: String(revision) } }, scrobble: {},
    };
    const words = (url.searchParams.get('query') || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().split(/\s+/).filter(Boolean);
    const match = item => words.every(word => Object.values(item).join(' ').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(word));
    const page = (items, key) => { const offset = Number(url.searchParams.get(`${key}Offset`) || 0); return items.filter(match).slice(offset, offset + Number(url.searchParams.get(`${key}Count`) ?? 50)); };
    const body = method === 'search3' ? { searchResult3: { album: page(albums, 'album'), song: page(songs, 'song'), artist: page(artists, 'artist') } } : bodies[method];
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ 'subsonic-response': { status: 'ok', version: '1.16.1', ...body } }));
    return;
  }
  const file = path.resolve(root, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
  if (!file.startsWith(`${root}${path.sep}`)) { res.writeHead(403).end(); return; }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
    const data = await readFile(file);
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
    res.end(file.endsWith('index.html') ? data.toString().replace('<head>', `<head>${injection}`) : data);
  } catch { res.writeHead(404).end('Not found; build the frontend first.'); }
});
const controlRelay = controlAudit ? attachControl(server, { sharePassword: 'share-test-only', hostPassword: 'test-only' }) : undefined;
server.listen(port, '127.0.0.1', () => console.log(`Music regression fixture: http://127.0.0.1:${port} (synthetic local library, real silent WAV playback)`));
const stop = () => { controlRelay?.close(); server.close(async () => { await history.close(); await rm(historyDirectory, { recursive: true, force: true }); }); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
