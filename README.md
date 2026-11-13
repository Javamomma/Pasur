# Pasur Family

A mobile-friendly Persian Pasur game for Android, iPhone and desktop browsers. Create a table, share the invitation, and play two-player games or four-player partnerships.

## Deploy on Netlify

1. In Netlify, choose **Add new project → Import an existing project → GitHub**.
2. Select **Javamomma/Pasur**, branch **main**.
3. The checked-in `netlify.toml` sets the build command (`pnpm verify`: the tests, then the build, so a failing test stops the deploy), publish directory (`dist`) and Functions directory (`netlify/functions`). Node 22 and pnpm are configured.
4. Deploy. Netlify Functions automatically supplies access to Netlify Blobs; no database password or browser-visible API key is needed.
5. Open the production URL on two different phones, create a table on one, and send its invitation to the other. The host can deal when all seats are filled.

The application is accessible at its Netlify URL. Individual game tables require an unguessable invitation code; opponents' hands and seat credentials are never returned. The source repository is separate from live game data.

## Local development

Use Node 22.13 or newer and pnpm 11.25.0.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
pnpm build
pnpm dev
```

Use the local URL printed by Vite to preview the interface (no multiplayer: `pnpm dev` has no API).

### Play a table locally

```sh
pnpm table
```

This serves the page at http://127.0.0.1:5174 (this machine only) together with the real `createGameHandler` on an in-memory store, so you can play a full two-player table without deploying. Open the URL in two different browsers, or one normal and one private window: each needs its own cookies, because a seat is a cookie.

Dev-only routes on the same server (JSON):

- `GET /__table/log`: one entry per `/api/game` request (`t, method, action, code, status, ms`); also appended to `.local-table/requests.log`.
- `GET /__table/rooms`: each table's code, phase, round, revision and seats.
- `POST /__table/hold {"ms": 8000, "count": 1, "action": "play"}`: hold the next replies for `ms` after the move is stored.
- `POST /__table/unseat {"code": "…", "seat": 1}`: give that seat a new key (the browser loses its seat).
- `POST /__table/delete {"code": "…"}`: remove the table.

`pnpm e2e` runs the Playwright smoke test (two browser contexts: create, join, deal, play, reload). On a fresh machine run `pnpm exec playwright install chromium` once first. It starts its own table server on port 5175 (never reusing one on 5174), so it always tests this checkout.

The memory table forgets everything when the server stops. It is dev-only code in `dev/` and is never part of the production build or the Netlify Function.

## Architecture

- React / Vite frontend with responsive touch controls.
- `/api/game` is rewritten to a Netlify Function.
- Server-owned shuffle, legal moves, hidden hands and scores.
- One durable Netlify Blobs document per table, with strong reads and ETag-conditional writes. Competing moves or joins return HTTP 409 instead of overwriting another update.
- HttpOnly, same-site browser cookies reclaim each player's seat. Keep the same browser; clearing cookies loses the seat.
- The storage adapter rejects unconfirmed writes. Storage failures return a retryable error instead of pretending a move succeeded.
- Room data persists across deployments.
- Local table (dev only): `pnpm table` runs the same request handler on an in-memory store, with extra `/__table/` routes for tests. It lives in `dev/` and is not in the production build.

Who deals: the host makes the first deal. After that, any seated player may deal the next round and start a rematch. If two players tap at once, one deal happens and the other player sees the new table without an error.

How the page keeps up with the table (constants in `lib/connection.ts`):

- It polls every 1.5 s while cards are being played and every 5 s in the lobby, between rounds and after the game. Hidden tabs do not poll.
- After 10 minutes without a change it pauses and says "Paused while nobody is playing. Tap to reconnect." A tap, the tab becoming visible again, or the browser coming back online resumes it.
- Every request has a 10 second limit. A move that times out is never sent again automatically: the page says "Not sure that went through — checking the table…" and looks at the table once.
- The page takes a reply only for the table the player is on, and only if its revision is newer than what is on screen, so a slow older reply cannot replace a newer table. Choosing a table (create, join, Back to your table) is the only way to switch.
- If the server says the seat is gone (403) the page says "This browser is no longer seated at this table." If the table is gone (404) it says "This table no longer exists." Both stop polling and offer the home screen. Network errors, timeouts and server errors say "Connection interrupted. Reconnecting…" and keep trying.
- The home screen offers "Back to your table" for the last table played on this browser.

## Rules

Default rules follow [Pagat's Pasur reference](https://www.pagat.com/fishing/pasur.html): first to 62; numeral captures total 11; jacks collect numerals and jacks; queens and kings match their rank; last capture receives the remaining pool. Sur rules: five points each, opposing surs cancel, no surs in the final deal, no scoring or cancelling surs once a side has 50 points. Per shodam is supported.

Hosts may select a goal of 100, disable sur cancellation or remove the 50-point cutoff. Four-player partners occupy seats 1/3 and 2/4; players join in seat order.

## Verification and limitations

`pnpm verify` runs `pnpm test` and then `pnpm build`; the deploy runs it too. The tests exercise full rounds, capture rules, scoring, hidden hands, permissions, who may deal, stale/concurrent writes, storage failures and the page's reply, timeout and polling rules. The build checks TypeScript and creates the frontend bundle. The function is separately bundled for Node as a deployment check.

`pnpm e2e` plays real tables in two browser contexts on the local table (create, join, deal, play, reload, next round, Back to your table, slow and lost replies). It is not part of `pnpm verify`.

A real two-phone game after each deploy is still the final check.

What is missing:

- A Join whose reply is lost on the way leaves that seat taken by a cookie that never arrived. Seat recovery is the next step.
- No seat recovery after clearing cookies or on a new device yet.
- The host makes the first deal.
- No accounts, push notifications or offline multiplayer.
- Existing games on the earlier ChatGPT-hosted version are not migrated to Netlify; start new tables at the Netlify address.
