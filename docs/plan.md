# Plan — "the table doesn't get stuck" (2026-11-12)

Brief: `~/audits/reports/pasur/2026-11-12-devteam-task.md` (from audit `~/audits/reports/pasur/2026-11-12.md`).
Base branch: `modernize/2026-11-12-unstick-table`, started from `main` @ `6a12630`.

## Baseline (6a12630, Node 26.13, pnpm 11.25.0)

- `pnpm test` → 7 pass, 0 fail (the `Pasur storage request failed. Error` line is an intentional failure test).
- `pnpm build` → `tsc --noEmit` clean; vite build OK, JS 305.25 kB / 96.41 kB gzip, CSS 34.80 kB.
- No lint, no formatter, no CI, no browser tests.

## Shared contract (read-only for builders)

- **Stored data:** the `Game` type in `lib/pasur.ts` and what `server/rooms.ts` stores do not change in this pass.
- **API status meanings** (`server/game-api.ts`): 400 bad input or illegal move, 403 not seated / not allowed
  (also bad Origin), 404 table not found, 409 table changed (stale revision or storage version), 413 too large,
  503 storage failure. The page relies on these.
- **Dev-only code lives in `dev/`.** Nothing under `dev/` may be imported by `app/`, `lib/`, `server/`,
  `netlify/` or `main.tsx`. The in-memory store is `dev/memory-rooms.ts` (export `memoryRoomStore()`),
  used by tests and the local table.
- **Unit tests** are `tests/*.test.ts`, run by `node --experimental-strip-types --test`. Code they import must be
  plain TS with `.ts` relative imports (no `@/`, no JSX). Client logic that needs tests goes in `lib/*.ts`, not
  inside `app/page.tsx`.
- **Browser tests** live in `e2e/`, run with `pnpm e2e` (Playwright), never inside `pnpm verify` or the Netlify build.

## Tasks (in order; each is one builder, reviewed, verified, merged before the next)

All tasks touch overlapping files (`package.json`, `app/page.tsx`), so they run one after another.

### 1. `format` — formatting-only commit (refactor, no behaviour change)
- Prettier as a dev dependency, minimal `.prettierrc.json` + `.prettierignore` (`vendor/`, `components/ui/`,
  `dist/`, `pnpm-lock.yaml`), `format` / `format:check` scripts.
- Format `app/`, `lib/`, `server/`, `netlify/`, `tests/`, `main.tsx`, `vite.config.ts`. Nothing else changes.
- Done when: 7 tests pass unchanged, `tsc` clean, and the production JS bundle is byte-identical (or the
  difference is explained) before vs after.

### 2. `verify-gate` — deploy runs the tests (targeted change)
- `verify` script = `pnpm test && pnpm build`; `netlify.toml` build command = `pnpm verify`.
- `.github/workflows/verify.yml`: PRs + pushes, Node 22, pnpm 11.25.0, `pnpm install --frozen-lockfile && pnpm verify`.
- Done when: `pnpm verify` passes; a deliberately broken test makes it exit non-zero (then reverted).

### 3. `local-table` — two browsers on this Mac (new dev-only capability)
- Move the in-memory `RoomStore` from `tests/api.test.ts` to `dev/memory-rooms.ts`; tests import it.
- A Vite plugin (`dev/local-table.ts`, `apply: 'serve'`) serves the real `createGameHandler` at `/api/game`
  with the memory store, plus dev-only routes for evidence: request log, room peek, hold-a-reply delay,
  remove a seat key, delete a table. Started by `pnpm table` (localhost only).
- `pnpm e2e`: Playwright (`@playwright/test`), two browser contexts: create → join → deal → one play →
  reload → still seated with the same hand.
- README "Local development" explains `pnpm table` and `pnpm e2e` instead of "Netlify Dev multiplayer is not supported".
- Done when: `pnpm verify` + `pnpm e2e` pass; production `dist/` and a bundle of `netlify/functions/game.ts`
  contain no memory-store or dev-route code (grep shown).

### 4. `anyone-deals` — any seated player deals the next round / rematch (rule change)
- `server/game-api.ts`: lobby `start` stays host-only; `phase==='round'` any seated player may `start`;
  `phase==='finished'` any seated player may `rematch`.
- `app/page.tsx`: round-end and finished buttons enabled for everyone; no "Waiting for the host" between rounds.
- Tests first (must fail on the old rule): non-host deals round 2; non-host rematches; non-host still cannot make
  the first deal; two simultaneous "Next round" → one round starts, the other gets 409.

### 5. `back-to-table` — one tap back from the home screen (targeted change)
- Home screen shows a primary "Back to your table" when a table is known (in memory or
  `localStorage['pasur-last-table']`); it restores the table without a page reload.

### 6. `connection` — how the page talks to the server (four commits, in this order)
- a. Frugal polling: 1.5 s while playing, 5 s in lobby / round end / finished; pause after 10 min without a
  revision change with "Paused while nobody is playing. Tap to reconnect."; tap, visible again, or `online` resumes;
  still skip hidden tabs; timings are exported constants.
- b. One rule for accepting a reply: ignore a reply for another table or with a lower revision than on screen;
  deliberate switches (back-to-table, create, join) still work. Test: revision 7 then late revision 6 → stays 7.
- c. ~10 s time limit on POSTs and polls; release busy / in-flight; keep the last good table; show
  "Not sure that went through — checking the table…" and poll once; never re-send a move.
- d. Honest errors: poll 403 → "This browser is no longer seated at this table"; 404 → "This table no longer
  exists"; both stop polling and offer the home screen. Only network errors and 5xx → "Connection interrupted. Reconnecting…".

### 7. `docs` — AGENTS.md and README
- AGENTS.md: verify, `pnpm table`, `pnpm e2e`, invariants, what was considered and rejected.
- README: architecture and limitations brought up to date.

### After the last merge
- Adversarial pass by the reviewer (six roles in BUILD.md), fix what matters, verify again.
- Evidence the lead gathers itself: before/after screenshots (390×664 and desktop), polling counts, hung-request
  and lost-seat walkthroughs, guest "Next round" walkthrough.
- Build report: `~/audits/reports/pasur/2026-11-12-build-report.md`.

## Status (2026-11-12 23:00): done, not pushed

All tasks merged on the base branch (start 6a12630, end: see `git log`), each verified by the lead and approved by
the GPT reviewer: AGENTS.md, format, verify-gate, local-table, anyone-deals, back-to-table, connection (a–d plus two
robustness commits), docs, the adversarial-pass hardening (7 commits + an e2e timing fix) and a label/fallback polish.
- `pnpm verify`: 31 tests (was 7), tsc, build. `pnpm e2e`: 17 browser tests.
- Build report: `~/audits/reports/pasur/2026-11-12-build-report.md`. Evidence, builder briefs and the lead's scripts:
  `~/audits/reports/pasur/2026-11-12-evidence/`.
- Deferred (see the report): seat recovery (incl. a Join whose reply is lost), "checking your table" feedback on first
  load, Enter-to-submit, renaming "← Tables", fitting the hand on one phone screen, game-ending fixed-deck tests.
