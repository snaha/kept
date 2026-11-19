# Contracts

The A0 DTOs and the C0 tool contracts live in `shared/`. Types are TypeScript.
Runtime code is JavaScript with a `.d.ts` next to it, so the desktop process, the
workers and the frontend all load the same files.

| File | Holds |
| --- | --- |
| `shared/catalog.ts` | The DTOs: sources and their policy, assets, locations, provider links, album anchors and track occurrences, observations, user decisions, consent, album and asset views, and the `CatalogService` interface |
| `shared/catalog-rules.js` | The rules as pure functions: `validateCatalogChange` (the source-class rule), `propagateLicence`, `propagateEvidenceClass`, `validateSource` and `routeSource` |
| `shared/catalog-fake.js` | `createFakeCatalogService`, the in-memory service |
| `shared/catalog-contract-suite.js` | `runCatalogContractSuite(label, factory)`. Every `CatalogService` must pass it. `desktop/catalog-contracts.test.js` runs it on the fake, and A1a runs it unchanged on the SQLite service |
| `shared/catalog-ledger.js` | `createLedger(store)`: commit, undo and suppression over a small synchronous store, so the fake and SQLite run the same logic. Added in A1b |
| `shared/catalog-projection.js` | The read model as pure functions: `projectAlbum`, the search rows, the sort order and the query terms. Added in A1b |
| `shared/tools.ts` | Input and output types of `search_catalog`, `find_similar`, `rank_tracks` and `build_queue` |
| `shared/tool-contracts.js` | `TOOL_CONTRACTS`, a descriptor with closed JSON schemas per tool, plus `validateToolInput` and `validateToolOutput` |
| `shared/catalog-bridge.js` | `createCatalogBridge(service)`: what the window may ask of the spine, keyed by the provider's album ID, plus `validateCatalogBridgeRequest` for IPC. Added in A1a. A1b added `activity` and `undo` |
| `frontend/src/lib/catalog.ts` | Re-exports the above for the frontend, which also puts them under `pnpm --dir frontend check` |

Rules that later phases build on:

- Every catalog ID is an opaque string that matches `ID_PATTERN`, so an ID is never a path. Tool results hold IDs and scores only.
- A source's kind, evidence class and licence are fixed once it is registered. Only its label and policy change. The `user` source is built in.
- An asset is identified by the hash of its audio payload and its size. Re-tagging or moving a file keeps the asset.
- A scan never merges or splits album anchors. A provider album ID that is not yet known is taken as a re-ID only when it covers every member of exactly one anchor. Any other disagreement is returned as a conflict.
- A source with model evidence cannot create a provider link. A value derived from a model observation is model evidence.
- A hand-set trait always wins over an estimate. Clearing it shows the estimate again. A decision older than the stored one is ignored, so a migration can be replayed.
- A service call rejects with an `Error` whose message starts with a `CatalogErrorCode` and a colon.
