# Pasur Family — notes for agents

Invitation-only Persian Pasur card game for 2 players or 2 teams of 2, on any phone browser.
A React/Vite single page talks to one Netlify Function (`/api/game`), which keeps each table
as one Netlify Blobs document. No accounts: a seat is an HttpOnly cookie.

## Stack

- React 19, Vite 8, Tailwind 4, shadcn/Radix UI (`components/ui/`), lucide icons.
- Server: `server/game-api.ts` (`createGameHandler`, all request rules) + `server/rooms.ts`
  (Netlify Blobs store, ETag-conditional writes). `netlify/functions/game.ts` wires them.
- Game rules: `lib/pasur.ts`, shared by server and page.
- Page-to-server logic that needs tests: `lib/connection.ts` (plain TS, no React). `app/page.tsx` wires it in.
- Dev only: `dev/` (in-memory table store, local table server). Tests: `tests/` (node:test), `e2e/` (Playwright).
- **Package manager: pnpm 11.25.0, Node ≥ 22.13.** Use pnpm in this repo, not Bun or npm,
  even if a global instruction prefers Bun.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test           # node --test on tests/*.test.ts (Node strips the types)
pnpm build          # tsc --noEmit && vite build
pnpm verify         # pnpm test && pnpm build; also the Netlify build command
pnpm dev            # Vite on 0.0.0.0:5173 (UI only, no API)
pnpm table          # local table on http://127.0.0.1:5174: real handler, in-memory store, dev routes under /__table/
pnpm e2e            # Playwright on its own table server, port 5175; not part of verify
pnpm format         # Prettier write (app lib server netlify tests main.tsx vite.config.ts)
pnpm format:check   # Prettier check
```

`pnpm e2e` needs the Playwright browser once per machine: `pnpm exec playwright install chromium`.

## Verify

```sh
pnpm verify
```

Run it before every commit you hand back. It does not bundle the Netlify Function (Netlify does that during deploy, and a
bundling error would only show there); to check it locally run
`pnpm exec vite build --ssr netlify/functions/game.ts --outDir <tmp>` with `<tmp>` a throwaway directory.
Run `pnpm e2e` too when you change `app/page.tsx`,
`lib/connection.ts`, `server/game-api.ts` or `dev/`.
The line `Pasur storage request failed. Error` in test output comes from an intentional
failure test; it is not a failure.

## Invariants (any change must keep these)

- The server owns the rules: shuffling, legal moves, turns and scores happen in
  `server/` + `lib/pasur.ts`, never only in the page.
- No hand leaves the server except to its owner (`view()` in `lib/pasur.ts`). Any new test
  that returns a view asserts that other hands, the deck and seat keys are absent.
- Every save is conditional on the stored version (revision check → 409, ETag mismatch → 409,
  missing ETag fails closed).
- Do not change the stored `Game` shape (`lib/pasur.ts` type `Game`) without adding a version
  field and a migration; tables already stored on Netlify must keep working.
- Nothing under `dev/` is imported by `app/`, `lib/`, `server/`, `netlify/` or `main.tsx`.
- The page accepts a server reply only for the table the player is on (the navigation
  generation in `app/page.tsx`) and only if its revision is newer (`acceptReply` in `lib/connection.ts`).
- The page never re-sends a move automatically. After a timeout it looks at the table once.
- Keep the origin check, the 2 KB body cap and the cookie flags in `server/game-api.ts`.
- `main.tsx` wraps the page in an error boundary (`app/error-boundary.tsx`): a render error shows "Something went wrong on this page." and a Reload button.
- Once a poll reports a lost seat or table, the stale table is locked: its controls are disabled and dimmed, and the turn label never says "Your turn".
- Dev routes `POST /__table/*` (`dev/local-table.ts`) need `Content-Type: application/json` and refuse a foreign `Origin` (403); calls with no Origin (curl, Node, Playwright) work.

## How the page talks to the server

- Constants: `TIMING` in `lib/connection.ts`.
  - Poll every 1.5 s while the phase is `playing`; every 5 s in `lobby`, `round` (between rounds) and `finished`.
  - Polls pause when the table's revision has not changed for 10 minutes. Shown as "Paused while nobody is
    playing. Tap to reconnect." A tap anywhere, the tab becoming visible, or the browser coming back online resumes.
  - Hidden tabs do not poll. One poll at a time (a `setTimeout` chain).
  - Every request (move or poll) has a 10 s limit.
- A reply is used only if `acceptReply` allows it. A deliberate switch (create, join, first load, Back to your table)
  is allowed to change table; a poll or move reply must be the same table with a higher revision.
  An OK reply whose body is not a table (`isGameView`) counts as a failed request.
- Polls and GETs (`classifyFailure`):
  - 403 → "This browser is no longer seated at this table." Stops polling, offers the home screen, forgets the saved table.
  - 404 → "This table no longer exists." Same.
  - Network error, timeout, 5xx, or a non-JSON body → "Connection interrupted. Reconnecting…" and polling continues.
  - Any other 4xx → the server's own message, and polling stops.
- Submissions (create, join, deal, play, claim, rematch; `send` in `app/page.tsx`), which do not use `classifyFailure`:
  - Any error status (400, 403, 404, 409, 5xx…) shows the server's own message, or "Please try again." when the body has none;
    nothing is forgotten and nothing stops. The next poll then reports a lost seat or table.
  - A timeout, a network error, or an OK reply whose body is not a table: "Not sure that went through — checking the table…",
    one GET, no re-send (with no table yet, as after a Create: "Not sure that went through. Check your connection and try again.").
- A 409 on a deal or rematch (someone else dealt first) is not shown as an error: the page loads the table as it is now.

## Decisions you might want to revisit

These were the director's defaults, not Arshia's choices. Change them if Arshia says so.

- Poll 1.5 s during a round, 5 s elsewhere, pause after 10 idle minutes.
- The first deal stays with the host. Any seated player deals later rounds and starts rematches.

## Considered and rejected — do not redo this analysis

- Take-back of a seat by tapping a name: lets a player see an opponent's cards, and names can repeat.
- Accounts or sign-in: approved seat recovery solves the real problem without passwords.
- AI-model opponent or coach: costs money per use, needs a key and prompt upkeep.
- Computer taking over an absent player's seat: needs server-run turns and a safe hand-back. Not before practice mode shows anyone wants it.
- Faster polling while waiting: works against the cost fix. 1.5 s during a round stays.
- Push notifications: iPhone needs a Home Screen install, a secret key and a background worker. The family chat already pings people.
- Long polling: keeps a paid function running the whole time.
- New host, framework or backend rewrite: the storage and request design already supports every planned move.
- Scheduled deletion of old tables: each table is a few KB. Revisit only if the site turns out to be public and abused (then Netlify rate-limit rules first).
- Hiding "table not found" vs "table full": codes are 10 characters from 32 symbols (about 50 bits), so the difference helps nobody guess one.
- Removing `--host 0.0.0.0` from `pnpm dev`: it is how the dev site opens on a phone at home, and it runs only while you run it.
- Spectators, tournaments, three-player rules, in-app voice or chat, app-store apps, play-by-day mode: they remove no step for the family.

## Next up (not built yet)

- Seat recovery on a new device or after clearing cookies, approved by another seated player. Never take-back by name.
- Fit the hand and the Play button on one phone screen.
- Tests that play a game to its end from a fixed deck.
- Content-Security-Policy header, link-preview tags, PNG icons.
- A practice computer player, only if the family says they want one.

## Conventions

- Tests: `node:test` + `node:assert/strict` in `tests/*.test.ts`. Files under test must be
  importable by Node directly: relative imports with the `.ts` extension, no `@/` alias, no JSX.
- Browser tests go in `e2e/`, never inside `pnpm verify`.
- Keep changes focused; no drive-by refactors.

## Do not touch

- `vendor/` and `components/ui/` (vendored / generated).
- `netlify.toml` apart from the build command.
- `pnpm-lock.yaml` except through pnpm.
- Never deploy, push, or run `netlify deploy`.

## Base branch

modernize/2026-11-12-unstick-table
