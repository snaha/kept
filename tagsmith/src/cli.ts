#!/usr/bin/env node
/** tagsmith: index a music library and plan tag fixes as a dry run. Nothing here writes to audio files.
 *
 *    tagsmith inventory <dir...> [--work work]   index folders recursively -> work/inventory.json
 *    tagsmith plan [--work work] [--config rules.json]   rules over the inventory -> work/decisions.jsonl
 *    tagsmith stats [--work work]                what the decisions would change
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { inventory, type Inventory } from './inventory.ts';
import { appendDecisions, formatStats, readDecisions, stats } from './decisions.ts';
import { plan, type RulesConfig } from './rules.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { work: { type: 'string', default: 'work' }, config: { type: 'string' }, verbose: { type: 'boolean', short: 'v', default: false } },
});
const [cmd, ...args] = positionals;
const work = resolve(values.work);
const inventoryFile = join(work, 'inventory.json');
const decisionsFile = join(work, 'decisions.jsonl');

const loadInventory = async (): Promise<Inventory> => JSON.parse(await readFile(inventoryFile, 'utf8')) as Inventory;

const commands: Record<string, () => Promise<void>> = {
  async inventory() {
    if (!args.length) throw new Error('inventory needs at least one folder');
    await mkdir(work, { recursive: true });
    const t0 = Date.now();
    const inv = await inventory(args.map((a) => resolve(a)), {
      onProgress: (done, dir) => {
        if (values.verbose) console.log(`${done} ${dir}`);
        else if (done % 50 === 0) process.stderr.write(`${done} folders\r`);
      },
    });
    await writeFile(inventoryFile, JSON.stringify(inv, null, 1));
    const byClass: Record<string, number> = {};
    for (const f of inv.folders) byClass[f.class] = (byClass[f.class] ?? 0) + 1;
    const files = inv.folders.reduce((n, f) => n + f.files.length, 0);
    console.log(`${inv.folders.length} folders, ${files} files in ${Math.round((Date.now() - t0) / 1000)}s -> ${inventoryFile}`);
    console.log(Object.entries(byClass).map(([c, n]) => `${c} ${n}`).join(', '));
    const flagged = inv.folders.filter((f) => f.findings.length);
    if (flagged.length) {
      console.log(`\n${flagged.length} folders with findings:`);
      for (const f of flagged) console.log(`  ${f.dir}\n    ${f.findings.join('\n    ')}`);
    }
  },
  async plan() {
    const inv = await loadInventory();
    const config: RulesConfig = values.config ? (JSON.parse(await readFile(values.config, 'utf8')) as RulesConfig) : {};
    const decided = new Set((await readDecisions(decisionsFile)).map((d) => d.path));
    const { decisions, skipped } = plan(inv, config, decided);
    await appendDecisions(decisionsFile, decisions);
    console.log(`dry run: ${decisions.length} files decided, ${skipped.length} folders skipped -> ${decisionsFile}`);
    if (values.verbose) for (const s of skipped) console.log(`  skipped ${s.dir}: ${s.why}`);
    console.log(formatStats(stats(decisions)));
  },
  async stats() {
    const decisions = await readDecisions(decisionsFile);
    console.log(formatStats(stats(decisions)));
    if (values.verbose) {
      const byDir = new Map<string, number>();
      for (const d of decisions) if (d.changes.length) byDir.set(d.album_dir, (byDir.get(d.album_dir) ?? 0) + 1);
      for (const [dir, n] of [...byDir].sort()) console.log(`  ${n} files: ${dir}`);
    }
  },
};

const run = commands[cmd ?? ''];
if (!run) {
  console.log('usage: tagsmith inventory <dir...> | plan [--config rules.json] | stats   [--work work] [-v]');
  process.exit(cmd ? 1 : 0);
}
await run();
