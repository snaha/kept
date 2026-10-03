/** The dry-run log: one JSON line per file, same shape as the Python pipeline's work/decisions.jsonl. */
import { appendFile, readFile } from 'node:fs/promises';
import { FIELDS, type Tags } from './tags.ts';

export type Decision = {
  step: 'tag';
  path: string;
  /** 'match' proposes the tags in `after`; 'asis' leaves the file alone */
  decision: 'match' | 'asis';
  mode: 'album' | 'single';
  /** which stage decided: 'rules' here, 'musicbrainz' once identify exists */
  source: string | null;
  /** human-readable identity of the chosen album */
  release: string | null;
  album_dir: string;
  before: Tags;
  after: Tags | null;
  changes: (keyof Tags)[];
  /** why the stage decided so, for the review sheet */
  reason: string;
};

export async function readDecisions(file: string): Promise<Decision[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Decision);
}

export async function appendDecisions(file: string, decisions: Decision[]): Promise<void> {
  if (decisions.length) await appendFile(file, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n');
}

export type Stats = {
  files: number;
  changed: number;
  asis: number;
  folders: number;
  byField: Record<string, number>;
  bySource: Record<string, number>;
};

export function stats(decisions: Decision[]): Stats {
  const byField: Record<string, number> = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  const bySource: Record<string, number> = {};
  const folders = new Set<string>();
  let changed = 0;
  for (const d of decisions) {
    folders.add(d.album_dir);
    if (d.decision === 'match' && d.changes.length) {
      changed++;
      for (const f of d.changes) byField[f]++;
      const s = d.source ?? 'unknown';
      bySource[s] = (bySource[s] ?? 0) + 1;
    }
  }
  return { files: decisions.length, changed, asis: decisions.length - changed, folders: folders.size, byField, bySource };
}

export function formatStats(s: Stats): string {
  const fields = Object.entries(s.byField).filter(([, n]) => n).map(([f, n]) => `${f} ${n}`).join(', ');
  const sources = Object.entries(s.bySource).map(([f, n]) => `${f} ${n}`).join(', ');
  return [
    `${s.files} files in ${s.folders} folders: ${s.changed} would change, ${s.asis} stay as they are`,
    fields ? `fields: ${fields}` : 'fields: none',
    sources ? `by source: ${sources}` : '',
  ].filter(Boolean).join('\n');
}
