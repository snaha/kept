import { readFileSync } from 'node:fs'
import path from 'node:path'

// Features still being tried out. Each stays off unless the profile's features.json turns it on, for example
// { "spotify": true }, so people it is not ready for never see it. A missing or unreadable file leaves them all off.
export const FEATURES_FILE = 'features.json'
export const FEATURES = ['spotify']

export function readFeatures(directory) {
  let saved
  try { saved = JSON.parse(readFileSync(path.join(directory, FEATURES_FILE), 'utf8')) } catch (error) {
    if (error.code !== 'ENOENT') console.error(`Kept: ignoring ${FEATURES_FILE}:`, error.message)
  }
  return Object.fromEntries(FEATURES.map(name => [name, saved?.[name] === true]))
}
