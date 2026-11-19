type DesktopStatus = import('../../shared/contracts').DesktopStatus;
type DesktopProfile = import('../../shared/contracts').DesktopProfile;
type ProfileEntry = import('../../shared/contracts').ProfileEntry;
// injected by the Electron preload (desktop/preload.js)
interface Window {
  musicHistory?: {
    stats?(query: { scope: string }): Promise<Record<string, { plays: number; lastPlayed: number }>>;
    write(batch: import('../../shared/contracts').HistoryBatch): Promise<void>;
    list(query: { scope: string; query?: string; offset?: number; limit?: number }): Promise<import('../../shared/contracts').HistoryPage>;
    clear(scope: string): Promise<void>;
  };
  // The identity spine (desktop/preload.js). Absent in a browser: device preferences serve instead.
  musicCatalog?: import('../../shared/catalog-bridge').CatalogBridge & { onChange: (callback: () => void) => () => void };
  // Background jobs (desktop/preload.js): playback reports go to the library worker, progress comes back.
  musicJobs?: {
    reportPlayback(report: import('./lib/playback-activity').PlaybackReport): void;
    status(): Promise<import('./lib/jobs.svelte').JobsStatus>;
    onChange(callback: (status: import('./lib/jobs.svelte').JobsStatus) => void): () => void;
  };
  // The optional LLM assistant (desktop/preload.js). The key is kept by the main process; the window only learns that one exists.
  // Spotify, playback only (desktop/preload.js). Tokens stay in the main process.
  musicSpotify?: import('./lib/spotify.svelte').SpotifyBridge;
  musicAssistant?: {
    status(): Promise<import('./lib/assistant.svelte').AssistantStatus>;
    save(change: import('./lib/assistant.svelte').AssistantChange): Promise<import('./lib/assistant.svelte').AssistantStatus>;
    ask(request: { request: string; id: string }): Promise<import('./lib/assistant.svelte').AssistantReply>;
    cancel(id?: string): Promise<void>;
  };
  desktop?: {
    status: () => Promise<DesktopStatus>;
    start: (options?: { source?: 'folder' | 'empty'; musicFolder?: string; musicFolders?: string[] }) => Promise<DesktopStatus>;
    chooseFolder: () => Promise<string | null>;
    finishSetup: () => Promise<DesktopStatus>;
    profiles: () => Promise<ProfileEntry[]>;
    switchProfile: (mode: 'fresh' | 'copy' | 'continue' | 'existing', name?: string) => Promise<void>;
    showData: () => Promise<string>;
    changeFolder: (mode?: 'replace' | 'add' | 'remove', folder?: string) => Promise<void>;
    restart: () => Promise<void>;
    onChange: (callback: (status: DesktopStatus) => void) => () => void;
    lanIp: () => Promise<string>;
    lanShare?: () => Promise<import('./lib/lan-catalog').LanShare | undefined>;
    setFrame: (on: boolean) => Promise<void>; // reopens the window with or without it
  };
}

// the dev machine's LAN address, from vite.config.ts
declare const __LAN_IP__: string;

// AudioWorkletGlobalScope (not included in TypeScript's DOM library).
declare const sampleRate: number;
declare class AudioWorkletProcessor { readonly port: MessagePort; }
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
