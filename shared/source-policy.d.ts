import type { CatalogSource, SourceInput } from './catalog'

export function isAnalysable(source: Pick<SourceInput, 'policy'> | undefined): boolean
export function assertAnalysable<Source extends Pick<CatalogSource, 'id' | 'policy'>>(source: Source | undefined, what?: string): Source
