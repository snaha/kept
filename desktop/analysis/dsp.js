// Signal-processing features written for Kept (no third-party code), first used in the B0 spike.
// One summary vector per track from bounded excerpts of 48 kHz mono PCM.
import { createFft, hannWindow } from './fft.js'

const N_FFT = 2048
const HOP = 512
const N_BINS = N_FFT / 2 + 1
const N_MEL = 40
const N_MFCC = 13
const N_CHROMA = 12
const ROLLOFF_FRACTION = 0.85
const EPSILON = 1e-12
const SILENCE_DB = -70
const HIGH_BAND_HZ = 4000
const LOW_BAND_HZ = 200
const VOICE_BAND_HZ = [300, 3400]
const SPECTRUM_BAND_HZ = [50, 16000]
const CHROMA_BAND_HZ = [55, 5000]
const A4_HZ = 440
const A4_MIDI = 69
const TEMPO_RANGE_BPM = [55, 200]
const TEMPO_PRIOR_BPM = 120
const TEMPO_PRIOR_OCTAVES = 1
const ONSET_MEAN_FRAMES = 20
const ONSET_PEAK_FRAMES = 3
const ONSET_THRESHOLD = 1.5
const SYLLABIC_BAND_HZ = [2, 8]
const SECONDS_PER_MINUTE = 60
// Krumhansl–Kessler key profiles (public domain values from Krumhansl 1990).
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

const hzToMel = hz => 2595 * Math.log10(1 + hz / 700)
const melToHz = mel => 700 * (10 ** (mel / 2595) - 1)
const mean = values => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1)
const std = values => {
  const m = mean(values)
  return Math.sqrt(mean(values.map(value => (value - m) ** 2)))
}

function correlation(a, b) {
  const ma = mean(a)
  const mb = mean(b)
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return num / Math.sqrt(da * db + EPSILON)
}

