import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildConfiguration } from './scripts/build-configuration.mjs'
import { requireMacDistribution, verifyMacApp, macDownloadNotice, macNotarizationRequired } from './scripts/mac-distribution.mjs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const credentials = { CSC_LINK: '/private/certificate.p12', APPLE_ID: 'builder@example.test', APPLE_APP_SPECIFIC_PASSWORD: 'test-only', APPLE_TEAM_ID: 'TEAM' }

test('release packages include the main entrypoint import graph and its runtime dependencies', async () => {
  const root = import.meta.dirname
  const resolveBuilder = createRequire(import.meta.resolve('electron-builder')).resolve
  const builderModule = name => import(pathToFileURL(resolveBuilder(`app-builder-lib/out/${name}`)).href)
  const [{ getFileMatchers, getNodeModuleFileMatcher }, { PM }, { computeNodeModuleFileSets }, { metafile }] = await Promise.all([
    builderModule('fileMatcher.js'),
    builderModule('node-module-collector/index.js'),
    builderModule('util/appFileCopier.js'),
    build({ absWorkingDir: root, entryPoints: [pkg.main], bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false, metafile: true }),
  ])
  const runtimeImports = new Set(Object.values(metafile.inputs).flatMap(input => input.imports)
    .filter(entry => entry.external && !isBuiltin(entry.path) && entry.path !== 'electron').map(entry => entry.path))

  for (const channel of ['stable', 'preview']) {
    const config = buildConfiguration(pkg, channel, pkg.version, credentials)
    const out = path.resolve(root, config.directories.output)
    const macroExpander = value => value
    for (const platform of ['mac', 'linux']) {
      const match = getFileMatchers(config, 'files', out, { defaultSrc: root, customBuildOptions: config[platform], globalOutDir: out, macroExpander })
      for (const input of Object.keys(metafile.inputs).filter(file => !file.startsWith('../'))) {
        const file = path.resolve(root, input)
        assert.ok(match.some(matcher => matcher.createFilter()(file, statSync(file))), `${channel} ${platform} ships ${input}`)
      }
      const info = {
        config, appDir: root, projectDir: root, nodePackageName: pkg.name, appInfo: { type: pkg.type },
        debugLogger: { isEnabled: false }, getPackageManager: async () => PM.TRAVERSAL, getWorkspaceRoot: async () => root,
      }
      const matcher = getNodeModuleFileMatcher(root, out, macroExpander, config[platform], info)
      const moduleFiles = await computeNodeModuleFileSets({ config, info }, matcher)
      for (const name of runtimeImports) {
        const dependency = moduleFiles.find(fileSet => fileSet.destination === path.join(out, 'node_modules', name))
        assert.ok(dependency?.files.includes(fileURLToPath(import.meta.resolve(name))), `${channel} ${platform} ships ${name}`)
      }
    }
  }
})

test('release publication rejects a tag that differs from the packaged version', () => {
  const result = spawnSync(process.execPath, [new URL('./scripts/publish-release.mjs', import.meta.url).pathname], {
    env: { ...process.env, MUSIC_CHANNEL: 'stable', GITHUB_REF_NAME: 'v0.0.0-mismatch' }, encoding: 'utf8'
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Release tag must match the desktop package version/)
})

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
    assert.deepEqual(configuration.dmg, pkg.build.dmg)
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

test('stable and preview downloads reject partial credentials before packaging', () => {
  for (const env of [{ CSC_LINK: 'certificate' }, { CSC_KEY_PASSWORD: 'partial' },
    { ...credentials, APPLE_TEAM_ID: '' }, { ...credentials, CSC_LINK: '', CSC_NAME: '-' },
    { CSC_NAME: 'Developer ID Application: Test', APPLE_ID: 'partial', APPLE_KEYCHAIN_PROFILE: 'valid-profile' },
    { CSC_LINK: 'certificate', APPLE_API_KEY: 'partial', APPLE_KEYCHAIN_PROFILE: 'valid-profile' }
  ]) {
    for (const channel of ['stable', 'preview']) {
      assert.throws(() => requireMacDistribution({ ...env, MUSIC_CHANNEL: channel }), /Partial credentials/)
    }
  }

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_|MUSIC_CHANNEL$)/.test(key)))
  for (const script of ['check-mac-distribution.mjs', 'package-mac.mjs']) {
    const result = spawnSync(process.execPath, [new URL(`./scripts/${script}`, import.meta.url).pathname], { env: { ...env, APPLE_ID: 'partial' }, encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Partial credentials/)
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


for (const channel of ['stable', 'preview']) test(`unnotarized ${channel} is labelled and still requires a valid signature`, () => {
  const env = { MUSIC_CHANNEL: channel }
  assert.deepEqual(requireMacDistribution(env), { developerSigned: false, notarizationConfigured: false })
  const configuration = buildConfiguration(pkg, channel, 'test', env)
  assert.equal(configuration.mac.identity, '-')
  assert.equal(configuration.mac.notarize, false)
  assert.match(configuration.mac.artifactName, /not-notarized/)
  assert.ok(configuration.dmg.contents.some(item => item.path === 'build/read-me-first.txt'))
  const background = readFileSync(new URL(configuration.dmg.background, import.meta.url))
  const PNG_WIDTH_OFFSET = 16
  const PNG_HEIGHT_OFFSET = 20
  const PNG_SIGNATURE = 'PNG'
  assert.equal(background.subarray(1, 1 + PNG_SIGNATURE.length).toString(), PNG_SIGNATURE)
  assert.equal(background.readUInt32BE(PNG_WIDTH_OFFSET), configuration.dmg.window.width)
  assert.equal(background.readUInt32BE(PNG_HEIGHT_OFFSET), configuration.dmg.window.height)
  assert.match(macDownloadNotice(false), /NOT NOTARIZED.*Open Anyway required/)
  assert.match(macDownloadNotice(true), /notarized by Apple/)
  assert.equal(macNotarizationRequired({ channel, developerSigned: true, notarizationConfigured: true }), true)
  const notice = macDownloadNotice(false, { productName: configuration.productName })
  assert.ok(notice.includes(`Drag ${configuration.productName} into Applications`))
  if (channel === 'stable') assert.doesNotMatch(notice, /Kept Preview/)
  assert.equal(macNotarizationRequired({ channel: 'stable' }), false)
  assert.equal(macNotarizationRequired({ channel: 'preview' }), false)
  const calls = []
  verifyMacApp('/Kept Preview.app', false, (command) => calls.push(command))
  assert.deepEqual(calls, ['/usr/bin/codesign'])
  assert.throws(() => verifyMacApp('/Kept Preview.app', false, () => { throw new Error('invalid signature') }), /invalid signature/)
  for (const partial of [{ APPLE_ID: 'partial' }, { APPLE_TEAM_ID: 'partial' }, { APPLE_KEYCHAIN_PROFILE: 'profile-without-certificate' }]) {
    assert.throws(() => requireMacDistribution({ ...env, ...partial }), /Partial credentials/)
  }
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CSC_|APPLE_)/.test(key)))
  const result = spawnSync(process.execPath, [new URL('./scripts/check-mac-distribution.mjs', import.meta.url).pathname], { env: { ...cleanEnv, ...env }, encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /NOT NOTARIZED.*Open Anyway required/)
})
