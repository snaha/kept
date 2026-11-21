<script lang="ts">
  import type { ThirdPartyNotice } from './third-party'
  let { notices }: { notices: readonly ThirdPartyNotice[] } = $props()
</script>
<section class="notices" aria-labelledby="notices-title">
  <h2 id="notices-title">Third-party notices</h2>
  <p class="lead">Kept is built with the software and data below. Each keeps its own licence. Everything listed runs on this computer.</p>
  <ul>
    {#each notices as notice (notice.id)}
      <li aria-labelledby="notice-{notice.id}">
        <div class="head">
          <h3 id="notice-{notice.id}">{notice.name}{#if notice.version}{' '}<span class="version">{notice.version}</span>{/if}</h3>
          <span class="licence">{notice.licence}</span>
        </div>
        <p>{notice.use}</p>
        {#each notice.terms as term (term)}<p class="term">{term}</p>{/each}
        {#if notice.attribution}<p class="term"><span class="k">Attribution</span> {notice.attribution}</p>{/if}
        {#if notice.configure}
          <p class="k" id="configure-{notice.id}">Configure line</p>
          <pre aria-labelledby="configure-{notice.id}">{notice.configure}</pre>
        {/if}
        <p class="source"><span class="k">Source</span> {notice.source}</p>
      </li>
    {/each}
  </ul>
</section>
<style>
  .notices { display: flex; flex-direction: column; gap: 10px; color: var(--ui-text); font: 14px/1.45 var(--ui-font); }
  h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -.015em; }
  h3 { margin: 0; font-size: 14px; font-weight: 600; }
  p { margin: 0; overflow-wrap: anywhere; }
  .lead, .term, .source, .version { color: var(--ui-text-muted); }
  .term, .source { font-size: 12px; }
  ul { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); overflow: hidden; }
  li { display: flex; flex-direction: column; gap: 6px; padding: 12px; background: var(--ui-surface); }
  li + li { border-top: 1px solid var(--ui-border); }
  .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .version { font-weight: 400; }
  .licence { flex-shrink: 0; padding: 1px 8px; border: 1px solid var(--ui-border); border-radius: 999px; color: var(--ui-text-muted); font-size: 12px; }
  .k { color: var(--ui-text); font-size: 12px; font-weight: 600; }
  /* The addresses and the configure line are there to be copied. */
  .source, .term, pre { user-select: text; -webkit-user-select: text; }
  pre { margin: 0; padding: 8px 10px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-muted); color: var(--ui-text-muted); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
