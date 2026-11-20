<script lang="ts">
  import Icon from './ui/icon.svelte'
  import { analysisPaused, analysisProgress, jobs, jobsSummary, pauseAnalysis, setAnalysisHidden } from './jobs.svelte'

  let { covered = false, onhide }: { covered?: boolean; onhide?: () => void } = $props()
  let announcement = $state('')

  // The background work line at the bottom of the library. Sound analysis can be paused here, or hidden;
  // Settings > Analysis shows it again and has the rest.
  const text = $derived(jobsSummary(jobs.status, { analysisHidden: jobs.analysisHidden }))
  const analysing = $derived(!jobs.analysisHidden && !!analysisProgress(jobs.status))
  const paused = $derived(analysisPaused(jobs.status))
  const pauseError = $derived(jobs.analysisHidden ? '' : jobs.pauseError)
  function hide() {
    setAnalysisHidden(true)
    announcement = 'Analysis progress hidden. To show it again, open Settings and choose Analysis.'
    onhide?.()
  }
</script>

{#if text || pauseError}
  <div class="jobs" inert={covered}>
    {#if text}<span role="status">{text}</span>{/if}
    {#if analysing}
      <button onclick={() => pauseAnalysis(!paused)} aria-disabled={jobs.busy} aria-label={paused ? 'Resume analysis' : 'Pause analysis'} title={paused ? 'Resume analysis' : 'Pause analysis'}><Icon name={paused ? 'play' : 'pause'} size={14} /></button>
      <button onclick={hide} aria-label="Hide analysis progress" title="Hide. Settings > Analysis shows it again"><Icon name="close" size={14} /></button>
    {/if}
    {#if pauseError}<span class="error" role="alert">{pauseError}</span>{/if}
  </div>
{/if}
<span class="announcement" role="status" inert={covered}>{jobs.analysisHidden ? announcement : ''}</span>

<style>
  .jobs { position: fixed; left: 16px; bottom: 90px; max-width: min(650px, calc(100vw - 32px)); display: flex; align-items: center; gap: 4px; padding: 4px 6px 4px 12px; box-sizing: border-box; color: var(--ui-text); background: var(--ui-surface); z-index: 3; font: 12px/1.5 var(--ui-font); }
  span { padding: 4px 4px 4px 0; }
  button { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--ui-radius); background: transparent; color: var(--ui-text-muted); cursor: pointer; }
  button:hover { background: var(--ui-muted); color: var(--ui-text); }
  button:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 1px; }
  button[aria-disabled="true"] { opacity: .45; cursor: default; }
  .error { color: #ffb8ad; }
  .announcement { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (pointer: coarse) { button { width: 44px; height: 44px; } }
</style>
