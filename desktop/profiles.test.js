import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
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
    assert.equal(normal.directory, path.join(directory, 'Music'));
    assert.equal(preview.directory, path.join(directory, 'Music Preview', 'profiles', 'default'));
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
