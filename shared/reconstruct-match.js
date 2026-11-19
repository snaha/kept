// Matching for the reconstruction ladder (plan phase A4): text keys, similarity, the one-to-one
// assignment of local tracks to the tracks of a candidate release, and the versioned policy that
// decides whether a candidate is accepted. Pure functions. Types: reconstruct-match.d.ts.

// Bump a policy when a threshold or a veto changes: stored route attempts name the policy they ran under.
export const ASSIGNMENT_POLICY = 'assignment/1'
export const RELEASE_POLICY = 'release-match/1'

// How much each signal counts in the score of one local track against one release track.
const TITLE_WEIGHT = 0.6
const DURATION_WEIGHT = 0.25
const NUMBER_WEIGHT = 0.15
// A signal that is absent on either side neither helps nor hurts.
const NEUTRAL = 0.5
// Seconds: two lengths this close are the same take, and from DURATION_VETO on they are another one.
const DURATION_SAME = 3
const DURATION_VETO = 30
const MS_PER_SECOND = 1000
// Below this title similarity two tracks are never paired, whatever their length and number say.
export const TITLE_MIN = 0.75
// A pair needs this score, and must beat every other pairing of either track by this margin.
export const PAIR_MIN = 0.7
export const PAIR_MARGIN = 0.08
const IDENTIFIED = 1
// The cost of leaving a track unmatched: cheaper than any pairing under PAIR_MIN.
const UNMATCHED_COST = 1 - PAIR_MIN
const FORBIDDEN_COST = 1000

// The acceptance policy of a candidate release.
export const MIN_MATCHED = 3
export const MIN_COVERAGE = 0.8
// With a title that does not agree, the tracklist alone must carry the match.
const STRONG_MATCHED = 5
const STRONG_COVERAGE = 0.9
const STRONG_COMPLETENESS = 0.6
// Without a local album title the release must not be a much larger set that happens to hold the files.
const UNTITLED_COMPLETENESS = 0.5
export const NAME_SIMILARITY = 0.8
// Two release groups whose fit is this close cannot be told apart.
export const GROUP_MARGIN = 0.03
const COMPLETENESS_MARGIN = 0.1
// A title cut short (ID3v1 holds 30 characters) still names the longer one from this length on.
const PREFIX_MIN = 8
const PREFIX_SIMILARITY = 0.9

const MARKS = /(\p{Script=Latin})[̀-ͯ]+/gu
const NOT_WORD = /[^\p{L}\p{N}\p{M}]+/gu
const PLACEHOLDERS = new Set(['', 'unknown', 'unknown artist', 'unknown album', '[unknown artist]', '[unknown album]', '[non-album tracks]', 'untitled'])
const VARIOUS = /^(va|v\.a\.|various( artists?)?)$/i
// A site or an uploader written into the album tag is not an album.
const JUNK_NAME = /(https?:|www\.|\.(com|net|org|ru|de)\b|@)/i
const AUDIO_EXTENSION = /\.(mp3|flac|m4a|ogg|opus|wma|wav|aac|aiff|ape|wv)$/i
const FEATURING = /\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|and|x)\s+|\s*[&,;/+]\s*/i
const DISC_SUFFIX = /\s*[-–([]?\s*\b(?:cd|disc|disk)\s*[-_ ]?(\d{1,2})\b\s*[)\]]?\s*$/i
const DISC_FOLDER = /^(?:cd|disc|disk)\s*[-_ ]?\s*(\d{1,2})\b/i
// '07 - Title', '(07) Title', '07.Title', or two digits and a space. '2 Unlimited - Title' is not a number.
const TRACK_PREFIX = /^\s*(?:\(?(\d{1,3})\)?\s*[._)-]+\s*|(\d{2})\s+)(.*)$/
const VERSION_WORDS = /\b(live|demo|acoustic|unplugged|remix|mix|dub|edit|extended|radio|instrumental|karaoke)\b/gi

