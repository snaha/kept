<script lang="ts">
  import Button from './ui/button.svelte'
  import type { ActivityEntry } from './activity'
  // onundo: the whole change, or one operation of it.
  let { entries, onundo }: { entries: ActivityEntry[]; onundo: (id: string, operation?: number) => void } = $props()
  const NOT_SET = 'not set'
  // Who made the change, naming the route behind an automated one.
  const who = (entry: ActivityEntry) => entry.actor === 'you' ? 'You' : entry.route ? `Kept (${entry.route})` : 'Kept'
  const time = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
</script>
<section class="activity" aria-labelledby="activity-title">
  <h2 id="activity-title">Activity</h2>
  {#if entries.length}
    <ol>
      {#each entries as entry (entry.id)}
        <li class:undone={entry.undone}>
          <div class="text">
            <span class="summary">{entry.summary}</span>
            {#if entry.detail}<span class="detail">{entry.detail}</span>{/if}
            <!-- What Kept changed, before and after. A change of several parts can be taken back one part at a time. -->
            {#if entry.actor === 'kept' && entry.operations?.length}
              {@const parts = entry.operations.length > 1}
              <ul class="compare" aria-label="What changed">
                {#each entry.operations as operation (operation.index)}
                  <li class:undone={operation.undone}>
                    <span class="what">{operation.label}</span>
                    <span class="values"><span class="before"><span class="sr">{'was '}</span>{operation.before ?? NOT_SET}</span><span class="arrow" aria-hidden="true">→</span><span class="after"><span class="sr">{'now '}</span>{operation.after ?? NOT_SET}</span></span>
                    {#if parts && !entry.undone}
                      {#if operation.undone}<span class="state">Undone</span>
                      {:else}<Button variant="outline" size="sm" disabled={entry.undoable === false} aria-label="Undo only: {operation.label}, {operation.after ?? NOT_SET}" onclick={() => onundo(entry.id, operation.index)}>Undo</Button>{/if}
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
            <span class="meta">{who(entry)} · <time datetime={new Date(entry.at).toISOString()}>{time(entry.at)}</time></span>
          </div>
          {#if entry.undone}<span class="state">Undone</span>
          {:else}<Button variant="outline" size="sm" disabled={entry.undoable === false} aria-label="Undo: {entry.summary}" onclick={() => onundo(entry.id)}>{(entry.operations?.length ?? 0) > 1 ? 'Undo all' : 'Undo'}</Button>{/if}
        </li>
      {/each}
    </ol>
  {:else}
    <p class="empty">Nothing yet. Changes Kept makes to your library will be listed here, each with an Undo.</p>
  {/if}
</section>
<style>
  .activity { display: flex; flex-direction: column; gap: 10px; color: var(--ui-text); font: 14px/1.4 var(--ui-font); }
  h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
  ol { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); overflow: hidden; }
  ol > li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: var(--ui-surface); }
  ol > li + li { border-top: 1px solid var(--ui-border); }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .compare { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; padding: 0; list-style: none; font-size: 13px; }
  .compare li { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 10px; }
  .what { color: var(--ui-text-muted); }
  .values { display: flex; flex-wrap: wrap; gap: 2px 8px; min-width: 0; overflow-wrap: anywhere; }
  .before { color: var(--ui-text-muted); text-decoration: line-through; } .arrow { color: var(--ui-text-muted); }
  .compare .undone .after { color: var(--ui-text-muted); text-decoration: line-through; } .compare .undone .before { color: var(--ui-text); text-decoration: none; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .summary { overflow-wrap: anywhere; } .detail, .meta, .state, .empty { color: var(--ui-text-muted); font-size: 12px; }
  ol > .undone .summary { text-decoration: line-through; color: var(--ui-text-muted); }
  /* The same box as the Undo button it replaces, so undoing never moves or re-wraps a row. */
  .state { flex-shrink: 0; display: grid; place-items: center; min-width: 56px; min-height: 30px; box-sizing: border-box; }
  li :global([data-slot=button]) { flex-shrink: 0; min-width: 56px; min-height: 30px; }
  ol > li > :global([data-slot=button]), ol > li > .state { min-width: 72px; }
  .empty { margin: 0; padding: 14px 12px; border: 1px dashed var(--ui-border); border-radius: var(--ui-radius); }
  @media (max-width: 600px) { li :global([data-slot=button]), .state { min-height: 44px; min-width: 64px; } }
</style>
