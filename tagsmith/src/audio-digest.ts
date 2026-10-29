/** A digest of an MP3's audio alone: the bytes between its leading ID3v2 tags and its trailing ID3v1, Lyrics3 and
 *  APE tags. Writing tags changes the file around the audio, never inside it, so a copy whose digest matches the
 *  original's has the same sound to the byte. A decoder's packet hash is not enough: ffmpeg counts an ID3v1 tag
 *  behind a cut-off last frame as audio, so removing the tag looks like an audio change. */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const ID3V2_HEADER = 10
const ID3V2_FOOTER_FLAG = 0x10
const SYNCSAFE = 7
const ID3V1 = 128
const APE_FOOTER = 32
const APE_HAS_HEADER = 0x80000000
const LYRICS3_END = 'LYRICS200'
const LYRICS3_SIZE_DIGITS = 6
const LYRICS3_TAIL = LYRICS3_END.length + LYRICS3_SIZE_DIGITS
const BYTE = 8
const SIZE_BYTES = 4

const ascii = (b: Buffer, start: number, end: number) => b.toString('latin1', start, end)

/** The audio's [start, end) in the file. */
export function audioRange(b: Buffer): [number, number] {
  let start = 0
  // one or more ID3v2 tags in front, each with a 28-bit syncsafe size
  while (start + ID3V2_HEADER <= b.length && ascii(b, start, start + 3) === 'ID3') {
    let size = 0
    for (let i = 0; i < SIZE_BYTES; i++) size = (size << SYNCSAFE) | (b[start + ID3V2_HEADER - SIZE_BYTES + i] & 0x7f)
    const footer = b[start + 5] & ID3V2_FOOTER_FLAG ? ID3V2_HEADER : 0
    start += ID3V2_HEADER + size + footer
  }
  let end = b.length
  for (let changed = true; changed && end > start; ) {
    changed = false
    if (end - ID3V1 >= start && ascii(b, end - ID3V1, end - ID3V1 + 3) === 'TAG') {
      end -= ID3V1
      changed = true
    }
    if (end - APE_FOOTER >= start && ascii(b, end - APE_FOOTER, end - APE_FOOTER + BYTE) === 'APETAGEX') {
      const size = b.readUInt32LE(end - APE_FOOTER + 12)
      const flags = b.readUInt32LE(end - APE_FOOTER + 20)
      end -= size + (flags & APE_HAS_HEADER ? APE_FOOTER : 0)
      changed = true
    }
    if (end - LYRICS3_TAIL >= start && ascii(b, end - LYRICS3_END.length, end) === LYRICS3_END) {
      end -= Number(ascii(b, end - LYRICS3_TAIL, end - LYRICS3_END.length)) + LYRICS3_TAIL
      changed = true
    }
  }
  return [Math.min(start, b.length), Math.max(start, end)]
}

/** sha256 of the audio bytes, hex. */
export async function audioDigest(path: string): Promise<string> {
  const b = await readFile(path)
  const [start, end] = audioRange(b)
  return createHash('sha256').update(b.subarray(start, end)).digest('hex')
}
