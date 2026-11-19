// Evaluation of the assistant: prompts, the shape of the tool calls each should produce, and a checker
// that works on a trace of any model, scripted or real. assistant-eval.json holds the cases.
import { readFileSync } from 'node:fs'

export const EVAL_CASES = JSON.parse(readFileSync(new URL('./assistant-eval.json', import.meta.url), 'utf8')).cases

// "$album:key", "$track:key:n", "$ref:album:key" and "$ref:track:key:n" become the fixture's IDs.
export function resolvePlaceholders(value, world) {
  if (Array.isArray(value)) return value.map(item => resolvePlaceholders(item, world))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolvePlaceholders(item, world)]))
  if (typeof value !== 'string' || !value.startsWith('$')) return value
  const [kind, ...rest] = value.slice(1).split(':')
  const idOf = (what, key, n) => (what === 'album' ? world.ids[key] : world.tracks[key][Number(n)])
  if (kind === 'ref') { const [what, key, n] = rest; return { kind: what, id: idOf(what, key, n) } }
  return idOf(kind, rest[0], rest[1])
}

const MIN_QUEUE = 1
const at = (value, path) => path.split('.').reduce((node, part) => (node !== undefined && typeof node === 'object' && node ? node[part] : undefined), value)
function satisfies(actual, wanted) {
  if (typeof wanted !== 'object' || !wanted) return actual === wanted
  if ('min' in wanted && !(typeof actual === 'number' && actual >= wanted.min)) return false
  if ('max' in wanted && !(typeof actual === 'number' && actual <= wanted.max)) return false
  if ('matches' in wanted && !(typeof actual === 'string' && new RegExp(wanted.matches, 'i').test(actual))) return false
  if ('not' in wanted && actual === wanted.not) return false
  if ('present' in wanted && (actual !== undefined) !== wanted.present) return false
  return true
}

// Returns the reasons a trace does not meet the expectation; empty when it does.
// A trace is { calls: [{ name, input, error? }], queue: [...], message }.
export function checkTrace(expect, trace) {
  const failures = []
  const names = trace.calls.map(call => call.name)
  for (const wanted of expect.calls ?? []) {
    const hit = trace.calls.some(call => call.name === wanted.tool && Object.entries(wanted.input ?? {}).every(([path, predicate]) => satisfies(at(call.input, path), predicate)))
    if (!hit) failures.push(`no ${wanted.tool} call with ${JSON.stringify(wanted.input ?? {})}`)
  }
  for (const tool of expect.forbid ?? []) if (names.includes(tool)) failures.push(`called ${tool}`)
  if (expect.maxCalls !== undefined && trace.calls.length > expect.maxCalls) failures.push(`${trace.calls.length} calls, at most ${expect.maxCalls}`)
  if (expect.queue === 'required' && trace.queue.length < MIN_QUEUE) failures.push('no queue was built')
  if (expect.queue === 'none' && trace.queue.length) failures.push(`a queue of ${trace.queue.length} was offered`)
  if (expect.queueLength !== undefined && !satisfies(trace.queue.length, expect.queueLength)) failures.push(`unexpected queue length: ${trace.queue.length}`)
  for (const [field, predicate] of Object.entries(expect.queueItems ?? {})) {
    if (!trace.queue.every(item => satisfies(item[field], predicate))) failures.push(`queue items do not match ${field}: ${JSON.stringify(predicate)}`)
  }
  if (expect.reply && !new RegExp(expect.reply, 'i').test(trace.message)) failures.push(`reply does not match ${expect.reply}`)
  if (expect.replyNot && new RegExp(expect.replyNot, 'i').test(trace.message)) failures.push(`reply matches ${expect.replyNot}`)
  return failures
}

// A model that replays a script: each complete() call answers with the next turn. It checks that the
// loop hands it a tool_result for every tool call it made, which is what a real API would insist on.
export function createScriptedModel(turns, world) {
  let index = 0
  const seen = []
  return {
    seen,
    async complete({ messages }) {
      seen.push(messages.length)
      const last = messages.at(-1)
      if (index > 0) {
        const asked = turns[index - 1].calls ?? []
        const answered = last.content.filter(block => block.type === 'tool_result').length
        if (last.role !== 'user' || answered !== asked.length) throw new Error('The loop did not answer every tool call of the previous turn')
      }
      const turn = turns[index++]
      if (!turn) throw new Error('The script ran out of turns')
      const content = [
        ...(turn.text ? [{ type: 'text', text: turn.text }] : []),
        ...(turn.calls ?? []).map((call, position) => ({ type: 'tool_use', id: `toolu_${index}_${position}`, name: call.name, input: resolvePlaceholders(call.input, world) })),
      ]
      return { content, stop: turn.calls?.length ? 'tool_use' : 'end' }
    },
  }
}

// Runs every case through `ask(prompt, testCase)` and reports each one. `ask` resolves to a trace.
export async function runEval(ask, world, cases = EVAL_CASES) {
  const results = []
  for (const testCase of cases) {
    let failures
    try { failures = checkTrace(resolvePlaceholders(testCase.expect, world), await ask(testCase.prompt, testCase)) } catch (error) { failures = [`error: ${error.message}`] }
    results.push({ id: testCase.id, passed: failures.length === 0, failures })
  }
  return results
}
