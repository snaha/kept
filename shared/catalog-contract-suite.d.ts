import type { CatalogService } from './catalog'

export type CatalogServiceHandle = {
  service: CatalogService
  dispose?(): void | Promise<void>
  // Closes the service and opens it again on the same storage, as a restart of the app does.
  restart?(): CatalogService | Promise<CatalogService>
}
// Registers node:test cases that every CatalogService implementation must pass.
// The factory is called once per case and must return an empty catalog.
export function runCatalogContractSuite(label: string, createService: () => CatalogServiceHandle | Promise<CatalogServiceHandle>): void
