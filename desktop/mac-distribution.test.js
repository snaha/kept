import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { buildConfiguration } from './scripts/build-configuration.mjs'
import { requireMacDistribution, verifyMacApp, macDownloadNotice, macNotarizationRequired } from './scripts/mac-distribution.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const credentials = { CSC_LINK: '/private/certificate.p12', APPLE_ID: 'builder@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'test-only', APPLE_TEAM_ID: 'TEAM' }

test('Kept stable and preview packages preserve the installed bundle identities', () => {
  for (const [channel, name, appId, packageName] of [
    ['stable', 'Kept', 'dev.musicapp.desktop', 'kept-desktop'],
    ['preview', 'Kept Preview', 'dev.musicapp.desktop.preview', 'kept-preview']
  ]) {
    const configuration = buildConfiguration(pkg, channel, '1.0.0', credentials)
    assert.equal(configuration.productName, name)
    assert.equal(configuration.appId, appId)
    assert.equal(configuration.extraMetadata.name, packageName)
    assert.equal(configuration.mac.notarize, true)
    assert.equal(configuration.mac.forceCodeSigning, true)
    assert.notEqual(configuration.mac.identity, '-')
  }
})

test('download preflight accepts each supported complete notarization configuration', () => {
  for (const env of [credentials,
    { CSC_NAME: 'Developer ID Application: Test (TEAM)', APPLE_KEYCHAIN_PROFILE: 'kept-notary' },
    { CSC_LINK: 'certificate', APPLE_API_KEY: '/private/key.p8', APPLE_API_KEY_ID: 'KEY', APPLE_API_ISSUER: 'ISSUER' }
  ]) {
    assert.deepEqual(requireMacDistribution(env), { developerSigned: true, notarizationConfigured: true })
    assert.equal(buildConfiguration(pkg, 'preview', 'test', env).mac.notarize, true)
  }
})

test('stable downloads reject missing credentials and previews reject partial credentials', () => {
  for (const env of [{}, { CSC_LINK: '', APPLE_ID: '' }, { CSC_LINK: 'certificate' },
    { ...credentials, APPLE_TEAM_ID: '' }, { ...credentials, CSC_LINK: '', CSC_NAME: '-' },
    { CSC_NAME: 'Developer ID Application: Test', APPLE_ID: 'partial', APPLE_KEYCHAIN_PROFILE: 'valid-profile' },
    { CSC_LINK: 'certificate', APPLE_API_KEY: 'partial', APPLE_KEYCHAIN_PROFILE: 'valid-profile' }
  ]) assert.throws(() => requireMacDistribution(env), /Mac stable downloads require/)

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_|MUSIC_CHANNEL$)/.test(key)))
  for (const script of ['check-mac-distribution.mjs', 'package-mac.mjs']) {
    const result = spawnSync(process.execPath, [new URL(`./scripts/${script}`, import.meta.url).pathname], { env, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Mac stable downloads require/)
  }
})

test('a damaged signature, missing staple or Gatekeeper rejection blocks packaging', () => {
  const appPath = '/preview with spaces/Kept Preview.app'
  const commands = ['/usr/bin/codesign', '/usr/bin/xcrun', '/usr/sbin/spctl']
  for (const rejectedCommand of [...commands, undefined]) {
    const calls = []
    const run = (command, args) => {
      calls.push(command)
      assert.equal(args.at(-1), appPath)
      if (command === rejectedCommand) throw new Error('verification rejected')
    }
    if (rejectedCommand) {
      assert.throws(() => verifyMacApp(appPath, true, run), /verification rejected/)
      assert.deepEqual(calls, commands.slice(0, commands.indexOf(rejectedCommand) + 1))
    } else {
      verifyMacApp(appPath, true, run)
      assert.deepEqual(calls, commands)
    }
  }
})


test('unnotarized preview is available, clearly labelled and still requires a valid signature', () => {
  const env = { MUSIC_CHANNEL: 'preview' }
  assert.deepEqual(requireMacDistribution(env), { developerSigned: false, notarizationConfigured: false })
  const configuration = buildConfiguration(pkg, 'preview', 'test', env)
  assert.equal(configuration.mac.identity, '-')
  assert.equal(configuration.mac.notarize, false)
  assert.match(configuration.mac.artifactName, /not-notarized/)
  assert.ok(configuration.dmg.contents.some(item => item.path === 'build/read-me-first.txt'))
  assert.match(macDownloadNotice(false), /NOT NOTARIZED.*Open Anyway required/)
  assert.match(macDownloadNotice(true), /notarized by Apple/)
  assert.equal(macNotarizationRequired({ channel: 'stable' }), true)
  assert.equal(macNotarizationRequired({ channel: 'preview' }), false)
  const calls = []
  verifyMacApp('/Kept Preview.app', false, (command) => calls.push(command))
  assert.deepEqual(calls, ['/usr/bin/codesign'])
  assert.throws(() => verifyMacApp('/Kept Preview.app', false, () => { throw new Error('invalid signature') }), /invalid signature/)
  for (const partial of [{ APPLE_ID: 'partial' }, { APPLE_TEAM_ID: 'partial' }, { APPLE_KEYCHAIN_PROFILE: 'profile-without-certificate' }]) {
    assert.throws(() => requireMacDistribution({ ...env, ...partial }), /partial credentials/)
  }
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_)/.test(key)))
  const result = spawnSync(process.execPath, [new URL('./scripts/check-mac-distribution.mjs', import.meta.url).pathname], { env: { ...cleanEnv, ...env }, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /NOT NOTARIZED.*Open Anyway required/)
})
