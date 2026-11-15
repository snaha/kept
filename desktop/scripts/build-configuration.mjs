import { signingConfiguration } from './mac-distribution.mjs'

const DMG_WIDTH = 660
const DMG_HEIGHT = 600
const DMG_ICON_SIZE = 72
const APP_X = 170
const APPLICATIONS_X = 490
const INSTALL_Y = 166
const NOTICE_X = 550
const NOTICE_Y = 456

export function buildConfiguration(pkg, channel, version, env) {
  const productName = channel === 'preview' ? 'Kept Preview' : 'Kept'
  const { developerSigned, notarizationConfigured } = signingConfiguration(env)
  const unnotarized = !(developerSigned && notarizationConfigured)
  return {
    ...pkg.build,
    productName,
    // Preserve the installed app identity and its OS permissions across renames.
    appId: channel === 'preview' ? 'dev.musicapp.desktop.preview' : 'dev.musicapp.desktop',
    extraMetadata: { version, productName, name: channel === 'preview' ? 'kept-preview' : pkg.name },
    ...(unnotarized ? { dmg: { ...pkg.build.dmg,
      background: 'build/dmg-unnotarized-background.png',
      window: { width: DMG_WIDTH, height: DMG_HEIGHT },
      iconSize: DMG_ICON_SIZE,
      contents: [
        { x: APP_X, y: INSTALL_Y },
        { x: APPLICATIONS_X, y: INSTALL_Y, type: 'link', path: '/Applications' },
        { x: NOTICE_X, y: NOTICE_Y, type: 'file', path: 'build/read-me-first.txt' }
      ]
    } } : {}),
    mac: {
      ...pkg.build.mac,
      ...(unnotarized ? { artifactName: '${productName}-${version}-${arch}-not-notarized.${ext}' } : {}),
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
