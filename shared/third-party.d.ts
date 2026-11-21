// One bundled piece of third-party software or data, as the notices screen shows it.
export type ThirdPartyNotice = {
  id: string
  name: string
  version: string
  licence: string
  // What Kept uses it for, in a sentence.
  use: string
  // Where its source is.
  source: string
  terms: readonly string[]
  // The exact command the bundled binary was configured with.
  configure?: string
  // The credit its licence asks for.
  attribution?: string
}

export const FFMPEG_VERSION: string
export const FFMPEG_SOURCE_URL: string
export const FFMPEG_SOURCE_SHA256: string
export const FFMPEG_CONFIGURE: readonly string[]
export const NAVIDROME_VERSION: string
export const ONNXRUNTIME_WEB_VERSION: string
export const ELECTRON_VERSION: string
export const THIRD_PARTY_NOTICES: readonly ThirdPartyNotice[]
