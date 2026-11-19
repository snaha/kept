import type { CatalogService } from './catalog'
import type { FeatureSource, HistoryStats, ToolIo, ToolName, ToolRun } from './tools'
import type { CatalogSnapshot } from './tool-support.js'

// No features and no plays: tools fall back to traits and metadata.
export const noFeatures: FeatureSource
export const noHistory: HistoryStats
type ToolRunOptions = {
  targetSeconds?: number
  targetLength?: number
  allowedOccurrenceIds?: ReadonlySet<string>
  matchingAlbumIds?: ReadonlySet<string>
}
export type ToolRunner = {
  run<Name extends ToolName>(name: Name, input: unknown, options?: ToolRunOptions): Promise<ToolRun<Name>>
}
export function createToolRunner(services: { catalog: CatalogService; features?: FeatureSource; history?: HistoryStats }): ToolRunner & {
  loadCatalog(): Promise<CatalogSnapshot>
  runWithSnapshot<Name extends ToolName>(name: Name, input: unknown,
    resolveOptions?: (snapshot: CatalogSnapshot) => Promise<ToolRunOptions | undefined>,
  ): Promise<{ result: ToolRun<Name>; snapshot: CatalogSnapshot }>
}
export type { ToolIo }
