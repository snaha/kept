import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const release = path.resolve(process.env.MUSIC_RELEASE_DIR || 'release');
const preview = process.env.MUSIC_CHANNEL === 'preview';
const commit = process.env.GITHUB_SHA;
const tag = preview ? `preview-${commit.slice(0, 7)}-${process.env.GITHUB_RUN_NUMBER}` : process.env.GITHUB_REF_NAME;
const assets = (await readdir(release)).filter(file => /\.(zip|dmg|AppImage|deb|tar\.gz|md)$/.test(file)).sort();
if (!assets.some(file => /\.(zip|AppImage)$/.test(file))) throw new Error('No desktop download was produced.');
// Normalize spaces before hashing: GitHub changes them to dots when uploading,
// so checksum entries must use the same names that people actually download.
for (const [index, file] of assets.entries()) {
  const normalized = file.replace(/\s+/g, '.');
  if (normalized === file) continue;
  if (assets.includes(normalized)) throw new Error(`Download filenames collide: ${normalized}`);
  await rename(path.join(release, file), path.join(release, normalized));
  assets[index] = normalized;
}
const checksums = await Promise.all(assets.map(async file => `${createHash('sha256').update(await readFile(path.join(release, file))).digest('hex')}  ${file}`));
await writeFile(path.join(release, 'SHA256SUMS.txt'), checksums.join('\n') + '\n');
assets.push('SHA256SUMS.txt');
const notes = `## ${preview ? 'Music Preview' : 'Music'}

Commit: ${commit}
Workflow: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}

Choose the download matching your computer:
- **Mac Apple Silicon:** ZIP/app or DMG. Intel Macs are not included.
- **Linux x64 or arm64 (such as a Raspberry Pi with a 64-bit system):** AppImage or deb, when present.
- **Portable:** extract the complete portable folder and use its Open Music launcher. Its Data folder keeps this build’s profiles separate.

Regular previews use their own profile outside the app. Fresh startup selects the Music folder; add custom folders and open your collection, or Explore first. To copy an existing Music profile, quit Music first. Files are scanned where they are; audio is not copied. Settings → Advanced shows the selected folders, active profile and build.

${process.env.MUSIC_NOTARIZED === 'true' ? 'Mac builds use Developer ID signing and notarization.' : 'Mac builds are not notarized and may be blocked at first launch. See [Apple’s launch guidance](https://support.apple.com/en-us/102445).'}

Profiles and personal credentials are not included in these downloads.
`;
const notesFile = path.join(path.dirname(release), 'release-notes.md');
await writeFile(notesFile, notes);
const gh = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let existing;
try { existing = JSON.parse(gh(['release', 'view', tag, '--json', 'url,assets'])); }
catch (error) { if (!String(error.stderr).includes('release not found')) throw error; }
let url;
if (existing) {
  // A rerun resumes a partially uploaded release without replacing existing assets.
  const ref = JSON.parse(gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/git/ref/tags/${tag}`]));
  const actual = ref.object.type === 'tag' ? JSON.parse(gh(['api', `repos/${process.env.GITHUB_REPOSITORY}/git/tags/${ref.object.sha}`])).object.sha : ref.object.sha;
  if (actual !== commit) throw new Error(`Release ${tag} points to a different commit.`);
  const present = new Set(existing.assets.map(asset => asset.name));
  const missing = assets.filter(file => !present.has(file));
  if (missing.length) gh(['release', 'upload', tag, ...missing.map(file => path.join(release, file))]);
  url = existing.url;
} else {
  url = gh(['release', 'create', tag, ...assets.map(file => path.join(release, file)), '--target', commit,
    '--title', preview ? `Music Preview · ${commit.slice(0, 7)}` : `Music ${tag}`, '--notes-file', notesFile,
    ...(preview ? ['--prerelease', '--latest=false'] : ['--verify-tag'])]);
}
console.log(url);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Download\n\n[${preview ? 'Music Preview' : 'Music'}](${url})\n`);
