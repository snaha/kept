import { createHash } from 'node:crypto';
import { accessSync, constants, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';

export const profileMusicFolders = config => config.musicFolders ?? (config.musicFolder ? [config.musicFolder] : []);
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function normalizeMusicFolders(folders, dataDirectory) {
  if (!Array.isArray(folders) || !folders.length || folders.length > 32) throw new Error('Choose at least one music folder (up to 32).');
  const roots = folders.map(folder => {
    if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('Choose an available music folder.');
    try {
      if (!statSync(folder).isDirectory()) throw new Error('Not a folder');
      accessSync(folder, constants.R_OK | constants.X_OK);
      return realpathSync(folder);
    } catch { throw new Error(`Cannot read ${folder}. Reconnect its drive or choose another music folder.`); }
  });
  const data = realpathSync(dataDirectory);
  if (roots.some(root => contains(root, data) || contains(data, root))) throw new Error('Choose a music folder outside Music’s data folder.');
  // A parent already includes its descendants; aliases and nested selections must not duplicate songs.
  return [...new Set(roots)].filter((root, index, unique) => !unique.some((parent, other) => other !== index && contains(parent, root)));
}

export const musicFolderLinkName = folder => `folder-${createHash('sha256').update(folder).digest('hex').slice(0, 16)}`;

export function prepareMusicRoot(directory, folders, combined = false) {
  if (folders.length === 1 && !combined) return folders[0];
  const root = path.join(directory, 'music-folders');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const links = new Map(folders.map(folder => [musicFolderLinkName(folder), folder]));
  for (const name of readdirSync(root)) {
    const file = path.join(root, name);
    if (!/^folder-[a-f\d]{16}$/.test(name) || !lstatSync(file).isSymbolicLink()) throw new Error('The music-folder index contains an unexpected file. Start a fresh profile to rebuild it.');
    if (links.get(name) !== readlinkSync(file)) unlinkSync(file);
    else links.delete(name);
  }
  for (const [name, folder] of links) symlinkSync(folder, path.join(root, name), 'dir');
  return root;
}
