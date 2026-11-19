import type { Track, Source } from './music.ts';

export type PlaybackAdapter = {
  available(track: Track): void;
  prepare(track: Track): Promise<void>;
  start(track: Track): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  seek(seconds: number): Promise<void>;
};

// Every operation joins one serial lane. New intentions invalidate queued work; in-flight
// playback commands must settle before another track is allowed to make sound.
export class PlaybackController {
  private revision = 0;
  private tail: Promise<void> = Promise.resolve();
  active: Source | undefined;
  current: Track | undefined;
  private adapters: Partial<Record<Source, PlaybackAdapter>>;
  constructor(adapters: Partial<Record<Source, PlaybackAdapter>>) { this.adapters = adapters; }

  private schedule(operation: (current: () => boolean) => Promise<void>) {
    const revision = ++this.revision;
    const task = this.tail.catch(() => {}).then(async () => {
      if (revision !== this.revision) return;
      await operation(() => revision === this.revision);
    });
    this.tail = task;
    return task;
  }

  supports(source: Source) { return !!this.adapters[source]; }

  // Synchronous pre-check for a track's own adapter, so play and skip add no await.
  available(track: Track) {
    const adapter = this.adapters[track.source];
    if (!adapter) throw new Error('This music source is not supported by this build.');
    adapter.available(track);
  }

  play(track: Track) {
    return this.schedule(async (current) => {
      const next = this.adapters[track.source];
      if (!next) throw new Error('This music source is not supported by this build.');
      next.available(track);
      if (this.active) await this.adapters[this.active]?.pause();
      if (!current()) return;
      await next.prepare(track);
      if (!current()) return;
      this.active = track.source; this.current = track;
      try { await next.start(track); }
      catch (error) { await next.pause().catch(() => {}); throw error; }
      if (!current()) await next.pause();
    });
  }
  pause() { return this.schedule(async () => { if (this.active) await this.adapters[this.active]?.pause(); }); }
  resume() { return this.schedule(async () => { if (this.active) await this.adapters[this.active]?.resume(); }); }
  seek(seconds: number) { return this.schedule(async () => { if (this.active) await this.adapters[this.active]?.seek(seconds); }); }
  // A lost source has nothing left to pause. Already queued intentions still own the lane.
  releaseSource(source: Source) {
    if (this.active !== source) return
    this.active = undefined
    this.current = undefined
  }
  // Sign-out must finish retiring its source before later commands enter the lane.
  retire(source: Source) {
    const task = this.tail.catch(() => {}).then(async () => {
      if (this.active !== source) return
      try { await this.adapters[source]?.pause() }
      finally { this.releaseSource(source) }
    })
    this.tail = task
    return task
  }
  // Remember the outgoing adapter so an explicit retry still stops it before a handoff.
  suspend() { this.revision++; }
  // Release playback ownership without sending a command back.
  release() { this.revision++; this.active = undefined; this.current = undefined; }
}
