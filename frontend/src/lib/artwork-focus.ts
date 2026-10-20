import { isElementVisible } from './dom';

// Called by the app's existing key handler, with no persistent focus listeners
// or overlay registry. Native dialogs keep their own keyboard boundary.
export function wrapArtworkTab(event: KeyboardEvent) {
  if (event.key !== 'Tab' || event.defaultPrevented || document.querySelector('dialog[open]') || !document.querySelector('.artwork-view')) return;
  const controls = [...document.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], summary, [tabindex]')]
    .filter(control => control.tabIndex >= 0 && !control.matches(':disabled') && !control.closest('[inert]') && isElementVisible(control));
  const active = document.activeElement;
  if (event.shiftKey ? active !== controls[0] : active !== controls.at(-1)) return;
  const target = event.shiftKey ? controls.at(-1) : controls[0];
  if (target) { event.preventDefault(); target.focus({ preventScroll: true }); }
}

// Covered containers own inert in their templates. This view only owns its
// initial focus and opener; playback and native dialogs keep their own focus.
export function artworkFocusScope(node: HTMLElement) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let disposed = false;
  const restore = restoreFocusOnClose(node, previous);
  queueMicrotask(() => {
    if (disposed || node.closest('[inert]')) return;
    const active = document.activeElement;
    if (active instanceof Element && active.closest('dialog[open]')) return;
    if (active !== previous && active !== document.body) return;
    [...node.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      .find(button => button.tabIndex >= 0 && isElementVisible(button))?.focus({ preventScroll: true });
  });
  return () => {
    disposed = true;
    restore();
  };
}

export function restoreFocusOnClose(node: HTMLElement, previous: HTMLElement | null) {
  return () => {
    const active = document.activeElement;
    if (active !== document.body && !node.contains(active)) return;
    // Wait for the owner's template to remove inert from the covered view.
    queueMicrotask(() => {
      if (document.querySelector('dialog[open]')) return;
      if (document.activeElement !== document.body && !node.contains(document.activeElement)) return;
      const target = previous?.isConnected && previous !== document.body && previous !== document.documentElement && !previous.closest('[inert]') && isElementVisible(previous)
        ? previous : document.querySelector<HTMLElement>('.bar-toggle');
      if (target && !target.closest('[inert]') && isElementVisible(target)) target.focus({ preventScroll: true });
    });
  };
}
