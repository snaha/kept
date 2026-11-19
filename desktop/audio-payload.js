import { createHash } from 'node:crypto'
import { open, stat } from 'node:fs/promises'

// The identity of an audio file is the SHA-256 of its audio payload and that payload's
// length, so re-tagging or moving a file keeps its asset. The file is read in slices and
// never loaded whole.
//   mp3   after ID3v2 and a Xing/Info/VBRI header frame, before ID3v1 and APE tags
//   flac  the frames after the metadata blocks
//   mp4   the payload of every mdat atom (m4a, m4b, mp4)
//   wav   the data chunk
//   file  anything else: the whole file minus ID3 and APE tags, so only those tag edits are ignored

export const PAYLOAD_FORMATS = Object.freeze({ mp3: 'mp3', flac: 'flac', mp4: 'mp4', wav: 'wav', file: 'file' })
export const HASH_ALGORITHM = 'sha256'
const fileVersionOf = ({ dev, ino, size, mtimeNs, ctimeNs }) => [dev, ino, size, mtimeNs, ctimeNs].join(':')
const VERSION_STAT = { bigint: true }
const NANOSECONDS_PER_MILLISECOND = 1_000_000
const versionDetails = info => ({
  fileSize: Number(info.size), modifiedMs: Number(info.mtimeNs) / NANOSECONDS_PER_MILLISECOND, fileVersion: fileVersionOf(info),
})
export async function audioFileVersion(file) {
  return versionDetails(await stat(file, VERSION_STAT))
}

const KIB = 1024
const READ_SLICE_BYTES = 256 * KIB
const DEFAULT_REST_EVERY_BYTES = 16 * KIB * KIB
const ID3V2_HEADER_BYTES = 10
const ID3V2_SIZE_OFFSET = 6
const ID3V2_FLAGS_OFFSET = 5
const ID3V2_FOOTER_FLAG = 0x10
const SYNCSAFE_BITS = 7
const SYNCSAFE_LIMIT = 0x80
const ID3V1_BYTES = 128
const APE_FOOTER_BYTES = 32
const APE_SIZE_OFFSET = 12
const APE_FLAGS_OFFSET = 20
const APE_HAS_HEADER = 0x80000000
const FLAC_BLOCK_HEADER_BYTES = 4
const FLAC_LAST_BLOCK = 0x80
const FLAC_LENGTH_BYTES = 3
const ATOM_HEADER_BYTES = 8
const ATOM_LARGE_HEADER_BYTES = 16
const ATOM_TYPE_OFFSET = 4
const RIFF_HEADER_BYTES = 12
const RIFF_FORM_OFFSET = 8
const CHUNK_HEADER_BYTES = 8
const CHUNK_SIZE_OFFSET = 4
const MAGIC_BYTES = 4
const MPEG_HEADER_BYTES = 4
const MPEG_PROBE_BYTES = 40
const VBRI_OFFSET = 36
const MPEG_VERSION_1 = 3
const MPEG_LAYER_3 = 1
const MPEG_BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const MPEG_BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
// Indexed by the two version bits: 2.5, reserved, 2, 1.
const MPEG_SAMPLE_RATES = [[11025, 12000, 8000], undefined, [22050, 24000, 16000], [44100, 48000, 32000]]
const MPEG_MONO = 3
const MPEG_SYNC_BYTE = 0xff
const MPEG_SYNC_BITS = 0xe0
const TWO_BITS = 3
const MPEG_VERSION_SHIFT = 3
const MPEG_BITRATE_SHIFT = 4
const MPEG_CHANNEL_SHIFT = 6
// Bytes of side information between the frame header and a Xing marker.
const SIDE_INFO_BYTES = { v1: { mono: 17, stereo: 32 }, v2: { mono: 9, stereo: 17 } }
// Layer III frame bytes = coefficient * bitrate / sample rate, plus the padding bit.
const FRAME_COEFFICIENT = { v1: 144, v2: 72 }
const KILO = 1000

const ascii = (buffer, start, length) => buffer.toString('latin1', start, start + length)

