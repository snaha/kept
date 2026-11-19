/** The read-only entry point: inventory, plan, identify, categorize and propose as plain functions. Nothing here
 *  writes a file or opens an audio file for writing. `apply`, `write`, the CLI and the decisions file stay out of
 *  this module on purpose, and a test fails if a write path becomes reachable from it. Pass `fetcher(undefined)`
 *  to identify without even a disk cache. */
export { inventory, classify, type Inventory, type Folder, type FolderClass, type InventoryOptions } from './inventory.ts'
export { plan, planFolder, planFiles, albumOfFolder, type RulesConfig } from './rules.ts'
export { stats, formatStats, type Decision, type Stats } from './decisions.ts'
/** Identify albums and recordings against MusicBrainz, the Cover Art Archive, LRCLIB and ffmpeg. Network access goes
 *  through the injected fetcher only. */
export { enrich as identify, findLyrics, STEPS, type Enrichment, type EnrichOptions, type Step, type TrackMatch } from './enrich.ts'
export { categorize, relPath, type Categories } from './categories.ts'
export { propose, type Proposal } from './proposal.ts'
export { fetcher, type Fetcher } from './net.ts'
export { readTags, type FileInfo, type Tags, type TagReader } from './tags.ts'