// Comparison key: accents folded, lower case, punctuation and spaces collapsed.
export function norm(text) {
  const raw = typeof text === 'string' ? text : ''
  const key = raw.normalize('NFKD').replace(MARKS, '$1').toLowerCase().replace(NOT_WORD, ' ').trim().normalize('NFC')
  return key || raw.trim().toLowerCase()
}
export const squash = text => norm(text).replace(/ /g, '')
// A tag value that says something: not empty, not a server's placeholder, not a web address.
export const known = text => typeof text === 'string' && !PLACEHOLDERS.has(text.trim().toLowerCase()) && !JUNK_NAME.test(text)
export const isVarious = text => typeof text === 'string' && VARIOUS.test(text.trim())
// The first act of a credit: 'Glass Orchard feat. Ivo Brandt' -> 'Glass Orchard'.
export const primaryCredit = text => (typeof text === 'string' ? text.split(FEATURING)[0].trim() : '')
// 'Paper Boats.mp3' -> 'Paper Boats'. Undefined when the title is clean.
export const cleanTitle = text => (typeof text === 'string' && AUDIO_EXTENSION.test(text.trim()) ? text.trim().replace(AUDIO_EXTENSION, '').trim() || undefined : undefined)
// 'Play (Disc 2)' -> { title: 'Play', disc: 2 }. Undefined when the title names no disc.
export function discOfTitle(text) {
  const match = typeof text === 'string' ? DISC_SUFFIX.exec(text) : undefined
  const title = match ? text.slice(0, match.index).trim() : ''
  return match && title ? { title, disc: Number(match[1]) } : undefined
}
// 'CD 2', 'Disc2' -> 2. Undefined for any other folder name.
export function discOfFolder(name) {
  const match = DISC_FOLDER.exec(name ?? '')
  return match ? Number(match[1]) : undefined
}
// '07 - Title.mp3' -> { track: 7, stem: 'Title' }. Without a number the track is undefined.
export function parseFileName(file) {
  const stem = String(file ?? '').replace(AUDIO_EXTENSION, '').replace(AUDIO_EXTENSION, '').replace(/_/g, ' ').trim()
  const match = TRACK_PREFIX.exec(stem)
  return match && match[3].trim() ? { track: Number(match[1] ?? match[2]), stem: match[3].trim() } : { track: undefined, stem }
}
export const versionWords = text => [...new Set([...String(text ?? '').matchAll(VERSION_WORDS)].map(match => match[1].toLowerCase()))].sort().join(' ')

function levenshtein(a, b) {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = row
  }
  return previous[b.length]
}

// 0..1 by edit distance over the comparison keys. With cut, a title that is the start of the
// other counts as near: a name does not ('Ada Lane' is not 'Ada Lane n Mo B').
export function similarity(a, b, cut = false) {
  const x = squash(a), y = squash(b)
  if (!x || !y) return 0
  const [short, long] = x.length <= y.length ? [x, y] : [y, x]
  const whole = 1 - levenshtein(x, y) / long.length
  if (!cut || short.length < PREFIX_MIN) return whole
  const head = 1 - levenshtein(short, long.slice(0, short.length)) / short.length
  return head >= PREFIX_SIMILARITY ? Math.max(PREFIX_SIMILARITY, whole) : whole
}
// The same act, however the tag spells or extends it: 'GlassOrchard', 'Glass Orchard', 'Glass Orchard feat. Ivo Brandt'.
export function sameArtist(a, b) {
  if (!known(a) || !known(b)) return false
  return squash(a) === squash(b) || similarity(a, b) >= NAME_SIMILARITY + (1 - NAME_SIMILARITY) / 2 || squash(primaryCredit(a)) === squash(primaryCredit(b))
}