async function skipId3v2(read, size) {
  let offset = 0
  while (offset < size) {
    const head = await read(offset, ID3V2_HEADER_BYTES)
    if (head.length < ID3V2_HEADER_BYTES || ascii(head, 0, 'ID3'.length) !== 'ID3') break
    const digits = [...head.subarray(ID3V2_SIZE_OFFSET, ID3V2_HEADER_BYTES)]
    if (digits.some(digit => digit >= SYNCSAFE_LIMIT)) break
    const length = digits.reduce((total, digit) => (total << SYNCSAFE_BITS) | digit, 0)
    const footer = head[ID3V2_FLAGS_OFFSET] & ID3V2_FOOTER_FLAG ? ID3V2_HEADER_BYTES : 0
    offset += ID3V2_HEADER_BYTES + length + footer
  }
  return Math.min(offset, size)
}

// ID3v1 is the last 128 bytes. An APE tag sits before it, or last when there is no ID3v1.
async function skipTrailingTags(read, start, size) {
  let end = size
  if (end - start >= ID3V1_BYTES && ascii(await read(end - ID3V1_BYTES, 'TAG'.length), 0, 'TAG'.length) === 'TAG') end -= ID3V1_BYTES
  if (end - start >= APE_FOOTER_BYTES) {
    const footer = await read(end - APE_FOOTER_BYTES, APE_FOOTER_BYTES)
    if (ascii(footer, 0, 'APETAGEX'.length) === 'APETAGEX') {
      const length = footer.readUInt32LE(APE_SIZE_OFFSET) + (footer.readUInt32LE(APE_FLAGS_OFFSET) & APE_HAS_HEADER ? APE_FOOTER_BYTES : 0)
      if (length <= end - start) end -= length
    }
  }
  return end
}

async function flacFrames(read, start, end) {
  let offset = start + MAGIC_BYTES
  while (offset < end) {
    const header = await read(offset, FLAC_BLOCK_HEADER_BYTES)
    if (header.length < FLAC_BLOCK_HEADER_BYTES) return []
    offset += FLAC_BLOCK_HEADER_BYTES + header.readUIntBE(1, FLAC_LENGTH_BYTES)
    if (header[0] & FLAC_LAST_BLOCK) return [[offset, end]]
  }
  return []
}

async function mdatPayloads(read, start, end) {
  const ranges = []
  let offset = start
  while (offset + ATOM_HEADER_BYTES <= end) {
    const header = await read(offset, ATOM_LARGE_HEADER_BYTES)
    if (header.length < ATOM_HEADER_BYTES) break
    let length = header.readUInt32BE(0), headerBytes = ATOM_HEADER_BYTES
    if (length === 1) {
      if (header.length < ATOM_LARGE_HEADER_BYTES) break
      length = Number(header.readBigUInt64BE(ATOM_HEADER_BYTES))
      headerBytes = ATOM_LARGE_HEADER_BYTES
    } else if (length === 0) length = end - offset
    if (length < headerBytes || offset + length > end) break
    if (ascii(header, ATOM_TYPE_OFFSET, MAGIC_BYTES) === 'mdat') ranges.push([offset + headerBytes, offset + length])
    offset += length
  }
  return ranges
}

async function wavData(read, start, end) {
  let offset = start + RIFF_HEADER_BYTES
  while (offset + CHUNK_HEADER_BYTES <= end) {
    const header = await read(offset, CHUNK_HEADER_BYTES)
    if (header.length < CHUNK_HEADER_BYTES) break
    const length = header.readUInt32LE(CHUNK_SIZE_OFFSET)
    const body = offset + CHUNK_HEADER_BYTES
    if (ascii(header, 0, MAGIC_BYTES) === 'data') return [[body, Math.min(body + length, end)]]
    offset = body + length + (length % 2)
  }
  return []
}

