// The two model back ends of the optional assistant, both called from the main process with the
// user's own key. A provider is { complete({ system, messages, tools, signal }) } and speaks one
// neutral message format (Anthropic content blocks), so the loop does not know which one it drives.
// complete() resolves to { content, stop } where stop is 'tool_use' or 'end'.
import Anthropic from '@anthropic-ai/sdk'
import { assertPrivatePayload } from './assistant-privacy.js'

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5'
export const DEFAULT_LOCAL_URL = 'http://localhost:11434/v1'
export const PROVIDER_KINDS = ['anthropic', 'local']
const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
const MAX_OUTPUT_TOKENS = 8000
const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
// Models of the Claude 5 family take the effort setting and the server-side fallback.
const CLAUDE_5 = /^claude-(?:sonnet|opus|fable|haiku)-5/
const HTTP_UNAUTHORIZED = 401
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_RATE_LIMITED = 429
const MAX_ERROR_TEXT = 300

export const toolDefinitions = contracts => contracts.map(({ name, description, input }) => ({ name, description, input_schema: input }))

// Every body leaves through one function, so the privacy scan sees exactly what is sent.
// The SDK wraps whatever fetch throws, so the refusal is also kept on the guard for the caller to rethrow.
function guarded(fetchImpl, privacy) {
  const send = async (url, init = {}) => {
    try { if (typeof init.body === 'string') assertPrivatePayload(init.body, privacy) } catch (error) { send.refused = error; throw error }
    return fetchImpl(url, { ...init, redirect: 'error' })
  }
  return send
}

const readable = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_TEXT)

function anthropicFailure(error, model) {
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return 'The API key was not accepted. Check it in Settings.'
  if (error instanceof Anthropic.NotFoundError) return `The model "${model}" was not found. Check its name in Settings.`
  if (error instanceof Anthropic.RateLimitError) return 'The API is rate limiting this key. Try again in a moment.'
  if (error instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API. Check your connection and try again.'
  if (error instanceof Anthropic.APIError) return `The Anthropic API answered with an error (${error.status ?? 'unknown'}): ${readable(error.message)}`
  return undefined
}

export function createAnthropicProvider({ apiKey, model = DEFAULT_ANTHROPIC_MODEL, fetch: fetchImpl = globalThis.fetch, privacy } = {}) {
  const send = guarded(fetchImpl, privacy)
  const client = new Anthropic({ apiKey, baseURL: ANTHROPIC_BASE_URL, fetch: send, maxRetries: 1 })
  const modern = CLAUDE_5.test(model)
  return {
    async complete({ system, messages, tools, signal }) {
      let response
      try {
        response = await client.beta.messages.create({
          model, max_tokens: MAX_OUTPUT_TOKENS, system, tools, messages,
          ...(modern ? { betas: [ANTHROPIC_FALLBACK_BETA], fallbacks: 'default', output_config: { effort: 'medium' } } : {}),
        }, { signal })
      } catch (error) {
        if (send.refused) { const refused = send.refused; send.refused = undefined; throw refused }
        const message = anthropicFailure(error, model)
        if (message) throw new Error(message)
        throw error
      }
      if (response.stop_reason === 'refusal') throw new Error('The model declined this request. Try asking for something else.')
      if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a shorter request.')
      // Thinking blocks go back unchanged on the next turn; text and tool calls are copied without response-only fields.
      const content = response.content.map(block => {
        if (block.type === 'text') return { type: 'text', text: block.text }
        if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
        return block
      })
      return { content, stop: response.stop_reason === 'tool_use' ? 'tool_use' : 'end' }
    },
  }
}

// OpenAI-compatible chat completions (Ollama, llama.cpp, LM Studio ...).
function toChatMessages(system, messages) {
  const out = [{ role: 'system', content: system }]
  for (const message of messages) {
    if (message.role === 'assistant') {
      const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      const calls = message.content.filter(block => block.type === 'tool_use')
      out.push({
        role: 'assistant', content: text || undefined,
        ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}),
      })
      continue
    }
    for (const block of message.content) {
      if (block.type === 'tool_result') out.push({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content })
      else if (block.type === 'text') out.push({ role: 'user', content: block.text })
    }
  }
  return out
}

function parseArguments(text) {
  try { const value = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { return {} }
}

export function createLocalProvider({ baseUrl, model, apiKey, fetch: fetchImpl = globalThis.fetch, privacy } = {}) {
  const send = guarded(fetchImpl, privacy)
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`
  return {
    async complete({ system, messages, tools, signal }) {
      const body = JSON.stringify({
        model, messages: toChatMessages(system, messages), tool_choice: 'auto',
        tools: tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.input_schema } })),
      })
      let response
      try {
        response = await send(endpoint, { method: 'POST', body, signal, headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } })
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) throw error
        if (String(error?.message).startsWith('Not sent:')) throw error
        throw new Error(`Could not reach ${new URL(endpoint).host}. Check that the model server is running and the address in Settings is right.`)
      }
      if (!response.ok) {
        const detail = readable(await response.text().catch(() => ''))
        if (response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN) throw new Error('The model server did not accept the key. Check it in Settings.')
        if (response.status === HTTP_NOT_FOUND) throw new Error(`The model server has no model "${model}" or no chat endpoint at that address. ${detail}`.trim())
        if (response.status === HTTP_RATE_LIMITED) throw new Error('The model server is busy. Try again in a moment.')
        throw new Error(`The model server answered with an error (${response.status}): ${detail}`)
      }
      const reply = await response.json().catch(() => undefined)
      const message = reply?.choices?.[0]?.message
      if (!message) throw new Error('The model server sent an answer Kept cannot read.')
      const content = []
      if (typeof message.content === 'string' && message.content.trim()) content.push({ type: 'text', text: message.content })
      for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArguments(call.function?.arguments) })
      return { content, stop: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end' }
    },
  }
}

export function createProvider(config, deps = {}) {
  if (config.provider === 'local') return createLocalProvider({ baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, ...deps })
  return createAnthropicProvider({ apiKey: config.apiKey, model: config.model || DEFAULT_ANTHROPIC_MODEL, ...deps })
}