export function createDsp(sampleRate) {
  const fft = createFft(N_FFT)
  const window = hannWindow(N_FFT)
  const binHz = sampleRate / N_FFT
  const bin = hz => Math.round(hz / binHz)
  const frameRate = sampleRate / HOP

  const melEdges = Array.from({ length: N_MEL + 2 }, (_, i) => melToHz((hzToMel(sampleRate / 2) * i) / (N_MEL + 1)) / binHz)
  const melFilters = Array.from({ length: N_MEL }, (_, m) => {
    const [lo, mid, hi] = [melEdges[m], melEdges[m + 1], melEdges[m + 2]]
    const first = Math.ceil(lo)
    const weights = []
    for (let b = first; b < hi && b < N_BINS; b++) weights.push(b < mid ? (b - lo) / (mid - lo) : (hi - b) / (hi - mid))
    return { first, weights }
  })
  const dct = Array.from({ length: N_MFCC }, (_, k) => Array.from({ length: N_MEL }, (_, m) => Math.cos((Math.PI * k * (m + 0.5)) / N_MEL)))
  const chromaOfBin = new Int8Array(N_BINS).fill(-1)
  for (let b = bin(CHROMA_BAND_HZ[0]); b <= bin(CHROMA_BAND_HZ[1]); b++) {
    const midi = Math.round(A4_MIDI + N_CHROMA * Math.log2((b * binHz) / A4_HZ))
    chromaOfBin[b] = ((midi % N_CHROMA) + N_CHROMA) % N_CHROMA
  }

  /** Frame-level descriptors for one excerpt. */
  function frames(samples) {
    const count = Math.floor((samples.length - N_FFT) / HOP) + 1
    const power = new Float64Array(N_BINS)
    const out = { rmsDb: [], zcr: [], centroid: [], rolloff: [], flatness: [], highRatio: [], lowRatio: [], voiceBand: [], onset: [], mfcc: [], chroma: new Float64Array(N_CHROMA) }
    let previousMel
    for (let f = 0; f < count; f++) {
      const frame = samples.subarray(f * HOP, f * HOP + N_FFT)
      let square = 0
      let crossings = 0
      for (let i = 0; i < N_FFT; i++) {
        square += frame[i] * frame[i]
        if (i > 0 && frame[i] >= 0 !== frame[i - 1] >= 0) crossings++
      }
      const rmsDb = 10 * Math.log10(square / N_FFT + EPSILON)
      fft.powerSpectrum(frame, window, power)
      const logMel = melFilters.map(({ first, weights }) => {
        let sum = 0
        for (let i = 0; i < weights.length; i++) sum += weights[i] * power[first + i]
        return Math.log(sum + EPSILON)
      })
      // Onset strength: half-wave rectified rise in log-mel energy (spectral flux).
      let rise = 0
      if (previousMel) for (let m = 0; m < N_MEL; m++) rise += Math.max(0, logMel[m] - previousMel[m])
      previousMel = logMel
      out.onset.push(rise / N_MEL)
      if (rmsDb < SILENCE_DB) continue

      let total = 0
      let weighted = 0
      let logSum = 0
      let high = 0
      let low = 0
      let voice = 0
      const [firstBin, lastBin] = SPECTRUM_BAND_HZ.map(bin)
      for (let b = firstBin; b <= lastBin; b++) {
        const p = power[b]
        total += p
        weighted += p * b * binHz
        logSum += Math.log(p + EPSILON)
        if (b * binHz >= HIGH_BAND_HZ) high += p
        if (b * binHz < LOW_BAND_HZ) low += p
        if (b * binHz >= VOICE_BAND_HZ[0] && b * binHz <= VOICE_BAND_HZ[1]) voice += p
        if (chromaOfBin[b] >= 0) out.chroma[chromaOfBin[b]] += Math.sqrt(p)
      }
      let cumulative = 0
      let rolloffBin = firstBin
      while (rolloffBin < lastBin && cumulative < ROLLOFF_FRACTION * total) cumulative += power[rolloffBin++]
      out.rmsDb.push(rmsDb)
      out.zcr.push(crossings / N_FFT)
      out.centroid.push(weighted / (total + EPSILON))
      out.rolloff.push(rolloffBin * binHz)
      out.flatness.push(Math.exp(logSum / (lastBin - firstBin + 1)) / (total / (lastBin - firstBin + 1) + EPSILON))
      out.highRatio.push(high / (total + EPSILON))
      out.lowRatio.push(low / (total + EPSILON))
      out.voiceBand.push(Math.log(voice + EPSILON))
      out.mfcc.push(dct.map(row => row.reduce((sum, weight, m) => sum + weight * logMel[m], 0)))
    }
    return out
  }

  function autocorrelation(onset, minLag, maxLag) {
    const centred = onset.map(value => value - mean(onset))
    const energy = centred.reduce((sum, value) => sum + value * value, 0) + EPSILON
    const result = new Float64Array(maxLag + 1)
    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0
      for (let i = lag; i < centred.length; i++) sum += centred[i] * centred[i - lag]
      result[lag] = sum / energy
    }
    return result
  }

  /** Share of the voice-band envelope's variance that sits at syllabic rates (2–8 Hz). */
  function syllabicModulation(envelope) {
    if (envelope.length < frameRate * 2) return 0
    const centred = envelope.map(value => value - mean(envelope))
    const variance = mean(centred.map(value => value * value)) + EPSILON
    let band = 0
    for (let hz = SYLLABIC_BAND_HZ[0]; hz <= SYLLABIC_BAND_HZ[1]; hz += 0.5) {
      let re = 0
      let im = 0
      for (let i = 0; i < centred.length; i++) {
        re += centred[i] * Math.cos((2 * Math.PI * hz * i) / frameRate)
        im += centred[i] * Math.sin((2 * Math.PI * hz * i) / frameRate)
      }
      band += (re * re + im * im) / centred.length ** 2
    }
    return band / variance
  }

  /** Track summary from its excerpts. Scalar names are stable; `mfccMean`/`mfccStd` are vectors. */
  function analyse(excerpts) {
    const parts = excerpts.map(frames)
    const all = key => parts.flatMap(part => part[key])
    const minLag = Math.floor((frameRate * SECONDS_PER_MINUTE) / TEMPO_RANGE_BPM[1])
    const maxLag = Math.ceil((frameRate * SECONDS_PER_MINUTE) / TEMPO_RANGE_BPM[0])
    const acf = new Float64Array(maxLag + 1)
    let onsets = 0
    let seconds = 0
    for (const { onset } of parts) {
      const partAcf = autocorrelation(onset, minLag, maxLag)
      for (let lag = minLag; lag <= maxLag; lag++) acf[lag] += partAcf[lag] / parts.length
      for (let i = ONSET_PEAK_FRAMES; i < onset.length - ONSET_PEAK_FRAMES; i++) {
        const local = mean(onset.slice(Math.max(0, i - ONSET_MEAN_FRAMES), i + ONSET_MEAN_FRAMES))
        const neighbours = onset.slice(i - ONSET_PEAK_FRAMES, i + ONSET_PEAK_FRAMES + 1)
        if (onset[i] > ONSET_THRESHOLD * local && onset[i] === Math.max(...neighbours)) onsets++
      }
      seconds += onset.length / frameRate
    }
    let tempo = 0
    let tempoStrength = 0
    let best = -Infinity
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (frameRate * SECONDS_PER_MINUTE) / lag
      const prior = Math.exp(-0.5 * (Math.log2(bpm / TEMPO_PRIOR_BPM) / TEMPO_PRIOR_OCTAVES) ** 2)
      if (acf[lag] * prior > best) {
        best = acf[lag] * prior
        tempo = bpm
        tempoStrength = acf[lag]
      }
    }
    const chroma = Array.from({ length: N_CHROMA }, (_, c) => parts.reduce((sum, part) => sum + part.chroma[c], 0))
    let keyStrength = -1
    let major = 0
    for (let shift = 0; shift < N_CHROMA; shift++) {
      const rotated = chroma.map((_, i) => chroma[(i + shift) % N_CHROMA])
      for (const [profile, isMajor] of [[MAJOR_PROFILE, 1], [MINOR_PROFILE, 0]]) {
        const r = correlation(rotated, profile)
        if (r > keyStrength) {
          keyStrength = r
          major = isMajor
        }
      }
    }
    const rmsDb = all('rmsDb')
    const mfcc = all('mfcc')
    const mfccColumn = k => mfcc.map(row => row[k])
    return {
      loudnessDb: mean(rmsDb),
      dynamicsDb: std(rmsDb),
      zcr: mean(all('zcr')),
      centroidHz: mean(all('centroid')),
      centroidStdHz: std(all('centroid')),
      rolloffHz: mean(all('rolloff')),
      flatness: mean(all('flatness')),
      highRatio: mean(all('highRatio')),
      lowRatio: mean(all('lowRatio')),
      flux: mean(all('onset')),
      onsetRate: onsets / Math.max(seconds, 1),
      tempoBpm: tempo,
      tempoStrength,
      keyStrength,
      major,
      syllabicModulation: mean(parts.map(part => syllabicModulation(part.voiceBand))),
      mfccMean: Array.from({ length: N_MFCC }, (_, k) => mean(mfccColumn(k))),
      mfccStd: Array.from({ length: N_MFCC }, (_, k) => std(mfccColumn(k))),
    }
  }

  return { analyse }
}
