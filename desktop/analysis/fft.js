// Radix-2 FFT with precomputed tables; returns the power spectrum of a windowed real frame.

export function createFft(size) {
  const half = size / 2
  const cos = new Float64Array(half)
  const sin = new Float64Array(half)
  for (let i = 0; i < half; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size)
    sin[i] = Math.sin((2 * Math.PI * i) / size)
  }
  const reverse = new Uint32Array(size)
  const bits = Math.log2(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    reverse[i] = r
  }
  const re = new Float64Array(size)
  const im = new Float64Array(size)

  /** Writes |X|^2 for bins 0..size/2 into `power`. */
  function powerSpectrum(frame, window, power) {
    for (let i = 0; i < size; i++) {
      re[reverse[i]] = frame[i] * window[i]
      im[reverse[i]] = 0
    }
    for (let span = 1; span < size; span *= 2) {
      const step = half / span
      for (let start = 0; start < size; start += span * 2) {
        for (let k = 0; k < span; k++) {
          const wr = cos[k * step]
          const wi = -sin[k * step]
          const a = start + k
          const b = a + span
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
    for (let i = 0; i <= half; i++) power[i] = re[i] * re[i] + im[i] * im[i]
  }

  return { powerSpectrum }
}

export function hannWindow(size) {
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  return window
}
