import { initPlayback, disposePlayback } from './player.svelte';
import { watchScan, disposeLibrary } from './library.svelte';
import { disposeCatalogSearch } from './catalog-search.svelte';
import { startDiscovery } from './discovery.svelte';
import { startBackground } from './background.svelte';
import { startUiStyle } from './ui-style.svelte';
import { startPreferenceStatus } from './preferences-status.svelte';
import { disposeHistory } from './listening-history.svelte';
import { startControlHost } from './control-host.svelte';
let dispose: (() => void) | undefined;
export function startRuntime() {
  if (dispose) return dispose;
  initPlayback();
  const subscriptions = [startPreferenceStatus(), startUiStyle(), startBackground(), startDiscovery(), watchScan(), startControlHost()];
  let active = true;
  dispose = () => {
    if (!active) return; active = false;
    for (const stop of subscriptions.reverse()) stop();
    disposeCatalogSearch(); disposeLibrary(); disposeHistory(); disposePlayback(); dispose = undefined;
  };
  return dispose;
}
if (import.meta.hot) import.meta.hot.dispose(() => dispose?.());
