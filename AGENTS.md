# Pasur Family — notes for agents

Invitation-only Persian Pasur card game for 2 players or 2 teams of 2, on any phone browser.
A React/Vite single page talks to one Netlify Function (`/api/game`), which keeps each table
as one Netlify Blobs document. No accounts: a seat is an HttpOnly cookie.

## Stack

- React 19, Vite 8, Tailwind 4, shadcn/Radix UI (`components/ui/`), lucide icons.
- Server: `server/game-api.ts` (`createGameHandler`, all request rules) + `server/rooms.ts`
  (Netlify Blobs store, ETag-conditional writes). `netlify/functions/game.ts` wires them.
- Game rules: `lib/pasur.ts`, shared by server and page.
- **Package manager: pnpm 11.25.0, Node ≥ 22.13.** Use pnpm in this repo, not Bun or npm,
  even if a global instruction prefers Bun.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm test        # node --test on tests/*.test.ts (Node strips the types)
pnpm build       # tsc --noEmit && vite build
pnpm dev         # Vite on 0.0.0.0:5173 (UI only)
pnpm table       # local two-browser table on http://127.0.0.1:5174 (real handler, in-memory store)
pnpm e2e         # Playwright smoke test on its own server, port 5175 (not part of verify)
```

## Verify

```sh
pnpm verify
```

Run it before every commit you hand back.
The line `Pasur storage request failed. Error` in test output comes from an intentional
failure test; it is not a failure.

## Rules any change must keep

- The server owns the rules: shuffling, legal moves, turns and scores happen in
  `server/` + `lib/pasur.ts`, never only in the page.
- No hand leaves the server except to its owner (`view()` in `lib/pasur.ts`). Any new test
  that returns a view asserts that other hands, the deck and seat keys are absent.
- Every save is conditional on the stored version (revision check → 409, ETag mismatch → 409,
  missing ETag fails closed).
- Do not change the stored `Game` shape (`lib/pasur.ts` type `Game`) without adding a version
  field and a migration; tables already stored on Netlify must keep working.
- Keep the origin check, the 2 KB body cap and the cookie flags in `server/game-api.ts`.

## Conventions

- Tests: `node:test` + `node:assert/strict` in `tests/*.test.ts`. Files under test must be
  importable by Node directly: relative imports with the `.ts` extension, no `@/` alias, no JSX.
- Keep changes focused; no drive-by refactors.

## Do not touch

- `vendor/` and `components/ui/` (vendored / generated).
- `netlify.toml` apart from the build command.
- `pnpm-lock.yaml` except through pnpm.
- Never deploy, push, or run `netlify deploy`.

## Base branch

modernize/2026-11-12-unstick-table
