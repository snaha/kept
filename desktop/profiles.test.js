import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile, readFile, readdir, rename, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchProfile, newProfile, copyProfile, lockProfile, readJSON, writeJSON } from './profiles.js';

test('preview, portable and fresh profiles isolate normal Kept without clearing its state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-profiles-'));
  try {
    const options = { argv: [], env: {}, appData: directory, channel: 'preview' };
    const preview = launchProfile(options);
    const normal = launchProfile({ ...options, channel: 'stable' });
    const portable = launchProfile({ ...options, argv: ['--data-dir', path.join(directory, 'portable'), '--profile', 'demo'] });
    assert.equal(normal.directory, path.join(directory, 'Kept'));
    assert.equal(preview.directory, path.join(directory, 'Kept Preview', 'profiles', 'default'));
    assert.equal(portable.directory, path.join(directory, 'portable', 'profiles', 'demo'));
    const marker = path.join(normal.directory, 'profile.json');
    writeJSON(marker, { retained: true });
    const fresh = newProfile(preview);
    assert.notEqual(fresh.directory, preview.directory);
    assert.equal(existsSync(fresh.directory), false, 'choosing Fresh does not create or erase data yet');
    assert.deepEqual(readJSON(marker), { retained: true });
    assert.throws(() => launchProfile({ ...options, argv: ['--profile', '../Music'] }), /Profile names/);
    assert.throws(() => launchProfile({ ...options, argv: ['--use-existing', '--profile', 'demo'] }), /on its own/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

async function withAppData(check) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'kept-data-folder-'));
  try { await check(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const keptData = directory => {
  writeJSON(path.join(directory, '.music-profile.lock'), { pid: -1 });
  writeJSON(path.join(directory, 'profile.json'), { setupComplete: true });
};
const launch = (appData, channel, argv = []) => launchProfile({ argv, env: {}, appData, channel });

test('the regular app moves only its own data out of Music, leaving Apple Music’s and anything unknown', () => withAppData(async appData => {
  const music = path.join(appData, 'Music'), kept = path.join(appData, 'Kept');
  keptData(music);
  writeJSON(path.join(music, 'navidrome', 'credentials.json'), { username: 'fixture' });
  for (const file of ['music.sqlite', 'music.sqlite-wal', 'Cookies-journal']) await writeFile(path.join(music, file), file);
  await mkdir(path.join(music, 'Local Storage', 'leveldb'), { recursive: true });
  await mkdir(path.join(music, 'PlaybackSessions', 'IT-1.playbackSessionArchive'), { recursive: true });
  await writeFile(path.join(music, 'unrecognised.bin'), 'not ours to move');
  await writeFile(path.join(music, 'other-app.sqlite'), 'another app’s database');
  await writeFile(path.join(music, 'SingletonCookie'), 'a file, not Chromium’s link');
  await symlink('host-999999999', path.join(music, 'SingletonLock'));

  const preview = launch(appData, 'preview');
  assert.equal(preview.existingDirectory, music, 'a preview launch leaves the regular folder where older Kept finds it');
  assert.equal(existsSync(kept), false);

  const stable = launch(appData, 'stable');
  assert.equal(stable.directory, kept);
  assert.deepEqual(readJSON(path.join(kept, 'navidrome', 'credentials.json')), { username: 'fixture' });
  assert.deepEqual(readJSON(path.join(kept, 'profile.json')), { setupComplete: true });
  for (const file of ['music.sqlite', 'music.sqlite-wal', 'Cookies-journal']) assert.equal(await readFile(path.join(kept, file), 'utf8'), file);
  assert.equal(existsSync(path.join(kept, 'Local Storage', 'leveldb')), true);
  assert.deepEqual((await readdir(music)).sort(), ['PlaybackSessions', 'SingletonCookie', 'other-app.sqlite', 'unrecognised.bin']);
  assert.equal(existsSync(path.join(music, 'PlaybackSessions', 'IT-1.playbackSessionArchive')), true);
  assert.equal(existsSync(kept + '.moving'), false);
  assert.equal(launch(appData, 'stable').directory, kept, 'later launches open Kept');
}));

test('Music Preview is renamed whole by a preview launch', () => withAppData(async appData => {
  writeJSON(path.join(appData, 'Music Preview', 'last-profile.json'), { name: 'trial' });
  writeJSON(path.join(appData, 'Music Preview', 'profiles', 'trial', 'navidrome', 'credentials.json'), { username: 'fixture' });
  assert.equal(launch(appData, 'stable', ['--profile', 'trial']).directory, path.join(appData, 'Music Preview', 'profiles', 'trial'), 'the regular app leaves it');
  const preview = launch(appData, 'preview');
  assert.equal(preview.directory, path.join(appData, 'Kept Preview', 'profiles', 'trial'));
  assert.deepEqual(readJSON(path.join(preview.directory, 'navidrome', 'credentials.json')), { username: 'fixture' });
  assert.equal(existsSync(path.join(appData, 'Music Preview')), false);
}));

test('Music Preview stays while one of its profiles is open', () => withAppData(async appData => {
  writeJSON(path.join(appData, 'Music Preview', 'profiles', 'idle', '.music-profile.lock'), { pid: -1 });
  writeJSON(path.join(appData, 'Music Preview', 'profiles', 'open', '.music-profile.lock'), { pid: process.pid });
  assert.equal(launch(appData, 'preview', ['--profile', 'idle']).directory, path.join(appData, 'Music Preview', 'profiles', 'idle'));
  assert.equal(existsSync(path.join(appData, 'Kept Preview')), false);
}));

test('an open, interrupted or failing move keeps every file in one usable folder', () => withAppData(async appData => {
  const music = path.join(appData, 'Music'), kept = path.join(appData, 'Kept'), staging = kept + '.moving';
  keptData(music);
  writeJSON(path.join(music, '.music-profile.lock'), { pid: process.pid });
  assert.equal(launch(appData, 'stable').directory, music, 'a running older Kept keeps its folder for now');
  assert.equal(existsSync(staging), false);

  writeJSON(path.join(music, '.music-profile.lock'), { pid: -1 });
  await chmod(music, 0o500);
  try { assert.equal(launch(appData, 'stable').directory, music, 'a move that fails is put back'); }
  finally { await chmod(music, 0o700); }
  assert.equal(existsSync(path.join(music, 'profile.json')), true);
  assert.equal(existsSync(staging), false);

  // The lock moves first; Navidrome's folder cannot be moved (macOS needs write access to move a folder).
  writeJSON(path.join(music, 'navidrome', 'credentials.json'), { username: 'fixture' });
  await chmod(path.join(music, 'navidrome'), 0o500);
  try { assert.equal(launch(appData, 'stable').directory, music, 'a move that fails partway is put back'); }
  finally { await chmod(path.join(music, 'navidrome'), 0o700); }
  assert.deepEqual((await readdir(music)).sort(), ['.music-profile.lock', 'navidrome', 'profile.json']);
  assert.equal(existsSync(staging), false);
  await rm(path.join(music, 'navidrome'), { recursive: true });

  await mkdir(staging);
  await rename(path.join(music, 'profile.json'), path.join(staging, 'profile.json'));
  await writeFile(path.join(music, 'music.sqlite'), 'recreated by an older Kept');
  await writeFile(path.join(staging, 'music.sqlite'), 'the moved history');
  const preview = launch(appData, 'preview');
  assert.equal(existsSync(path.join(preview.existingDirectory, 'profile.json')), false, 'half of a moved profile is not offered for copying');
  assert.throws(() => launch(appData, 'preview', ['--use-existing']), /moving its data/);
  assert.equal(launch(appData, 'stable').directory, kept, 'the next regular launch finishes it');
  assert.deepEqual((await readdir(kept)).sort(), ['.music-profile.lock', 'music.sqlite', 'profile.json']);
  assert.equal(await readFile(path.join(kept, 'music.sqlite'), 'utf8'), 'the moved history', 'a resumed move never overwrites');
  assert.deepEqual(await readdir(music), ['music.sqlite']);
}));

test('a Music folder without Kept data, such as Apple Music’s, is left to its owner', () => withAppData(async appData => {
  await mkdir(path.join(appData, 'Music', 'PlaybackSessions'), { recursive: true });
  assert.equal(launch(appData, 'stable').directory, path.join(appData, 'Kept'));
  assert.deepEqual(await readdir(path.join(appData, 'Music')), ['PlaybackSessions']);

  keptData(path.join(appData, 'Music'));
  keptData(path.join(appData, 'Kept'));
  writeJSON(path.join(appData, 'Kept', 'profile.json'), { fresh: true });
  assert.equal(launch(appData, 'stable').directory, path.join(appData, 'Kept'), 'a Kept folder with Kept’s data wins');
  assert.deepEqual(readJSON(path.join(appData, 'Music', 'profile.json')), { setupComplete: true });
}));

test('an empty Kept folder left by a failed launch neither hides the old data nor stops a resumed move', () => withAppData(async appData => {
  const music = path.join(appData, 'Music'), kept = path.join(appData, 'Kept'), staging = kept + '.moving';
  keptData(music);
  writeJSON(path.join(music, 'navidrome', 'credentials.json'), { username: 'fixture' });
  await mkdir(staging);
  await rename(path.join(music, 'profile.json'), path.join(staging, 'profile.json'));
  await chmod(path.join(music, 'navidrome'), 0o500);
  try { assert.throws(() => launch(appData, 'stable'), /could not finish moving/); }
  finally { await chmod(path.join(music, 'navidrome'), 0o700); }
  // Electron makes its default folder when a launch fails before Kept picks one.
  await mkdir(path.join(kept, 'GPUPersistentCache'), { recursive: true });
  assert.equal(launch(appData, 'stable').directory, kept);
  assert.deepEqual((await readdir(kept)).sort(), ['.music-profile.lock', 'navidrome', 'profile.json']);
  const [aside] = (await readdir(appData)).filter(entry => entry.startsWith('Kept.unused-'));
  assert.deepEqual(await readdir(path.join(appData, aside)), ['GPUPersistentCache'], 'the empty folder is set aside, not deleted');

  writeJSON(path.join(appData, 'Music Preview', 'profiles', 'trial', 'navidrome', 'credentials.json'), { username: 'fixture' });
  await mkdir(path.join(appData, 'Kept Preview', 'GPUPersistentCache'), { recursive: true });
  assert.equal(launch(appData, 'preview', ['--profile', 'trial']).directory, path.join(appData, 'Kept Preview', 'profiles', 'trial'));
  assert.deepEqual(readJSON(path.join(appData, 'Kept Preview', 'profiles', 'trial', 'navidrome', 'credentials.json')), { username: 'fixture' });
}));

test('a live profile owner prevents both a second launch and a copy', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-profile-lock-'));
  try {
    const source = { name: 'existing', directory: path.join(directory, 'source') };
    const target = { name: 'copy', directory: path.join(directory, 'copy') };
    lockProfile(source.directory);
    assert.throws(() => lockProfile(source.directory), /open in another Kept/);
    await assert.rejects(copyProfile(source, target, directory), /open in another Kept/);
    assert.equal(readJSON(path.join(source.directory, '.music-profile.lock')).pid, process.pid);
    assert.equal(existsSync(target.directory), false);
    // An invalid PID is deterministically stale, without guessing a free system PID.
    writeJSON(path.join(source.directory, '.music-profile.lock'), { pid: -1 });
    assert.doesNotThrow(() => lockProfile(source.directory));
    assert.equal(readJSON(path.join(source.directory, '.music-profile.lock')).pid, process.pid);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('copy keeps source history and preferences intact and excludes transient locks/caches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music-profile-copy-'));
  try {
    const source = { name: 'existing', directory: path.join(directory, 'source') };
    const target = { name: 'copy', directory: path.join(directory, 'profiles', 'copy') };
    writeJSON(path.join(source.directory, 'profile.json'), { name: 'existing', setupComplete: true, musicFolders: ['/Music', '/Archive'] });
    await mkdir(path.join(source.directory, 'Cache'));
    await writeFile(path.join(source.directory, 'Cache', 'temporary'), 'cached');
    await writeFile(path.join(source.directory, 'music.sqlite'), 'fixture history');
    await writeFile(path.join(source.directory, 'preferences.json'), '{"art":true}');
    const original = await readFile(path.join(source.directory, 'profile.json'), 'utf8');
    const copied = await copyProfile(source, target, directory);
    assert.equal(copied.name, 'copy'); assert.deepEqual(copied.musicFolders, ['/Music', '/Archive']);
    assert.equal(await readFile(path.join(source.directory, 'profile.json'), 'utf8'), original);
    for (const name of ['music.sqlite', 'preferences.json']) {
      assert.equal(await readFile(path.join(target.directory, name), 'utf8'), await readFile(path.join(source.directory, name), 'utf8'));
    }
    assert.equal(existsSync(path.join(target.directory, 'Cache')), false);
    assert.equal(existsSync(path.join(target.directory, '.music-profile.lock')), false);
    assert.equal(existsSync(path.join(source.directory, '.music-profile.lock')), false);
    assert.equal(existsSync(`${target.directory}.copying`), false);
    await writeFile(path.join(target.directory, 'preferences.json'), 'changed');
    assert.equal(await readFile(path.join(source.directory, 'preferences.json'), 'utf8'), '{"art":true}');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
