import { requireMacDistribution, macDownloadNotice } from './mac-distribution.mjs'

const configuration = requireMacDistribution(process.env)
console.log(configuration.developerSigned && configuration.notarizationConfigured
  ? 'Signing and notarization configured; app verification pending.'
  : macDownloadNotice(false))