// Minimum-cost assignment of rows to columns (Hungarian, O(n^3)). cost is square.
// Returns the column of each row.
export function hungarian(cost) {
  const size = cost.length
  const u = new Array(size + 1).fill(0), v = new Array(size + 1).fill(0), columnRow = new Array(size + 1).fill(0), way = new Array(size + 1).fill(0)
  for (let row = 1; row <= size; row++) {
    columnRow[0] = row
    let column = 0
    const least = new Array(size + 1).fill(Infinity), used = new Array(size + 1).fill(false)
    do {
      used[column] = true
      const current = columnRow[column]
      let delta = Infinity, next = 0
      for (let j = 1; j <= size; j++) {
        if (used[j]) continue
        const reduced = cost[current - 1][j - 1] - u[current] - v[j]
        if (reduced < least[j]) { least[j] = reduced; way[j] = column }
        if (least[j] < delta) { delta = least[j]; next = j }
      }
      for (let j = 0; j <= size; j++) {
        if (used[j]) { u[columnRow[j]] += delta; v[j] -= delta } else least[j] -= delta
      }
      column = next
    } while (columnRow[column] !== 0)
    do {
      const previous = way[column]
      columnRow[column] = columnRow[previous]
      column = previous
    } while (column !== 0)
  }
  const assignment = new Array(size).fill(-1)
  for (let j = 1; j <= size; j++) if (columnRow[j] > 0) assignment[columnRow[j] - 1] = j - 1
  return assignment
}

// The fit of one local track to one release track, 0..1. Undefined when they cannot be the same
// take: another title, another version, or a length too far off.
export function pairScore(local, slot) {
  if (local.recordingId !== undefined && slot.recordingId !== undefined && local.recordingId === slot.recordingId) return IDENTIFIED
  const title = known(local.title) ? similarity(local.title, slot.title, true) : 0
  if (title < TITLE_MIN) return undefined
  if (versionWords(local.title) !== versionWords(slot.title)) return undefined
  let duration = NEUTRAL
  if (local.duration > 0 && slot.duration > 0) {
    const off = Math.abs(local.duration - slot.duration)
    if (off > DURATION_VETO) return undefined
    duration = off <= DURATION_SAME ? 1 : 1 - (off - DURATION_SAME) / (DURATION_VETO - DURATION_SAME)
  }
  let number = NEUTRAL
  if (local.track !== undefined) number = local.track === slot.position && (local.disc === undefined || local.disc === slot.disc) ? 1 : 0
  return TITLE_WEIGHT * title + DURATION_WEIGHT * duration + NUMBER_WEIGHT * number
}

// One-to-one assignment of local tracks to the tracks of a release. Every local track is either
// matched to one slot or left out, and no slot is used twice. A pair is 'ambiguous' when another
// pairing of the same local track or the same slot scores within PAIR_MARGIN of it.
// locals: [{ id, title, duration?, track?, disc?, recordingId? }]. slots: [{ disc, position, title, duration?, recordingId? }].
export function assignTracks(locals, slots) {
  const scores = locals.map(local => slots.map(slot => pairScore(local, slot)))
  const size = locals.length + slots.length
  // Each local track has a private 'unmatched' column and each slot a private 'unused' row.
  const cost = Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, column) => {
    if (row < locals.length && column < slots.length) {
      const score = scores[row][column]
      return score === undefined || score < PAIR_MIN ? FORBIDDEN_COST : 1 - score
    }
    if (row < locals.length) return column - slots.length === row ? UNMATCHED_COST : FORBIDDEN_COST
    return 0
  }))
  const columns = size ? hungarian(cost) : []
  const pairs = [], unmatched = []
  locals.forEach((local, row) => {
    const column = columns[row]
    if (column >= slots.length || cost[row][column] >= FORBIDDEN_COST) { unmatched.push(local.id); return }
    const score = scores[row][column]
    const rivals = [...scores[row].filter((_, other) => other !== column), ...scores.filter((_, other) => other !== row).map(line => line[column])].filter(value => value !== undefined)
    const margin = score - Math.max(0, ...rivals)
    pairs.push({ id: local.id, slot: column, score, margin, ambiguous: score < IDENTIFIED && margin < PAIR_MARGIN })
  })
  const used = new Set(pairs.map(pair => pair.slot))
  return { policy: ASSIGNMENT_POLICY, pairs, unmatched, unused: slots.flatMap((_, index) => (used.has(index) ? [] : [index])) }
}

