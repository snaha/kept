import { execFileSync } from 'node:child_process'

export function signingConfiguration(env) {
  const developerSigned = Boolean(env.CSC_LINK || (env.CSC_NAME && env.CSC_NAME !== '-'))
  // Match electron-builder's authentication precedence. Partial credentials must
  // not accidentally select a different account or silently skip notarization.
  let notarizationConfigured = false
  if (env.APPLE_ID || env.APPLE_APP_SPECIFIC_PASSWORD) {
    notarizationConfigured = Boolean(env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
  } else if (env.APPLE_API_KEY || env.APPLE_API_KEY_ID || env.APPLE_API_ISSUER) {
    notarizationConfigured = Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
  } else {
    notarizationConfigured = Boolean(env.APPLE_KEYCHAIN_PROFILE)
  }
  return { developerSigned, notarizationConfigured }
}

export function requireMacDistribution(env) {
  const configuration = signingConfiguration(env)
  const notarized = configuration.developerSigned && configuration.notarizationConfigured
  const hasNotarizationCredentials = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER', 'APPLE_KEYCHAIN_PROFILE'].some(key => env[key])
  if (!notarized && (env.MUSIC_CHANNEL !== 'preview' || hasNotarizationCredentials)) {
    throw new Error('Mac stable downloads require Developer ID signing and Apple notarization. Configure complete credentials; partial credentials cannot fall back to an unnotarized preview. See desktop/README.md#macos. Set MUSIC_CHANNEL=preview to build an explicitly unnotarized preview without Apple credentials.')
  }
  return configuration
}

export function macNotarizationRequired(info) {
  return info.channel !== 'preview' || Boolean(info.developerSigned && info.notarizationConfigured)
}

export function macDownloadNotice(notarized) {
  return notarized
    ? 'Mac app: Developer ID signed, notarized by Apple and verified by Gatekeeper before packaging.'
    : 'Mac preview: NOT NOTARIZED — Open Anyway required. After installing Kept Preview, open it once and dismiss the warning. In System Settings → Privacy & Security, choose Open Anyway for Kept Preview, then confirm. Only approve a build you trust. See https://support.apple.com/en-us/102445.'
}

export function verifyMacApp(appPath, notarized = true, run = execFileSync) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  if (!notarized) return
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
  // Acceptance by Gatekeeper is the distribution contract, not the presence of
  // credentials or electron-builder's exit status alone.
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { stdio: 'inherit' })
}
