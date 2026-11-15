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
  const hasSigningCredentials = Boolean(env.CSC_LINK || env.CSC_KEY_PASSWORD || (env.CSC_NAME && env.CSC_NAME !== '-'))
  if (!notarized && (hasSigningCredentials || hasNotarizationCredentials)) {
    throw new Error('Configure complete signing and notarization credentials, or omit them for an explicitly unnotarized download. Partial credentials cannot fall back to an unnotarized build. See desktop/README.md#macos.')
  }
  return configuration
}

export function macNotarizationRequired(info) {
  return Boolean(info.developerSigned && info.notarizationConfigured)
}

export function macDownloadNotice(notarized, { portable = false, productName = 'Kept' } = {}) {
  return notarized
    ? 'Mac app: Developer ID signed, notarized by Apple and verified by Gatekeeper before packaging.'
    : `### ${productName} for Mac: NOT NOTARIZED — Open Anyway required

This build has not been notarized by Apple. On first launch, macOS may say “Apple could not verify” and offer to move it to the Trash. To keep and open this app:

1. ${portable ? 'Keep the extracted portable folder together and open Open Kept.command. Do not move the app out of that folder.' : `Drag ${productName} into Applications, then open it from there. For a portable download, keep its folder together and use Open Kept.command instead.`}
2. In the “Apple could not verify” warning, click **Done**, not **Move to Trash**. Done leaves the app installed.
3. Open **System Settings → Privacy & Security** and scroll to the Security section.
4. Click **Open Anyway** for ${productName}, confirm **Open Anyway** if asked, and approve with Touch ID or your Mac password.
5. ${portable ? 'Use Open Kept.command again to start with the portable Data folder.' : `Open ${productName} again if it does not launch automatically.`}

These steps apply to both DMG and ZIP downloads. The DMG also includes read-me-first.txt. Only approve a build you trust; these instructions apply to the verification warning, not an alert that malware was detected. [Apple’s instructions](https://support.apple.com/en-us/102445).`
}

export function verifyMacApp(appPath, notarized = true, run = execFileSync) {
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  if (!notarized) return
  run('/usr/bin/xcrun', ['stapler', 'validate', appPath], { stdio: 'inherit' })
  // Acceptance by Gatekeeper is the distribution contract, not the presence of
  // credentials or electron-builder's exit status alone.
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], { stdio: 'inherit' })
}
