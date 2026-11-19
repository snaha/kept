// Builds the audio-only ffmpeg that is bundled next to the app, under the LGPL, for the platform
// being built. The version, the source archive and the configure line come from
// shared/third-party.js, which is also what the notices screen shows.
//   node scripts/build-ffmpeg.mjs [--force]
// Needs a C compiler and make (and nasm on x86). The source is downloaded to .ffmpeg-build/ and
// checked against its SHA-256 before anything is run.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FFMPEG_CONFIGURE, FFMPEG_SOURCE_SHA256, FFMPEG_SOURCE_URL, FFMPEG_VERSION } from '../../shared/third-party.js'

const MAC_MINIMUM_VERSION = '11.0'
const BYTES_PER_MB = 2 ** 20
const here = path.dirname(new URL(import.meta.url).pathname)
const bin = path.join(here, '..', 'bin')
const out = path.join(bin, 'ffmpeg')
const receipt = path.join(bin, 'ffmpeg.build.json')
const work = path.join(here, '..', '.ffmpeg-build')
const archive = path.join(work, path.basename(FFMPEG_SOURCE_URL))
const source = path.join(work, `ffmpeg-${FFMPEG_VERSION}`)
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options })

// The minimum macOS version is a property of the build machine, not of what is built, so it stays out of the declared line.
const platformFlags = process.platform === 'darwin'
  ? [`--extra-cflags=-mmacosx-version-min=${MAC_MINIMUM_VERSION}`, `--extra-ldflags=-mmacosx-version-min=${MAC_MINIMUM_VERSION}`]
  : []
const configure = [...FFMPEG_CONFIGURE, ...platformFlags]
const wanted = JSON.stringify({ version: FFMPEG_VERSION, sha256: FFMPEG_SOURCE_SHA256, configure, platform: process.platform, arch: process.arch })

if (existsSync(out) && existsSync(receipt) && !process.argv.includes('--force') && JSON.stringify(JSON.parse(readFileSync(receipt, 'utf8')).build) === wanted) {
  console.log('ffmpeg already built')
  process.exit(0)
}
mkdirSync(work, { recursive: true })
mkdirSync(bin, { recursive: true })
if (!existsSync(archive)) {
  console.log('downloading', FFMPEG_SOURCE_URL)
  run('curl', ['-sSL', '--fail', '-o', archive, FFMPEG_SOURCE_URL])
}
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex')
if (digest !== FFMPEG_SOURCE_SHA256) {
  rmSync(archive)
  throw new Error(`The ffmpeg source archive does not match its checksum (${digest})`)
}
rmSync(source, { recursive: true, force: true })
run('tar', ['-xJf', archive, '-C', work])
run('./configure', configure, { cwd: source })
run('make', [`-j${os.availableParallelism()}`, 'ffmpeg'], { cwd: source })
copyFileSync(path.join(source, 'ffmpeg'), out)
run('strip', process.platform === 'darwin' ? ['-x', out] : [out])
const licence = execFileSync(out, ['-hide_banner', '-L'], { encoding: 'utf8' }).replace(/\s+/g, ' ')
if (!/GNU Lesser General Public License/.test(licence) || /--enable-gpl|--enable-nonfree/.test(execFileSync(out, ['-hide_banner', '-buildconf'], { encoding: 'utf8' }))) {
  rmSync(out)
  throw new Error('The ffmpeg that was built is not under the LGPL')
}
// The licence text travels with the binary.
copyFileSync(path.join(source, 'COPYING.LGPLv2.1'), path.join(bin, 'ffmpeg.LGPL-2.1.txt'))
writeFileSync(receipt, `${JSON.stringify({ build: JSON.parse(wanted), bytes: statSync(out).size }, undefined, 2)}\n`)
rmSync(source, { recursive: true, force: true })
console.log('ok', out, `${(statSync(out).size / BYTES_PER_MB).toFixed(1)} MB`)
