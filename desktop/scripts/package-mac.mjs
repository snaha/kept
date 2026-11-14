import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { requireMacDistribution, verifyMacApp, macNotarizationRequired } from './mac-distribution.mjs'

const signing = requireMacDistribution(process.env)
const root = path.resolve(import.meta.dirname, '..')
const info = JSON.parse(readFileSync(path.join(root, 'build-info.json'), 'utf8'))
const configuration = JSON.parse(readFileSync(path.join(root, 'builder-config.json'), 'utf8'))
const notarized = macNotarizationRequired(info)
const expectedChannel = process.env.MUSIC_CHANNEL === 'preview' ? 'preview' : 'stable'
if (notarized !== Boolean(signing.developerSigned && signing.notarizationConfigured) || info.channel !== expectedChannel || Boolean(configuration.mac.notarize) !== notarized || (notarized && configuration.mac.identity === '-')) {
  throw new Error('Stale build configuration. Run pnpm dist:mac with the intended channel and signing credentials.')
}
const appPath = path.join(root, 'release', 'mac-arm64', `${info.productName}.app`)
const directoryOnly = process.argv.includes('--dir')
const args = ['exec', 'electron-builder', '--config', 'builder-config.json', '--mac']
if (directoryOnly) args.push('--arm64', '--dir')
else {
  verifyMacApp(appPath, notarized)
  args.push('dmg', 'zip', '--arm64', '--prepackaged', appPath)
}
args.push('--publish', 'never')
// Empty GitHub secrets must not be interpreted as certificate file paths.
const environment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value || !/^(CSC_|APPLE_)/.test(key)))
execFileSync('pnpm', args, { cwd: root, env: environment, stdio: 'inherit' })
verifyMacApp(appPath, notarized)
