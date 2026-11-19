import { MAX_QUEUE_LENGTH } from '../shared/tool-contracts.js'
import { normalName } from '../shared/tool-support.js'

const EXCLUSION = /(?:^|\s+)(?:but\s+)?(?:(?:not|nothing|none)\s+by|(?:no|without)\s+(?:tracks|songs)\s+by|excluding(?:\s+tracks\s+by)?|except(?:\s+for|\s+by)?)\s+(.+)$/d
const CREDIT = /(?:^|\s)(?:(?:only\s+)?by|(?:tracks?|songs?)\s+(from))\s+(.+)$/d
const QUOTED = /"[^"]*"|“[^”]*”|(?<![\p{L}\p{N}])(?:'.*?'(?![\p{L}\p{N}])|‘.*?’(?![\p{L}\p{N}]))/gu
const ARTIST_SEPARATOR = /\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+/g
const PLAY = /^(?:play|queue|put on)\s+/
const VERSIONS = 'live|studio|acoustic|demo|instrumental|original|remastered'
const VERSION = new RegExp(`(?:^|\\s)(?:the\\s+)?(${VERSIONS})\\s+(?:version|take|recording)\\s+of\\s+(.+)$`, 'd')
const VERSION_SUFFIX = new RegExp(`^(.+?)\\s*[([](${VERSIONS})[)\\]]$`)
const RECORDING = /^(?:the\s+)?(album|track|song|recording)\s+(.+)$/
const CONTEXT = /\s+(?:for|with|like|similar to)\s+/
const TRACK_COUNTS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']
const COUNT = new RegExp(`\\b(\\d+|${TRACK_COUNTS.join('|')})\\s+(?:tracks?|songs?)\\b`)
const name = value => normalName(value)?.replace(/^[“‘"']|[”’"']$/g, '').trim()
// Keep offsets so syntax matches can recover names with their original punctuation.
const syntaxOf = value => value.replace(QUOTED, quoted => '#'.repeat(quoted.length))
const capture = (value, match, index) => match && value.slice(...match.indices[index])

function artistNames(credit, knownArtists) {
  const full = name(credit)
  if (knownArtists.has(full)) return [full]
  const syntax = syntaxOf(credit)
  const parts = []
  let start = 0
  for (const separator of syntax.matchAll(ARTIST_SEPARATOR)) {
    parts.push(credit.slice(start, separator.index))
    start = separator.index + separator[0].length
  }
  parts.push(credit.slice(start))
  return parts.map(part => {
    const exact = name(part)
    const context = syntaxOf(part).match(CONTEXT)
    return context && !knownArtists.has(exact) ? name(part.slice(0, context.index)) : exact
  }).filter(Boolean)
}

function lengthOf(request) {
  const count = request.match(COUNT)?.[1]
  if (!count) return undefined
  const length = /^\d/.test(count) ? Number(count) : TRACK_COUNTS.indexOf(count)
  return length > 0 && length <= MAX_QUEUE_LENGTH ? length : undefined
}

function versionMatches(candidate, title, version) {
  if (!candidate?.startsWith(title)) return false
  const suffix = candidate.slice(title.length)
  if (!/^[\s([\-–—]/.test(suffix)) return false
  const qualifier = suffix.replace(/^[\s([\-–—]+/, '').replace(/[)\]]+$/, '')
  return qualifier === version || qualifier.startsWith(`${version} `)
}

// Names and version qualifiers are resolved from the listener's words and catalog metadata.
// Similarity requests can use a named seed without making its title or artist a requirement.
export async function resolveQueueConstraint(request, loadCatalog) {
  const text = normalName(request).replace(/,?\s+please[.!?]*$|[.!?]+$/g, '').trim()
  const syntax = syntaxOf(text)
  const exclusion = syntax.match(EXCLUSION)
  const phrase = exclusion ? text.slice(0, exclusion.index) : text
  const phraseSyntax = syntax.slice(0, phrase.length)
  const similarity = phraseSyntax.match(/\b(?:like|similar to)\s/)
  const credit = phraseSyntax.match(CREDIT)
  const credited = credit && (!similarity || credit.index < similarity.index) ? credit : undefined
  const from = Boolean(credited?.[1])
  const subject = credited ? phrase.slice(0, credited.index).trim() : phrase
  const direct = Boolean(credited) || (!similarity && PLAY.test(subject))
  const target = subject.replace(PLAY, '')
  const variant = similarity ? undefined : syntaxOf(target).match(VERSION)
  const recording = similarity ? undefined : target.match(RECORDING)
  const suffix = direct ? (recording?.[2] ?? target).match(VERSION_SUFFIX) : undefined
  if (!(exclusion || direct || variant || recording)) return undefined

  const snapshot = await loadCatalog()
  const tracks = [...(await snapshot.tracks()).entries()].map(([id, { albumId, track }]) => {
    const album = snapshot.albums.get(albumId)
    return { id, albumId, artist: name(track.artist || album?.artist), title: name(track.title), album: name(album?.title) }
  })
  const excludedArtist = name(capture(text, exclusion, 1))
  const directName = direct ? name(target) : undefined
  const knownArtists = new Set(tracks.map(track => track.artist).filter(Boolean))
  const creditText = capture(phrase, credited, 2)
  const artists = new Set(creditText ? artistNames(creditText, knownArtists) : knownArtists.has(directName) ? [directName] : [])
  const fromAlbum = from && ![...artists].some(artist => knownArtists.has(artist)) ? name(creditText) : undefined
  // "From" can also introduce ordinary context, such as "from my library".
  const albumTitle = fromAlbum && tracks.some(track => track.album === fromAlbum) ? fromAlbum : undefined
  if (fromAlbum) artists.clear()
  const version = variant?.[1] ?? suffix?.[2]
  const exactTitle = directName && (((!artists.size || credited) && /^[“‘"']/.test(target))
    || tracks.some(track => track.title === directName || track.album === directName))
  const title = albumTitle ?? name(capture(target, variant, 2) ?? suffix?.[1] ?? recording?.[2]) ?? (exactTitle ? directName : undefined)
  if (!(excludedArtist || artists.size || title)) return undefined

  const matchesRecording = track => {
    if (!title) return true
    if (version) {
      return versionMatches(track.title, title, version) || versionMatches(track.album, title, version)
    }
    if (albumTitle || recording?.[1] === 'album') return track.album === title
    if (recording) return track.title === title
    return track.title === title || track.album === title
  }
  const allowed = tracks.filter(track => (!artists.size || artists.has(track.artist))
    && (!excludedArtist || (track.artist && track.artist !== excludedArtist))
    && matchesRecording(track))
  return {
    allowedOccurrenceIds: new Set(allowed.map(track => track.id)),
    matchingAlbumIds: artists.size || title ? new Set(allowed.map(track => track.albumId)) : undefined,
    targetLength: lengthOf(syntax),
  }
}
