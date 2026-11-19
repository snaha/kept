import { describe, expect, it } from 'vitest'
import { audioRange } from '../src/audio-digest.ts'

const AUDIO = Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4])

/** An ID3v2 header for a body of `size` bytes: the size is syncsafe, seven bits a byte. */
const id3v2 = (size: number) => Buffer.concat([Buffer.from('ID3\u0004\u0000\u0000', 'latin1'), Buffer.from([0, 0, (size >> 7) & 0x7f, size & 0x7f]), Buffer.alloc(size)])
const id3v1 = () => Buffer.concat([Buffer.from('TAG', 'latin1'), Buffer.alloc(125)])
function ape(body: number): Buffer {
  const footer = Buffer.alloc(32)
  footer.write('APETAGEX', 0, 'latin1')
  footer.writeUInt32LE(body + 32, 12)
  return Buffer.concat([Buffer.alloc(body), footer])
}

const audioOf = (b: Buffer) => {
  const [start, end] = audioRange(b)
  return b.subarray(start, end)
}

describe('audioRange', () => {
  it('finds the same audio however the file is tagged', () => {
    expect(audioOf(AUDIO)).toEqual(AUDIO)
    expect(audioOf(Buffer.concat([id3v2(300), AUDIO, id3v1()]))).toEqual(AUDIO)
    expect(audioOf(Buffer.concat([id3v2(20), id3v2(1000), AUDIO, ape(40), id3v1()]))).toEqual(AUDIO)
  })
})
