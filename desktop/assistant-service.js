// What the window may ask of the assistant, over IPC. The window sends text and settings; the key is
// read and used here and never goes back. One request runs at a time: a new one cancels the old one.
import { createProvider } from './assistant-providers.js'

export const DISABLED_MESSAGE = 'The assistant is off. Turn it on in Settings, under Advanced, and add your own key or a local model.'
export const NO_KEY_MESSAGE = 'Add your Anthropic API key in Settings, under Advanced, to use the assistant.'
export const NO_MODEL_MESSAGE = 'Enter the name of the model your local server should use in Settings, under Advanced.'

export function createAssistantService({ settings, assistant, folders = () => [], makeProvider = createProvider, fetch: fetchImpl }) {
  let running
  return {
    status: () => settings.status(),
    save: change => settings.save(change),
    cancel(id, sender) {
      if (running && running.sender === sender && (id === undefined || running.id === id)) running.controller.abort()
    },
    // Resolves to { message, queue, steps }. Rejects with a sentence the listener can act on.
    async ask(payload, sender) {
      if (typeof payload?.request !== 'string' || typeof payload?.id !== 'string' || !payload.id) throw new Error('Invalid assistant request.')
      const { request, id } = payload
      const config = settings.resolve()
      if (!config.enabled) throw new Error(DISABLED_MESSAGE)
      if (config.provider === 'anthropic' && !config.apiKey) throw new Error(NO_KEY_MESSAGE)
      if (config.provider === 'local' && !config.model) throw new Error(NO_MODEL_MESSAGE)
      running?.controller.abort()
      const controller = new AbortController()
      const mine = { id, controller, sender }
      running = mine
      const abort = () => controller.abort()
      const navigate = details => {
        if (details.isMainFrame && !details.isSameDocument) abort()
      }
      sender?.on('did-start-navigation', navigate)
      sender?.on('render-process-gone', abort)
      sender?.on('destroyed', abort)
      try {
        const provider = makeProvider(config, { privacy: { folders: folders() }, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
        const { message, queue, steps } = await assistant.ask({ request, provider, signal: controller.signal })
        controller.signal.throwIfAborted()
        return { message, queue, steps }
      } catch (error) {
        if (mine.controller.signal.aborted) throw new Error('Cancelled.')
        throw error
      } finally {
        sender?.off('did-start-navigation', navigate)
        sender?.off('render-process-gone', abort)
        sender?.off('destroyed', abort)
        if (running === mine) running = undefined
      }
    },
  }
}
