export const HISTORY_SCHEMA_VERSION = 1;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string';
const CATALOG_REF_KINDS = ['navidrome', 'asset'];
export const isCatalogRef = ref => object(ref) && CATALOG_REF_KINDS.includes(ref.kind) && text(ref.id) && ref.id.length > 0;
export function isStoredTrack(track) {
  return object(track) && text(track.id) && text(track.rawId) && text(track.title) && track.source === 'local'
    && typeof track.available === 'boolean' && text(track.cover) && (track.catalogRef === undefined || isCatalogRef(track.catalogRef))
    && (track.playbackOriginIndex === undefined || (Number.isInteger(track.playbackOriginIndex) && track.playbackOriginIndex >= 0));
}
export function isListeningContext(context) {
  return object(context) && text(context.id) && Array.isArray(context.queue) && context.queue.every(isStoredTrack)
    && ['normal', 'shuffle', 'random'].includes(context.order) && Array.isArray(context.permutation)
    && context.permutation.every(index => Number.isInteger(index) && index >= 0 && index < context.queue.length);
}
export function validateHistoryEnvelope(method, args) {
  if (!object(args) || !text(args.scope) || !args.scope || args.scope.length > 2048) throw new Error('Invalid history scope');
  if (args.version !== undefined && args.version !== HISTORY_SCHEMA_VERSION) throw new Error('Unsupported history schema version');
  if (!['write', 'list', 'clear', 'stats'].includes(method)) throw new Error('Unknown history operation');
  if (method === 'write' && (!Array.isArray(args.contexts) || !Array.isArray(args.entries))) throw new Error('Invalid history batch');
  if (method === 'list' && ((args.query !== undefined && (!text(args.query) || args.query.length > 4096)) || (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || args.offset < 0)) || (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)))) throw new Error('Invalid history query');
  return args;
}
export function validateHistoryRequest(method, args) {
  validateHistoryEnvelope(method, args);
  if (method === 'write') {
    if (!Array.isArray(args.contexts) || !args.contexts.every(isListeningContext) || !Array.isArray(args.entries)) throw new Error('Invalid history batch');
    if (args.importKey !== undefined && !text(args.importKey)) throw new Error('Invalid history import');
    for (const entry of args.entries) if (!object(entry) || !text(entry.id) || !text(entry.contextId) || !Number.isInteger(entry.index) || entry.index < 0 || !Number.isInteger(entry.cursor) || !Number.isSafeInteger(entry.playedAt) || entry.playedAt <= 0 || entry.playedAt > 8640000000000000) throw new Error('Invalid listening event');
  } else if (method === 'list') {
    if ((args.query !== undefined && !text(args.query)) || (args.offset !== undefined && (!Number.isInteger(args.offset) || args.offset < 0))) throw new Error('Invalid history query');
  } else if (!['clear', 'stats'].includes(method)) throw new Error('Unknown history operation');
  return args;
}
export function validateDesktopRequest(name, args) {
  if (name === 'start' && args[0] !== undefined) {
    const options = args[0];
    if (!object(options) || (options.source !== undefined && !['folder', 'empty'].includes(options.source)) || (options.musicFolder !== undefined && !text(options.musicFolder)) || (options.musicFolders !== undefined && (!Array.isArray(options.musicFolders) || !options.musicFolders.every(text)))) throw new Error('Invalid library setup options');
  }
  if (name === 'switch-profile' && (!['fresh', 'copy', 'continue', 'existing'].includes(args[0]) || (args[1] !== undefined && !text(args[1])))) throw new Error('Invalid profile selection');
  if (name === 'change-folder' && ((args[0] !== undefined && !['replace', 'add', 'remove'].includes(args[0])) || (args[1] !== undefined && !text(args[1])))) throw new Error('Invalid folder change');
  if (name === 'set-frame' && typeof args[0] !== 'boolean') throw new Error('Invalid window preference');
}
