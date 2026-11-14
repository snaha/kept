import { signingConfiguration } from './mac-distribution.mjs'

const NOTICE_X = 270
const NOTICE_Y = 350

export function buildConfiguration(pkg, channel, version, env) {
  const productName = channel === 'preview' ? 'Kept Preview' : 'Kept'
  const { developerSigned, notarizationConfigured } = signingConfiguration(env)
  const unnotarizedPreview = channel === 'preview' && !(developerSigned && notarizationConfigured)
  return {
    ...pkg.build,
    productName,
    // Preserve the installed app identity and its OS permissions across renames.
    appId: channel === 'preview' ? 'dev.musicapp.desktop.preview' : 'dev.musicapp.desktop',
    extraMetadata: { version, productName, name: channel === 'preview' ? 'kept-preview' : pkg.name },
    ...(unnotarizedPreview ? { dmg: { ...pkg.build.dmg, contents: [
      ...pkg.build.dmg.contents,
      { x: NOTICE_X, y: NOTICE_Y, type: 'file', path: 'build/read-me-first.txt' }
    ] } } : {}),
    mac: {
      ...pkg.build.mac,
      ...(unnotarizedPreview ? { artifactName: '${productName}-${version}-${arch}-not-notarized.${ext}' } : {}),
      sign: 'scripts/sign-mac.mjs',
      ...(developerSigned ? { forceCodeSigning: true, ...(env.CSC_NAME ? { identity: env.CSC_NAME } : {}) } : {
        identity: '-',
        entitlements: 'build/entitlements.adhoc.mac.plist',
        entitlementsInherit: 'build/entitlements.adhoc.mac.plist'
      }),
      notarize: developerSigned && notarizationConfigured
    }
  }
}
