import { cp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function stageLinuxPortable(release, staging, version) {
  const candidates = (await readdir(release)).filter(file => file.endsWith('.AppImage') && file.includes(version));
  if (candidates.length !== 1) throw new Error('Build exactly one AppImage for the current version before making a portable package.');
  const [appImage] = candidates;
  await cp(path.join(release, appImage), path.join(staging, 'Kept.AppImage'));
  await writeFile(path.join(staging, 'Open Kept.sh'), `#!/bin/sh
set -eu
music_preview_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export APPIMAGE_EXTRACT_AND_RUN=1
exec "$music_preview_dir/Kept.AppImage" --data-dir "$music_preview_dir/Data" "$@"
`, { mode: 0o755 });
}
