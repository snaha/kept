import { hashAudioPayload } from '../audio-payload.js'

// The payload hash of one version of an audio file. Reads in slices and rests between them
// so playback and the scanner keep the disk.
export default async ctx => {
  const { file, fileVersion } = ctx.payload
  if (fileVersion === undefined) return {}
  return await hashAudioPayload(file, { fileVersion, rest: ctx.rest }) ?? {}
}
