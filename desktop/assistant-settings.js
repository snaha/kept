// The assistant is off until the user opts in. The settings live in the profile folder; the key is
// encrypted with Electron's safeStorage and read only here, in the main process. The window can
// learn that a key exists, never what it is.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_ANTHROPIC_MODEL, DEFAULT_LOCAL_URL, PROVIDER_KINDS } from './assistant-providers.js'

const readJSON = file => {
  if (!existsSync(file)) return {}
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { throw new Error('The assistant settings file cannot be read. Remove assistant.json from the profile folder to start again.') }
}
const writeJSON = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
  renameSync(temporary, file)
}

export const ASSISTANT_FILE = 'assistant.json'
const MAX_FIELD_LENGTH = 300
const MAX_KEY_LENGTH = 500
const DEFAULTS = { enabled: false, provider: 'anthropic', models: { anthropic: DEFAULT_ANTHROPIC_MODEL, local: '' }, baseUrl: DEFAULT_LOCAL_URL }

function validAddress(value) {
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:' } catch { return false }
}

export function createAssistantSettings({ directory, safeStorage }) {
  // On Linux without a secret store Electron still says encryption works, with a key anyone can read.
  const storage = () => {
    if (!safeStorage?.isEncryptionAvailable?.()) return { ok: false, reason: 'Secure storage is not available on this computer, so Kept will not save the key.' }
    if (safeStorage.getSelectedStorageBackend?.() === 'basic_text') return { ok: false, reason: 'This computer has no secret store (such as GNOME Keyring or KWallet), so Kept will not save the key.' }
    return { ok: true, reason: '' }
  }
  const file = path.join(directory, ASSISTANT_FILE)
  const read = () => {
    const saved = readJSON(file)
    return {
      enabled: saved.enabled === true,
      provider: PROVIDER_KINDS.includes(saved.provider) ? saved.provider : DEFAULTS.provider,
      models: { ...DEFAULTS.models, ...(saved.models && typeof saved.models === 'object' ? saved.models : {}) },
      baseUrl: typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : DEFAULTS.baseUrl,
      keys: saved.keys && typeof saved.keys === 'object' ? saved.keys : {},
    }
  }
  const view = saved => {
    const { ok, reason } = storage()
    return {
      enabled: saved.enabled, provider: saved.provider, model: saved.models[saved.provider], models: saved.models, baseUrl: saved.baseUrl,
      hasKey: typeof saved.keys[saved.provider] === 'string', canStoreKey: ok, ...(ok ? {} : { storeKeyReason: reason }),
    }
  }
  return {
    status: () => view(read()),
    // Credential changes must name their provider, even if it is already selected.
    save(change) {
      if (!change || typeof change !== 'object') throw new Error('Invalid assistant settings')
      if ((change.apiKey !== undefined || change.clearKey === true) && change.provider === undefined) {
        throw new Error('Choose which provider this key is for.')
      }
      const saved = read()
      if (change.provider !== undefined) {
        if (!PROVIDER_KINDS.includes(change.provider)) throw new Error('Choose Anthropic or an OpenAI-compatible model server.')
        saved.provider = change.provider
      }
      if (change.enabled !== undefined) saved.enabled = change.enabled === true
      if (change.model !== undefined) {
        if (typeof change.model !== 'string' || change.model.length > MAX_FIELD_LENGTH) throw new Error('That model name is not valid.')
        saved.models[saved.provider] = change.model.trim()
      }
      if (change.baseUrl !== undefined) {
        if (typeof change.baseUrl !== 'string' || change.baseUrl.length > MAX_FIELD_LENGTH || !validAddress(change.baseUrl.trim())) throw new Error('The server address must start with http:// or https://.')
        saved.baseUrl = change.baseUrl.trim()
      }
      if (change.clearKey === true) delete saved.keys[change.provider]
      if (change.apiKey !== undefined) {
        if (typeof change.apiKey !== 'string' || !change.apiKey.trim() || change.apiKey.length > MAX_KEY_LENGTH) throw new Error('That key is not valid.')
        const { ok, reason } = storage()
        if (!ok) throw new Error(reason)
        saved.keys[change.provider] = safeStorage.encryptString(change.apiKey.trim()).toString('base64')
      }
      writeJSON(file, saved)
      return view(saved)
    },
    // For the main process only: everything a call needs, with the key decrypted.
    resolve() {
      const saved = read()
      const cipher = saved.keys[saved.provider]
      let apiKey
      if (typeof cipher === 'string') {
        try { apiKey = safeStorage.decryptString(Buffer.from(cipher, 'base64')) } catch { throw new Error('The saved key could not be read. Enter it again in Settings.') }
      }
      return { enabled: saved.enabled, provider: saved.provider, model: saved.models[saved.provider], baseUrl: saved.baseUrl, apiKey }
    },
  }
}
