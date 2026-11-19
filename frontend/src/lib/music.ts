export type { Source, Track, Collection, CatalogRef } from '../../../shared/music';
export const localId = (kind: string, id: string) => `local:${kind}:${id}`;
