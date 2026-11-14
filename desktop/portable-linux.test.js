import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stageLinuxPortable } from './scripts/portable-linux.mjs';

test('Linux portable updates keep the launcher and data while starting the new app image', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'music portable '));
  const release = path.join(directory, 'release'), installed = path.join(directory, 'installed'), update = path.join(directory, 'update');
  try {
    await Promise.all([mkdir(release), mkdir(path.join(installed, 'Data'), { recursive: true }), mkdir(update)]);
    const marker = path.join(installed, 'Data', 'library.json');
    await writeFile(marker, 'existing library');
    for (const version of ['preview.1', 'preview.2']) {
      await writeFile(path.join(release, `Kept-${version}.AppImage`), `#!/bin/sh\nprintf '%s\\n' '${version}' "$APPIMAGE_EXTRACT_AND_RUN" "$@"\n`, { mode: 0o755 });
    }
    await stageLinuxPortable(release, installed, 'preview.1');
    const launcher = path.join(installed, 'Open Kept.sh');
    const originalLauncher = await readFile(launcher, 'utf8');
    await stageLinuxPortable(release, update, 'preview.2');
    await cp(path.join(update, 'Kept.AppImage'), path.join(installed, 'Kept.AppImage'));
    assert.equal(await readFile(launcher, 'utf8'), originalLauncher);
    assert.equal(await readFile(marker, 'utf8'), 'existing library');
    const output = execFileSync(launcher, ['--profile', 'test profile'], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(output, ['preview.2', '1', '--data-dir', path.join(installed, 'Data'), '--profile', 'test profile']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
