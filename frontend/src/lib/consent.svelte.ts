import { readPreference, writePreference } from './preferences'

/**
 * Online lookups stay off until the user chooses once. On the desktop the answer is a user
 * decision in the identity spine, which is what the lookup routes obey. The device
 * preference is the fallback where there is no spine, and is kept in step with it.
 */
export type LookupConsent = 'online' | 'offline'
export const LOOKUP_SENT = 'MusicBrainz receives album and artist names, track titles, and MusicBrainz release IDs from your tags. AcoustID receives audio fingerprints only if you add your own key. Your audio files stay on this device.'
const KEY = 'music.lookup-consent.v1'
const CONSENT = 'online-lookups'
const SAVE_ERROR = 'Your choice could not be saved. Online lookups are unchanged.'
const read = (): LookupConsent | undefined => { const value = readPreference(KEY); return value === 'online' || value === 'offline' ? value : undefined }
const stored = (choice: LookupConsent) => (choice === 'online' ? 'granted' : 'denied')
export const consent = $state<{ lookup: LookupConsent | undefined; error: string }>({ lookup: read(), error: '' })
// Every answer and every load takes a turn. Only the latest may change what is shown.
let turn = 0

export function setLookupConsent(choice: LookupConsent) {
  const previous = consent.lookup, mine = ++turn, bridge = window.musicCatalog
  consent.lookup = choice
  consent.error = ''
  if (!bridge) { writePreference(KEY, choice); return Promise.resolve() }
  // The spine decides what may be sent, so a choice it did not store is not shown as made.
  return bridge.setConsent({ consent: CONSENT, value: stored(choice) }).then(() => { writePreference(KEY, choice) }, () => {
    if (mine !== turn) return
    consent.lookup = previous
    consent.error = SAVE_ERROR
  })
}

/** Reads the stored decision. An answer given before the spine existed is carried over once. */
export async function loadLookupConsent() {
  const bridge = window.musicCatalog
  if (!bridge) return
  const mine = ++turn
  try {
    const state = (await bridge.consent())[CONSENT]
    if (mine !== turn) return
    if (state === 'not-asked') {
      if (consent.lookup) await bridge.setConsent({ consent: CONSENT, value: stored(consent.lookup) })
      return
    }
    consent.lookup = state === 'granted' ? 'online' : 'offline'
    writePreference(KEY, consent.lookup)
  } catch { /* The device answer keeps showing. Lookups obey the spine, which is offline until told otherwise. */ }
}
