import { randomUUID } from 'node:crypto';
import { cp, readdir, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const readJSON = (file, fallback = {}) => {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { throw new Error(`Cannot read ${file}. Keep this folder and restore its configuration from a backup.`); }
};
export function writeJSON(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
}

const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
export function assertProfileClosed(directory) {
  const lock = path.join(directory, '.music-profile.lock');
  if (existsSync(lock) && alive(readJSON(lock).pid)) throw new Error('This profile is open in another Kept window. Quit that version before continuing.');
  // Older versions only have Chromium's lock. Do not copy their live browser storage.
  try {
    const target = readlinkSync(path.join(directory, 'SingletonLock'));
    const owner = Number(target.slice(target.lastIndexOf('-') + 1));
    // Electron has already claimed its Chromium lock during this launch. Only
    // another process can prevent reclaiming our stale application PID lock.
    if (owner !== process.pid && alive(owner)) throw new Error('Quit Kept before copying its profile, then try again.');
  } catch (error) { if (!['ENOENT', 'EINVAL'].includes(error.code)) throw error; }
}
export function lockProfile(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, '.music-profile.lock');
  // A crashed process leaves a lock; a live process always wins. Exclusive creation
  // also serializes launches racing to claim a previously unused profile.
  for (let attempt = 0; attempt < 2; attempt++) {
    try { writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 }); return; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assertProfileClosed(directory);
      rmSync(file);
    }
  }
  throw new Error('Another Kept version is opening this profile. Try again after it closes.');
}

const profileName = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) throw new Error('Profile names must contain 1–64 letters, numbers, underscores or hyphens.');
  return value;
};
export function launchProfile({ argv, env, appData, channel }) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    const name = argument.split('=')[0];
    if (name === '--use-existing') options.existing = true;
    if (!['--profile', '--data-dir'].includes(name)) continue;
    const value = argument.includes('=') ? argument.slice(name.length + 1) : argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value.`);
    options[name.slice(2)] = value;
  }
  // Kept retains the original Music directories so upgrades keep all user data.
  const existingDirectory = path.join(appData, 'Music');
  const customRoot = options['data-dir'] || env.MUSIC_DATA_DIR;
  const explicitName = options.profile || env.MUSIC_PROFILE;
  const root = customRoot ? path.resolve(customRoot) : path.join(appData, 'Music Preview');
  const useExisting = options.existing || (channel !== 'preview' && !customRoot && !explicitName);
  if (options.existing && (customRoot || explicitName)) throw new Error('Use --use-existing on its own. It opens the normal Kept profile.');
  const last = useExisting || explicitName ? 'default' : readJSON(path.join(root, 'last-profile.json'), { name: 'default' }).name;
  const name = useExisting ? 'existing' : profileName(explicitName || last);
  return { name, root, directory: useExisting ? existingDirectory : path.join(root, 'profiles', name), existingDirectory, existing: useExisting, portable: !!customRoot };
}
export function loadProfile(profile, defaultMusicFolder) {
  const file = path.join(profile.directory, 'profile.json');
  const saved = readJSON(file, null);
  if (saved) return saved;
  const legacy = existsSync(path.join(profile.directory, 'navidrome', 'credentials.json'));
  return { name: profile.name, setupComplete: legacy && existsSync(defaultMusicFolder), musicFolder: legacy && existsSync(defaultMusicFolder) ? defaultMusicFolder : '', source: legacy ? 'local' : 'empty', createdAt: Date.now() };
}
export const saveProfile = (profile, config) => writeJSON(path.join(profile.directory, 'profile.json'), config);
export function rememberProfile(profile) {
  if (!profile.existing) writeJSON(path.join(profile.root, 'last-profile.json'), { name: profile.name });
}
export function newProfile(profile, prefix = 'fresh') {
  const name = `${prefix}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
  return { ...profile, name, directory: path.join(profile.root, 'profiles', name), existing: false };
}
export function selectedProfile(profile, name) {
  return { ...profile, name: profileName(name), directory: path.join(profile.root, 'profiles', profileName(name)), existing: false };
}
export async function listProfiles(profile) {
  if (!existsSync(path.join(profile.root, 'profiles'))) return [];
  const entries = await readdir(path.join(profile.root, 'profiles'), { withFileTypes: true });
  return entries.filter(entry => entry.isDirectory() && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(entry.name)).map(entry => {
    const config = readJSON(path.join(profile.root, 'profiles', entry.name, 'profile.json'), {});
    return { name: entry.name, label: config.label || entry.name, createdAt: config.createdAt || 0, setupComplete: !!config.setupComplete };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

export async function copyProfile(source, target, defaultMusicFolder) {
  if (!existsSync(source.directory)) throw new Error('No existing Kept profile was found on this computer. Start fresh instead.');
  assertProfileClosed(source.directory);
  lockProfile(source.directory);
  const staging = `${target.directory}.copying`;
  try {
    mkdirSync(path.dirname(target.directory), { recursive: true, mode: 0o700 });
    await cp(source.directory, staging, {
      recursive: true, errorOnExist: true, force: false,
      filter: file => !['.music-profile.lock', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Crashpad', 'cache'].includes(path.basename(file)),
    });
    const copied = { ...loadProfile(source, defaultMusicFolder), name: target.name, label: 'Copy of Kept', copiedAt: Date.now(), createdAt: Date.now() };
    writeJSON(path.join(staging, 'profile.json'), copied);
    renameSync(staging, target.directory);
    return copied;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally { rmSync(path.join(source.directory, '.music-profile.lock'), { force: true }); }
}