// The length of a leading Xing, Info or VBRI frame: it describes the stream and holds no
// audio, and a tagger may add or rewrite it. 0 when the first frame is audio or not MPEG.
function mpegInfoFrameBytes(frame) {
  if (frame.length < MPEG_PROBE_BYTES || frame[0] !== MPEG_SYNC_BYTE || (frame[1] & MPEG_SYNC_BITS) !== MPEG_SYNC_BITS) return 0
  const version = (frame[1] >> MPEG_VERSION_SHIFT) & TWO_BITS, layer = (frame[1] >> 1) & TWO_BITS
  const family = version === MPEG_VERSION_1 ? 'v1' : 'v2'
  const bitrate = (family === 'v1' ? MPEG_BITRATES_V1 : MPEG_BITRATES_V2)[frame[2] >> MPEG_BITRATE_SHIFT]
  const sampleRate = MPEG_SAMPLE_RATES[version]?.[(frame[2] >> 2) & TWO_BITS]
  if (layer !== MPEG_LAYER_3 || !bitrate || !sampleRate) return 0
  const channels = (frame[MPEG_HEADER_BYTES - 1] >> MPEG_CHANNEL_SHIFT) === MPEG_MONO ? 'mono' : 'stereo'
  const marker = ascii(frame, MPEG_HEADER_BYTES + SIDE_INFO_BYTES[family][channels], MAGIC_BYTES)
  if (marker !== 'Xing' && marker !== 'Info' && ascii(frame, VBRI_OFFSET, MAGIC_BYTES) !== 'VBRI') return 0
  return Math.floor(FRAME_COEFFICIENT[family] * bitrate * KILO / sampleRate) + ((frame[2] >> 1) & 1)
}

async function locate(read, size, name) {
  const start = await skipId3v2(read, size)
  const end = await skipTrailingTags(read, start, size)
  const head = await read(start, RIFF_HEADER_BYTES)
  const found = async (format, ranges) => {
    const kept = (await ranges).filter(([from, to]) => to > from)
    return kept.length ? { format, ranges: kept } : undefined
  }
  if (ascii(head, 0, MAGIC_BYTES) === 'fLaC') return found(PAYLOAD_FORMATS.flac, flacFrames(read, start, end))
  if (ascii(head, ATOM_TYPE_OFFSET, MAGIC_BYTES) === 'ftyp') return found(PAYLOAD_FORMATS.mp4, mdatPayloads(read, start, end))
  if (ascii(head, 0, MAGIC_BYTES) === 'RIFF' && ascii(head, RIFF_FORM_OFFSET, MAGIC_BYTES) === 'WAVE') return found(PAYLOAD_FORMATS.wav, wavData(read, start, end))
  const infoFrame = mpegInfoFrameBytes(await read(start, MPEG_PROBE_BYTES))
  const mpeg = infoFrame > 0 || (/\.mp3$/i.test(name) && head[0] === MPEG_SYNC_BYTE)
  return found(mpeg ? PAYLOAD_FORMATS.mp3 : PAYLOAD_FORMATS.file, [[Math.min(start + infoFrame, end), end]])
}

// Resolves { contentHash, size, format }, plus the file's metadata when a version is requested.
// size is the payload length in bytes, not the file's.
// rest() is awaited every restEveryBytes so a caller can give way to playback.
export async function hashAudioPayload(file, { fileVersion, rest, restEveryBytes = DEFAULT_REST_EVERY_BYTES } = {}) {
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat(VERSION_STAT)
    if (fileVersion !== undefined && fileVersionOf(info) !== fileVersion) return
    const size = Number(info.size)
    const read = async (position, length) => {
      const wanted = Math.max(0, Math.min(length, size - position))
      const buffer = Buffer.alloc(wanted)
      let filled = 0
      while (filled < wanted) {
        const { bytesRead } = await handle.read(buffer, filled, wanted - filled, position + filled)
        if (!bytesRead) break
        filled += bytesRead
      }
      return buffer.subarray(0, filled)
    }
    const located = await locate(read, size, file) ?? { format: PAYLOAD_FORMATS.file, ranges: [[0, size]] }
    const hash = createHash(HASH_ALGORITHM)
    let total = 0, sinceRest = 0
    for (const [from, to] of located.ranges) {
      for (let position = from; position < to;) {
        const slice = await read(position, Math.min(READ_SLICE_BYTES, to - position))
        if (!slice.length) throw new Error(`Cannot read ${file}`)
        hash.update(slice)
        position += slice.length
        total += slice.length
        sinceRest += slice.length
        if (rest && sinceRest >= restEveryBytes) { sinceRest = 0; await rest() }
      }
    }
    if (fileVersion !== undefined && fileVersionOf(await handle.stat(VERSION_STAT)) !== fileVersion) return
    const version = fileVersion === undefined ? undefined : versionDetails(info)
    return { contentHash: hash.digest('hex'), size: total, format: located.format, ...version }
  } catch (error) {
    if (fileVersion !== undefined && fileVersionOf(await handle.stat(VERSION_STAT)) !== fileVersion) return
    throw error
  } finally { await handle.close() }
}
