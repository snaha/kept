# B0 sound spike

Offline test of local sound features for "unfamiliar albums like this one". It runs
outside the app, reads the collection only through ffmpeg, and writes everything to
`out/` (ignored by git). Findings are in `docs/kept-intelligence-plan.md`.
The DSP, FFT, OpenL3 frontend and exporter here are snapshots for reproducing the
spike. The app's implementations live in `desktop/analysis/` and `desktop/scripts/`.

```sh
pnpm install
# 1. Export the model (needs Python with torch and onnx; a temporary venv is enough)
curl -L -o /tmp/openl3.pth.tar https://github.com/torchopenl3/torchopenl3-models/raw/master/torchopenl3_mel256_music_512.pth.tar
python convert/export-openl3.py /tmp/openl3.pth.tar out/model [path/to/torchopenl3/models.py]
pnpm parity                     # only with the optional reference file above
# 2. Analyse: one single-threaded process per shard
node src/analyse.js --root ~/Music --shard 0/8   # … 7/8
# 3. Proxies, seeds and the blind sheet (out/blind-judging.html)
pnpm evaluate                   # --no-page keeps an already judged sheet
# 4. Mood test
pnpm dig-traits /tmp/leveldb-copy out/dig-traits.json
pnpm mood [traits.json]
pnpm mood --self-check
# 5. Cheaper settings and round 2 (hybrid sheet and traits check)
node src/variants.js
node src/round2.js
```

## Model and licences

- **OpenL3** audio embedding, mel256, music, 512 dimensions (Cramer, Wu, Salamon,
  Bello, ICASSP 2019). Code MIT, weights CC BY 4.0 (`marl/openl3`).
- Weights used: the PyTorch port `torchopenl3_mel256_music_512.pth.tar` from
  `github.com/torchopenl3/torchopenl3-models` (Apache-2.0 repository), SHA-256
  `510de95a1c946297b7432c69bd3855bf955f36276330b1de0c1b9555f866cab2`. No public
  ONNX export was found, so `convert/export-openl3.py` exports the convolutional
  backbone to ONNX (18.7 MB, opset 17).
- The mel frontend is reimplemented in `src/openl3.js`; the mel filterbank is read
  from the weight file. Parity with the PyTorch reference: 6e-3 dB on the
  spectrogram, 8e-5 on the embedding.
- Runtime: `onnxruntime-web` (MIT), WASM, one thread. Decoding: system ffmpeg.
- The signal-processing features in `src/dsp.js` and `src/fft.js` are written for
  this spike and use no third-party code.
