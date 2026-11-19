// Third-party software and data that ship with Kept, with the licence terms the notices screen
// must show. The ffmpeg build script reads its version and configure line from here, so what is
// built and what is declared cannot drift apart.

export const FFMPEG_VERSION = '7.1.5'
export const FFMPEG_SOURCE_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`
export const FFMPEG_SOURCE_SHA256 = 'de668509caf9e35e3cd162473441fdb29538c6d96ed080292b3cf9e6fc5d558f'

// Audio decoding only, under the LGPL v2.1 or later: no GPL or non-free part, no external library,
// no network, no video, no encoder other than raw PCM for the pipe to the analyser.
export const FFMPEG_CONFIGURE = Object.freeze([
  '--disable-gpl', '--disable-nonfree', '--disable-version3',
  '--disable-everything', '--disable-autodetect', '--disable-network', '--disable-doc', '--disable-debug',
  '--disable-shared', '--enable-static',
  '--disable-ffplay', '--disable-ffprobe', '--disable-avdevice', '--disable-swscale',
  '--enable-protocol=file,pipe',
  '--enable-demuxer=mp3,flac,mov,ogg,wav,aiff',
  '--enable-parser=mpegaudio,flac,aac,vorbis,opus',
  '--enable-decoder=mp3,mp3float,flac,aac,alac,vorbis,opus,pcm_u8,pcm_s8,pcm_s16le,pcm_s16be,pcm_s24le,pcm_s24be,pcm_s32le,pcm_s32be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be',
  '--enable-filter=aresample,aformat,anull,atrim',
  '--enable-encoder=pcm_f32le', '--enable-muxer=pcm_f32le',
])

export const NAVIDROME_VERSION = '0.64.2'
export const ONNXRUNTIME_WEB_VERSION = '1.20.1'
export const ELECTRON_VERSION = '44.4.5'

// Each notice: what it is, how Kept uses it, its licence and where its source is.
// `terms` are shown as a list; `configure` and `attribution` are shown verbatim.
export const THIRD_PARTY_NOTICES = Object.freeze([
  {
    id: 'navidrome', name: 'Navidrome', version: NAVIDROME_VERSION, licence: 'GPL-3.0',
    use: 'The music server that scans and streams your library. It runs as a separate program next to Kept.',
    source: `https://github.com/navidrome/navidrome/tree/v${NAVIDROME_VERSION}`,
    terms: [
      'Shipped unmodified, as the binary published by the Navidrome project.',
      'Its complete source code is available at the address above, under the GNU General Public License version 3.',
    ],
  },
  {
    id: 'ffmpeg', name: 'FFmpeg', version: FFMPEG_VERSION, licence: 'LGPL-2.1-or-later',
    use: 'Decodes audio files so Kept can analyse how they sound. It runs as a separate program and nothing in Kept is linked with it.',
    source: FFMPEG_SOURCE_URL,
    terms: [
      'The bundled decoder analyses MP3, FLAC, MP4/M4A (AAC or ALAC), Ogg (Vorbis or Opus), and PCM WAV and AIFF.',
      'This software uses code of FFmpeg (https://ffmpeg.org) licensed under the LGPL version 2.1 or later (https://www.gnu.org/licenses/old-licenses/lgpl-2.1.html).',
      'Shipped unmodified. It is built from the source archive above with the configure line below, by desktop/scripts/build-ffmpeg.mjs in the Kept repository.',
      'Built without the GPL and non-free parts (--disable-gpl --disable-nonfree) and without any external library.',
      'You may replace it: Kept runs the ffmpeg file in its resources folder, and any ffmpeg with the same decoders works in its place.',
      'Source offer: the exact source is the archive above. If it is no longer available there, the Kept project provides a copy on request for three years after each release.',
    ],
    configure: `./configure ${FFMPEG_CONFIGURE.join(' ')}`,
  },
  {
    id: 'onnxruntime-web', name: 'ONNX Runtime Web', version: ONNXRUNTIME_WEB_VERSION, licence: 'MIT',
    use: 'Runs the sound model on this computer, in WebAssembly. Nothing is sent anywhere.',
    source: `https://github.com/microsoft/onnxruntime/tree/v${ONNXRUNTIME_WEB_VERSION}`,
    terms: ['Copyright (c) Microsoft Corporation. Licensed under the MIT License.'],
  },
  {
    id: 'openl3', name: 'OpenL3', version: 'music, 512 dimensions', licence: 'MIT (code), CC BY 4.0 (model weights)',
    use: 'The sound model: it turns a second of audio into numbers that are close for music that sounds alike.',
    source: 'https://github.com/marl/openl3',
    terms: [
      'Model weights licensed under the Creative Commons Attribution 4.0 International licence (https://creativecommons.org/licenses/by/4.0/).',
      'Changes: the weights were taken from the PyTorch port at https://github.com/torchopenl3/torchopenl3-models (Apache-2.0) and converted to the ONNX format. The spectrogram step is reimplemented in Kept.',
      'The OpenL3 authors do not endorse Kept.',
    ],
    attribution: 'Look, Listen and Learn More: Design Choices for Deep Audio Embeddings. Aurora Cramer, Ho-Hsiang Wu, Justin Salamon and Juan Pablo Bello. IEEE ICASSP 2019, pages 3852–3856.',
  },
  {
    id: 'electron', name: 'Electron', version: ELECTRON_VERSION, licence: 'MIT',
    use: 'The application shell. It contains Chromium and Node.js, whose own licences are in the LICENSES.chromium.html file inside the application.',
    source: `https://github.com/electron/electron/tree/v${ELECTRON_VERSION}`,
    terms: ['Copyright (c) Electron contributors, Copyright (c) 2013-2020 GitHub Inc. Licensed under the MIT License.'],
  },
  {
    id: 'butterchurn', name: 'Butterchurn and its presets', version: '3.0.0-beta.5', licence: 'MIT',
    use: 'The music visualizer.',
    source: 'https://github.com/jberg/butterchurn',
    terms: ['Copyright (c) Jordan Berg. Licensed under the MIT License. The presets come from the MilkDrop community collection packaged as butterchurn-presets.'],
  },
  {
    id: 'interface', name: 'Interface libraries', version: '', licence: 'MIT, ISC and OFL-1.1',
    use: 'Svelte, Bits UI, subsonic-api, qrcode, clsx, tailwind-merge and tailwind-variants build the window. The Inter typeface is used under the SIL Open Font License 1.1.',
    source: 'https://github.com/snaha/kept',
    terms: ['Each is used unmodified under its own licence. The exact versions are listed in frontend/package.json in the Kept repository.'],
  },
])
