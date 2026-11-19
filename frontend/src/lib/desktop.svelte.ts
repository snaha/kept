import { loadLookupConsent } from './consent.svelte';
export const desktop = $state<{ status: DesktopStatus | null; error: string }>({ status: null, error: '' });

export function initDesktop() {
  const api = window.desktop;
  if (!api) return () => {};
  let active = true;
  const dispose = api.onChange(status => { if (active) desktop.status = status; });
  void loadLookupConsent();
  api.status().then(status => { if (active) desktop.status = status; }).catch(error => { if (active) desktop.error = error.message; });
  return () => { active = false; dispose(); };
}
