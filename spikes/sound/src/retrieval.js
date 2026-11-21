import { dot } from './library.js'

const RETRIEVAL_DEPTH = 5
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)

// Proxy 1: held-out track retrieval. Is a track's nearest other track from its own album?
export function trackRetrieval(albums, tracks, vectors) {
  let top1 = 0
  let topK = 0
  let artistOutsideAlbum = 0
  let artistEligible = 0
  let artistChance = 0
  const artistAlbums = new Map()
  for (const album of albums) artistAlbums.set(album.artistKey, (artistAlbums.get(album.artistKey) ?? 0) + 1)
  for (let i = 0; i < tracks.length; i++) {
    const ranked = tracks.map((_, j) => j).filter(j => j !== i).sort((a, b) => dot(vectors[i], vectors[b]) - dot(vectors[i], vectors[a]))
    if (tracks[ranked[0]].albumIndex === tracks[i].albumIndex) top1++
    if (ranked.slice(0, RETRIEVAL_DEPTH).some(j => tracks[j].albumIndex === tracks[i].albumIndex)) topK++
    const artistKey = albums[tracks[i].albumIndex].artistKey
    if (artistAlbums.get(artistKey) > 1) {
      // Mastering control: with the track's own album removed, is the nearest track by the same artist?
      const outside = ranked.filter(j => tracks[j].albumIndex !== tracks[i].albumIndex)
      artistEligible++
      if (albums[tracks[outside[0]].albumIndex].artistKey === artistKey) artistOutsideAlbum++
      artistChance += outside.filter(j => albums[tracks[j].albumIndex].artistKey === artistKey).length / outside.length
    }
  }
  const chance = mean(tracks.map(track => (albums[track.albumIndex].tracks.length - 1) / (tracks.length - 1)))
  return {
    sameAlbumTop1: top1 / tracks.length,
    chance,
    lift: top1 / tracks.length / chance,
    sameAlbumInTop5: topK / tracks.length,
    sameArtistOtherAlbumTop1: artistEligible ? artistOutsideAlbum / artistEligible : undefined,
    sameArtistOtherAlbumChance: artistEligible ? artistChance / artistEligible : undefined,
    sameArtistTracks: artistEligible,
  }
}
