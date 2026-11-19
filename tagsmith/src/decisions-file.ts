/** The decisions file: the one place the dry run appends to, kept apart from the read-only library entry. */
import { appendFile, readFile } from 'node:fs/promises'
import type { Decision } from './decisions.ts'

export async function readDecisions(file: string): Promise<Decision[]> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw e
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision)
}

export async function appendDecisions(file: string, decisions: Decision[]): Promise<void> {
  if (decisions.length) await appendFile(file, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n')
}
