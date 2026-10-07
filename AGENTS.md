# Agent Guidelines

## Package Manager

This project uses **pnpm** (not npm or yarn). Always use `pnpm` commands:

- `pnpm install` - Install dependencies
- `pnpm add <package>` - Add a dependency
- `pnpm dev` - Run development server
- `pnpm build` - Build for production

## Code Style

- Prefer `const` over `let` whenever the variable is not reassigned
- **No semicolons**
- **Never use `null`** — use `undefined` (exception: external library APIs)
- **Never use `any`** — use proper types, generics, `unknown`
- **Never use dynamic imports** — static imports at top of file only
- **No magic numbers** — use SCREAMING_SNAKE_CASE constants (0, 1, -1, 2 excepted)
- **Omit file extensions** in imports the frontend bundler resolves (`frontend/src`). Desktop source, workers and scripts run as Node ESM, where relative imports keep their `.js` extension
- **kebab-case** for all file and directory names

## Commits

- Conventional commits, lowercase, imperative: `fix: show share URL input on iOS Safari`.
- One commit per change — squash, don't stack fixups.
- Subject only. Add a body just when the _why_ isn't obvious from the diff, and keep
  it to a few wrapped lines.
- No `Co-Authored-By`, no `Generated with Claude Code`, no session links, no emoji.
- Keep PR titles and descriptions concise.
- Omit automated-testing details from PR descriptions — TDD process, test counts, or "checks pass" statements. CI runs the full suite on every PR, so these add nothing. Manual or visual checks CI cannot do (e.g. "verified in the browser against the Figma frames") are worth a sentence.
- Omit the issue number from branch names and titles
- When a PR resolves an issue, reference it with a closing keyword (e.g. `Closes #53`) so GitHub closes the issue automatically on merge.
- The repo deletes the head branch automatically when a PR is merged, so don't pass `--delete-branch` or delete branches by hand. Deleting a branch that another open PR is stacked on auto-closes that PR, so let the merge do it.
- Keep a **linear history**: rebase onto `main` to update a branch or resolve a conflict — never merge `main` into the branch. Rebasing a branch that is already pushed ends in `git push --force-with-lease`.

## Modules

- Use ESM `import`, not CommonJS `require` — in source, scripts, and ad-hoc
  verification snippets (e.g. `node --input-type=module -e "import { x } from './frontend/src/lib/api.svelte.ts'"`).

## Product Feel

The app is a video game, not a CRUD interface: performant, reactive, low latency. The user should feel in
control and feel good using it.

- **Playback comes first, above everything else.** Music never stops, skips or stutters because something
  else wants the resources: library indexing, UI animations, the visualizer, cover loading or any other
  work. When they compete, the other work slows down, drops frames or waits; the audio does not.
- Every input answers on the next frame. Show the response first, then let the data settle behind it.
- Never block the UI on the network or the scanner: show what is there, refine in the background (paging,
  cover warming, polling). Background work must not starve what is on screen.
- The user stays in control: no layout jumps, reshuffles, scroll or focus changes they did not ask for.
  A background refresh replaces content in place, it never resets the view.
- Anything ongoing shows its state (indexing, loading) at a lively rate, not a sluggish one.
- Hold 60 fps through transitions and scrolling; measure on a phone, not just the desktop.

## UI Regression Testing

- Use the agent-driven workflow in `frontend/tests/agent/README.md`. Follow
  `frontend/tests/agent/AUDIT-PROMPT.md` for a full visual audit and
  `frontend/UX-AUDIT.md` for the repeatable Mac-app checklist.
- Prefer Codex browser/computer controls or `agent-browser` for UI testing.
  Do not introduce another Playwright or Cypress application test framework unless
  requested. The existing Vitest browser provider uses Playwright for component tests.
- When UI testing is requested, start the isolated synthetic library with
  `pnpm --dir frontend audit:serve`, then run
  `pnpm --dir frontend audit:regressions` when `agent-browser` is available.
  Use its documented browser setup or `AGENT_BROWSER_EXECUTABLE_PATH`.
- Cover 1920×1080, 1440×900, 1024×768 and 390×844. Check card hover and keyboard
  focus, default play and track actions, searchable dropdowns, filters, both
  library views, Settings, Display menus, Simple/Advanced sliders and all
  component styles. Verify scrolling and background updates preserve tile
  order, scroll position and the queue.
- Save screenshots and pass/fail/blocked results in `.audit-results/`.
  Passing interaction assertions or capturing screenshots does not establish
  a visual pass: inspect the images and compare with approved references.
  Never approve changed references automatically to hide a regression.
- Use synthetic data for repeatable browser checks. Validate the actual
  repository-local Mac app separately, preserving accounts, permissions,
  preferences and playback. Report physical-touch, performance, live Spotify
  and audio-capture checks as untested unless actually exercised.
- For requested validation, also run `pnpm --dir frontend check`,
  `pnpm --dir desktop test` and `pnpm --dir desktop build:frontend` as applicable.
  Stop temporary servers, close audit-created browser sessions and reset
  viewport overrides afterward.

## Reliability and Review

- Give asynchronous work an owner: account, request generation, queue session or
  operation token as appropriate. A stale completion cannot publish data or clear
  another operation's status. A failed refresh retains the last successful view;
  refreshing the same query preserves loaded pages and surviving order.
- Keep catalog IDs, collection occurrence positions and live queue-entry IDs
  distinct. Queue edits preserve the current occurrence and shuffle history.
- Own and dispose listeners, timers, workers, servers and media resources. Retry
  cleans up the previous attempt before claiming ports or starting replacements.
  Startup shows a window before bounded migration; failure remains recoverable.
- Opening overlays requires explicit intent. Give focus a single owner, isolate
  covered content and restore the opener without scrolling. Nested native dialogs
  own focus while open; artwork views leave playback controls available.
- For a fix, choose the smallest behavioral regression that protects its error
  class. Include relevant failure, supersession or teardown cases; assert visible
  state/resource ownership rather than source text. Use typechecks for contracts,
  component tests for DOM behavior and native checks for OS/storage/audio behavior.
  If automation cannot establish the result, record the gap and a repeatable check.
- Use `.agents/skills/review-music/SKILL.md` for application reviews. Follow
  `docs/application-review.md` for the runbook and update `docs/regression-coverage.md`
  when coverage or a known gap changes. Keep incident-specific steps there instead
  of expanding these rules for every bug.
