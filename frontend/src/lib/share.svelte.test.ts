import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'vitest-browser-svelte';
import { tick } from 'svelte';
import Share from './Share.svelte';

vi.mock('./sharing.svelte', async (original) => ({
  ...(await original<typeof import('./sharing.svelte')>()),
  shareLink: vi.fn(async () => 'http://10.0.0.2:4000/#u=share&p=secret&s=http%3A%2F%2F10.0.0.2%3A4533'),
}));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Share drawer', () => {
  it('offers only the Library code without the desktop app', async () => {
    render(Share, { onclose: () => {} });
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('img.qr')?.src).toMatch(/^data:image/));
    expect(document.querySelector('[role=tablist]')).toBeNull();
    expect(document.body.textContent).toContain('on a phone');
  });
  it('opens on the Control code and switches to a different Library code from the tabs', async () => {
    vi.stubGlobal('desktop', {});
    render(Share, { onclose: () => {} });
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('img.qr')?.src).toMatch(/^data:image/));
    const control = document.querySelector<HTMLButtonElement>('#share-tab-control')!, library = document.querySelector<HTMLButtonElement>('#share-tab-library')!;
    expect(control.getAttribute('aria-selected')).toBe('true');
    const controlCode = document.querySelector<HTMLImageElement>('img.qr')!.src;
    expect(document.body.textContent).toContain('on this computer');
    library.click(); await tick();
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('img.qr')!.src).not.toBe(controlCode));
    expect(library.getAttribute('aria-selected')).toBe('true');
    expect(document.body.textContent).toContain('on a phone');
    library.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector<HTMLImageElement>('img.qr')!.src).toBe(controlCode));
    expect(control.getAttribute('aria-selected')).toBe('true');
  });
});
