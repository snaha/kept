<script lang="ts">
  import { tick, untrack } from 'svelte'
  import Button from './ui/button.svelte'
  import { analysisPaused, jobs, loadCoverage, pauseAnalysis, restartAnalysis, setAnalysisHidden } from './jobs.svelte'
  import { spotifyBridge } from './spotify.svelte'

  // Sound analysis at a glance: how much of the collection has been heard, and the controls for it.
  const COVERAGE_REFRESH_MS = 2000
  const PERCENT = 100
  let confirming = $state(false)
  let settings: HTMLElement
  const coverage = $derived(jobs.coverage)
  const paused = $derived(analysisPaused(jobs.status))
  const percent = $derived(coverage?.tracks ? Math.floor((coverage.analysed / coverage.tracks) * PERCENT) : 0)
  const summary = $derived(!coverage ? '' : paused ? 'Paused. Kept keeps its place and continues when you resume.'
    : !coverage.waiting ? 'Up to date. New and changed tracks are analyzed after each scan.'
    : jobs.status?.mode === 'playing' ? 'Analyzing slowly while music plays.'
    : jobs.status?.mode === 'hold' ? 'Waiting for playback to settle.'
    : 'Analyzing.')
  const count = (value: number, noun: string) => `${value.toLocaleString()} ${noun}${value === 1 ? '' : 's'}`

  // The counts follow the work: refreshed on open and at most every two seconds while tracks finish.
  $effect(() => { untrack(() => void loadCoverage()) })
  let timer: ReturnType<typeof setTimeout> | undefined
  $effect(() => {
    jobs.status
    if (timer === undefined) timer = setTimeout(() => { timer = undefined; void loadCoverage() }, COVERAGE_REFRESH_MS)
  })
  $effect(() => () => clearTimeout(timer))
  async function openQuestion() {
    confirming = true
    await tick()
    settings?.querySelector<HTMLButtonElement>('#analysis-cancel-restart')?.focus({ preventScroll: true })
  }
  async function closeQuestion() {
    if (jobs.busy) return
    confirming = false
    await tick()
    settings?.querySelector<HTMLButtonElement>('#analysis-start-over')?.focus({ preventScroll: true })
  }
  async function startOver() {
    if (jobs.busy) return
    await restartAnalysis()
    await closeQuestion()
  }
</script>

<section class="analysis" aria-labelledby="analysis-title" bind:this={settings}>
  <h2 id="analysis-title">Sound analysis</h2>
  <p class="help">Kept listens to three short excerpts of each track to learn how it sounds. That powers Dig, similar albums and the energy and mood estimates. It runs on this computer only, never changes your files, and slows down while music plays.{#if spotifyBridge()} Spotify tracks are never analyzed.{/if}</p>
  {#if !coverage}
    <p role="status">Counting your collection…</p>
  {:else if !coverage.ready}
    <p role="status">Sound analysis is unavailable in this copy of Kept: {coverage.missing}.</p>
  {:else}
    <div class="meter" role="progressbar" aria-label="Tracks analyzed" aria-valuemin={0} aria-valuemax={coverage.tracks} aria-valuenow={coverage.analysed} aria-valuetext="{percent}%"><span style:width="{percent}%"></span></div>
    <p class="total"><strong>{coverage.analysed.toLocaleString()} of {count(coverage.tracks, 'track')}</strong> analyzed ({percent}%)</p>
    <ul class="counts">
      {#if coverage.waiting}<li>{count(coverage.waiting, 'track')} still to analyze</li>{/if}
      {#if coverage.unreadable}<li>{count(coverage.unreadable, 'track')} could not be read</li>{/if}
      {#if coverage.unavailable}<li>{count(coverage.unavailable, 'track')} not found right now, for example on a disconnected drive</li>{/if}
      {#if coverage.refused}<li>{count(coverage.refused, 'track')} from sources that do not allow analysis</li>{/if}
    </ul>
    <p role="status">{summary}</p>
    <div class="buttons">
      <Button variant="outline" aria-disabled={jobs.busy} onclick={() => pauseAnalysis(!paused)}>{paused ? 'Resume analysis' : 'Pause analysis'}</Button>
      {#if !confirming}
        <Button id="analysis-start-over" variant="outline" disabled={jobs.busy} onclick={openQuestion}>Start over…</Button>
      {/if}
    </div>
    {#if confirming}
      <div class="confirm" role="group" aria-labelledby="start-over-question">
        <p id="start-over-question">Forget everything Kept has heard and analyze the whole collection again? Dig and similar albums fill in again as tracks are analyzed.</p>
        <div class="buttons">
          <Button variant="outline" aria-disabled={jobs.busy} onclick={startOver}>Start over</Button>
          <Button id="analysis-cancel-restart" variant="outline" aria-disabled={jobs.busy} onclick={closeQuestion}>Cancel</Button>
        </div>
      </div>
    {/if}
  {/if}
  <label class="toggle"><input type="checkbox" checked={!jobs.analysisHidden} onchange={event => setAnalysisHidden(!event.currentTarget.checked)} /> Show analysis progress at the bottom of the library</label>
  {#if jobs.error}<p class="err" role="alert">{jobs.error}</p>{/if}
</section>

<style>
  .analysis { display: flex; flex-direction: column; gap: 10px; }
  h2 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
  .help { margin: 0; color: var(--ui-text-muted); font-size: 13px; line-height: 1.6; max-width: 72ch; }
  .meter { height: 8px; max-width: 480px; border-radius: 4px; background: var(--ui-muted); overflow: hidden; }
  .meter span { display: block; height: 100%; background: var(--ui-accent); transition: width .4s ease; }
  @media (prefers-reduced-motion: reduce) { .meter span { transition: none; } }
  .total, p[role="status"] { margin: 0; }
  .counts { margin: 0; padding-left: 18px; color: var(--ui-text-muted); font-size: 13px; line-height: 1.7; }
  .counts:empty { display: none; }
  .buttons { display: flex; flex-wrap: wrap; gap: 10px; }
  .buttons :global(button[aria-disabled="true"]) { opacity: .5; cursor: default; }
  .confirm { display: flex; flex-direction: column; gap: 8px; padding: 12px; max-width: 560px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); }
  .confirm p { margin: 0; }
  .toggle { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .err { margin: 0; color: #ffb8ad; }
</style>
