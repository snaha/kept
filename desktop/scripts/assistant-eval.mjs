// Runs the assistant evaluation set (assistant-eval.json) against a real model, on the synthetic
// library in assistant-fixture.js. Nothing from a real library is used or sent.
//   ANTHROPIC_API_KEY=... node scripts/assistant-eval.mjs [--model claude-sonnet-5-5] [--only id,id]
//   KEPT_ASSISTANT_BASE_URL=http://localhost:11434/v1 KEPT_ASSISTANT_MODEL=llama3.1 node scripts/assistant-eval.mjs
// It makes one model call per turn (about 3 per prompt) and bills your own key. It is not part of the tests.
import { createAssistant } from '../assistant.js'
import { createAssistantWorld, FIXTURE_FOLDER } from '../assistant-fixture.js'
import { EVAL_CASES, runEval } from '../assistant-eval.js'
import { createProvider } from '../assistant-providers.js'

const flag = name => { const at = process.argv.indexOf(`--${name}`); return at > 0 ? process.argv[at + 1] : undefined }
const baseUrl = process.env.KEPT_ASSISTANT_BASE_URL
const config = baseUrl
  ? { provider: 'local', baseUrl, model: flag('model') ?? process.env.KEPT_ASSISTANT_MODEL, apiKey: process.env.KEPT_ASSISTANT_KEY }
  : { provider: 'anthropic', model: flag('model'), apiKey: process.env.ANTHROPIC_API_KEY }
if (config.provider === 'anthropic' && !config.apiKey) { console.error('Set ANTHROPIC_API_KEY, or KEPT_ASSISTANT_BASE_URL and KEPT_ASSISTANT_MODEL for a local server.'); process.exit(2) }
if (config.provider === 'local' && !config.model) { console.error('Set KEPT_ASSISTANT_MODEL (or --model) for the local server.'); process.exit(2) }

const world = await createAssistantWorld()
const assistant = createAssistant({ runner: world.runner })
const provider = createProvider(config, { privacy: { folders: [FIXTURE_FOLDER] } })
const only = flag('only')?.split(',')
const cases = EVAL_CASES.filter(item => !only || only.includes(item.id))
const results = await runEval(async prompt => {
  const { message, queue, calls } = await assistant.ask({ request: prompt, provider })
  return { message, queue, calls }
}, world, cases)
for (const result of results) console.log(`${result.passed ? 'pass' : 'FAIL'}  ${result.id}${result.passed ? '' : `\n      ${result.failures.join('\n      ')}`}`)
const failed = results.filter(result => !result.passed).length
console.log(`\n${results.length - failed} of ${results.length} passed`)
process.exit(failed ? 1 : 0)