export const releaseSlots = release => release.media.flatMap(medium => medium.tracks.map(track => ({
  disc: medium.position, position: track.position, title: track.title, recordingId: track.recordingId,
  duration: track.length > 0 ? track.length / MS_PER_SECOND : undefined,
})))

// How well a release holds an album-sized set of local tracks, and whether the policy accepts it.
// target: { title?, artist?, tracks: locals }. Only target.tracks count for coverage.
export function evaluateRelease(target, release) {
  const slots = releaseSlots(release)
  const assignment = assignTracks(target.tracks, slots)
  const firm = assignment.pairs.filter(pair => !pair.ambiguous)
  const matched = firm.length, files = target.tracks.length
  const coverage = files ? matched / files : 0
  const completeness = slots.length ? matched / slots.length : 0
  const mean = matched ? firm.reduce((sum, pair) => sum + pair.score, 0) / matched : 0
  const titled = known(target.title)
  const titleFit = titled ? similarity(target.title, release.title, true) : 0
  const artistFit = known(target.artist) && !isVarious(target.artist) ? (sameArtist(target.artist, release.artist) ? 1 : similarity(target.artist, release.artist)) : undefined
  const strong = matched >= STRONG_MATCHED && coverage >= STRONG_COVERAGE && completeness >= STRONG_COMPLETENESS
  const vetoes = []
  if (matched < MIN_MATCHED) vetoes.push('too-few-tracks')
  if (coverage < MIN_COVERAGE) vetoes.push('coverage')
  if (assignment.pairs.some(pair => pair.ambiguous)) vetoes.push('ambiguous-tracks')
  if (artistFit !== undefined && artistFit < NAME_SIMILARITY && !isVarious(release.artist)) vetoes.push('artist')
  if (titled && titleFit < NAME_SIMILARITY && !strong) vetoes.push('title')
  if (!titled && completeness < UNTITLED_COMPLETENESS) vetoes.push('completeness')
  return { policy: RELEASE_POLICY, release, slots, assignment, matched, files, coverage, completeness, mean, titleFit, artistFit, accepted: vetoes.length === 0, vetoes }
}

// Chooses among evaluated candidates. Editions of one release group that fit equally well are one
// answer whose edition is unknown. Two release groups that fit equally well are no answer.
export function chooseRelease(evaluations) {
  const accepted = evaluations.filter(evaluation => evaluation.accepted)
  if (!accepted.length) return { status: 'no-match', candidates: evaluations.length }
  // More tracks first. Between fits that close, the release the files fill best: the album itself
  // rather than a box set that also holds it.
  const rank = (a, b) => b.matched - a.matched || (Math.abs(b.mean - a.mean) > GROUP_MARGIN ? b.mean - a.mean : b.completeness - a.completeness || b.mean - a.mean)
    || (a.release.id < b.release.id ? -1 : 1)
  const [best] = [...accepted].sort(rank)
  const close = accepted.filter(evaluation => evaluation.matched === best.matched && Math.abs(best.mean - evaluation.mean) <= GROUP_MARGIN
    && Math.abs(best.completeness - evaluation.completeness) <= COMPLETENESS_MARGIN)
  const groups = new Set(close.map(evaluation => evaluation.release.releaseGroupId ?? evaluation.release.id))
  if (groups.size > 1) return { status: 'ambiguous', candidates: evaluations.length, releases: close.map(evaluation => evaluation.release.id).sort() }
  return { status: 'matched', best, editions: close.sort(rank), candidates: evaluations.length }
}
