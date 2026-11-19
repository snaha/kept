// Puts the OpenL3 model of the default analysis method in models/, where the analyser loads it and
// from where it is bundled next to the app. The model is not in the repository: no public ONNX
// export exists, so it is exported from the published weights (CC BY 4.0, see shared/third-party.js).
//   node scripts/fetch-openl3.mjs [--all] [--strict]
// --all fetches every method's model. --strict requires a pinned or freshly verified export.
// In order: models already present; a folder that has them (KEPT_OPENL3_DIR, for example the output
// of the B0 spike); otherwise the weights are downloaded, checked against their SHA-256 and exported
// with scripts/export-openl3.py in a Python environment made for it (needs python3).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ANALYSIS_METHODS, DEFAULT_METHOD_ID } from '../analysis/methods.js'
import { verifyOpenl3Fingerprint } from './openl3-fingerprint.mjs'

// The PyTorch port of the official weights: github.com/torchopenl3/torchopenl3-models (Apache-2.0 repository).
const WEIGHTS_URL = 'https://github.com/torchopenl3/torchopenl3-models/raw/master'
const PYTHON_PACKAGES = ['torch==2.15.0', 'onnx==1.23.2', 'numpy==2.5.5']
const here = path.dirname(fileURLToPath(import.meta.url))
const REFERENCES = JSON.parse(readFileSync(path.join(here, 'openl3-reference.json'), 'utf8'))
const models = path.join(here, '..', 'models')
const work = path.join(here, '..', '.models-build')
const run = (command, args, options = {}) => execFileSync(command, args, { stdio: 'inherit', ...options })
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const filesOf = model => [`${model}.onnx`, `${model.replace('-music-512', '')}-basis.f32`]

const strict = process.argv.includes('--strict')
mkdirSync(models, { recursive: true })
const wanted = new Set(process.argv.includes('--all') ? Object.values(ANALYSIS_METHODS).map(method => method.model) : [ANALYSIS_METHODS[DEFAULT_METHOD_ID].model])
if (strict) {
  // The packager includes every ONNX already in models/, including exports left by --all.
  for (const file of readdirSync(models)) {
    if (!file.endsWith('.onnx')) continue
    const model = path.basename(file, '.onnx')
    if (!Object.hasOwn(REFERENCES, model)) throw new Error(`No pinned reference for ${file}`)
    wanted.add(model)
  }
}
let python
function exporter() {
  if (python) return python
  const venv = path.join(work, 'venv')
  python = path.join(venv, 'bin', 'python')
  if (!existsSync(python)) {
    run(process.env.KEPT_PYTHON || 'python3', ['-m', 'venv', venv])
    run(python, ['-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', ...(process.platform === 'linux' ? ['--index-url', 'https://download.pytorch.org/whl/cpu', '--extra-index-url', 'https://pypi.org/simple'] : []), ...PYTHON_PACKAGES])
  }
  return python
}

function mismatch(message) {
  if (strict) throw new Error(message)
  console.warn(`warning: ${message}`)
}

async function installModel(model, source, { fromVerifiedWeights = false } = {}) {
  const files = filesOf(model).map(name => {
    const bytes = readFileSync(path.join(source, name))
    return { name, bytes, digest: sha256(bytes) }
  })
  const [onnx, basis] = files
  const { weights, onnxSha256, basisSha256, embeddings } = REFERENCES[model]
  // The exporter writes the pinned weights' mel tensor as little-endian float32 without recomputing it.
  if (basis.digest !== basisSha256) {
    throw new Error(`${basis.name} does not match its checksum (expected ${basisSha256}, got ${basis.digest})`)
  }
  // Torch may serialize equivalent graphs differently on different build platforms.
  try {
    const { mels } = Object.values(ANALYSIS_METHODS).find(method => method.model === model)
    await verifyOpenl3Fingerprint(onnx.bytes, mels, embeddings)
  } catch (error) {
    mismatch(`${onnx.name} failed the OpenL3 fingerprint check: ${error.message}`)
  }
  // The probes check compatibility. Only the committed checksum or an export
  // we just ran from pinned weights establishes where the graph came from.
  if (strict && !fromVerifiedWeights && onnx.digest !== onnxSha256) {
    console.log(`${onnx.name} has no pinned checksum match, exporting from verified weights`)
    return false
  }
  if (source !== models) {
    for (const { name, bytes } of files) writeFileSync(path.join(models, name), bytes)
  }
  const hashes = Object.fromEntries(files.map(({ name, digest }) => [name, digest]))
  writeFileSync(path.join(models, `${model}.json`), `${JSON.stringify({ model, weights, files: hashes }, undefined, 2)}\n`)
  return true
}

for (const model of wanted) {
  const files = filesOf(model)
  const given = process.env.KEPT_OPENL3_DIR
  const source = [models, given].find(directory => directory && files.every(file => existsSync(path.join(directory, file))))
  if (source && await installModel(model, path.resolve(source))) {
    console.log(model, source === models ? 'already present' : `copied from ${source}`)
    continue
  }

  mkdirSync(work, { recursive: true })
  const { file, sha256: weightDigest } = REFERENCES[model].weights
  const weights = path.join(work, file)
  if (!existsSync(weights)) {
    const url = `${WEIGHTS_URL}/${file}`
    console.log('downloading', url)
    run('curl', ['-sSL', '--fail', '-o', weights, url])
  }
  if (sha256(readFileSync(weights)) !== weightDigest) {
    rmSync(weights)
    throw new Error(`The weights of ${model} do not match their checksum`)
  }
  const output = mkdtempSync(path.join(work, 'export-'))
  try {
    run(exporter(), [path.join(here, 'export-openl3.py'), weights, output])
    await installModel(model, output, { fromVerifiedWeights: true })
    console.log(model, 'exported')
  } finally {
    rmSync(output, { recursive: true, force: true })
  }
}
