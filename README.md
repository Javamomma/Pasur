# Pasur Family

A mobile-friendly Persian Pasur game for Android, iPhone and desktop browsers. Create a table, share the invitation, and play two-player games or four-player partnerships.

## Deploy on Netlify

1. In Netlify, choose **Add new project → Import an existing project → GitHub**.
2. Select **Javamomma/Pasur**, branch **main**.
3. The checked-in `netlify.toml` sets the build command (`pnpm build`), publish directory (`dist`) and Functions directory (`netlify/functions`). Node 22 and pnpm are configured.
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

Use the local URL printed by Vite to preview the interface. Run multiplayer acceptance tests on a Netlify deploy preview or production deployment. The current Netlify Blobs local emulator omits ETags on reads; this app deliberately rejects missing versions instead of risking overwritten turns, so Netlify Dev multiplayer is not supported by this version.

## Architecture

- React / Vite frontend with responsive touch controls.
- `/api/game` is rewritten to a Netlify Function.
- Server-owned shuffle, legal moves, hidden hands and scores.
- One durable Netlify Blobs document per table, with strong reads and ETag-conditional writes. Competing moves or joins return HTTP 409 instead of overwriting another update.
- HttpOnly, same-site browser cookies reclaim each player's seat. Keep the same browser; clearing cookies loses the seat.
- The storage adapter rejects unconfirmed writes. Storage failures return a retryable error instead of pretending a move succeeded.
- Production polling pauses in hidden tabs. Room data persists across deployments.

## Rules

Default rules follow [Pagat's Pasur reference](https://www.pagat.com/fishing/pasur.html): first to 62; numeral captures total 11; jacks collect numerals and jacks; queens and kings match their rank; last capture receives the remaining pool. Sur rules: five points each, opposing surs cancel, no surs in the final deal, no scoring or cancelling surs once a side has 50 points. Per shodam is supported.

Hosts may select a goal of 100, disable sur cancellation or remove the 50-point cutoff. Four-player partners occupy seats 1/3 and 2/4; players join in seat order.

## Verification and limitations

`pnpm test` exercises full rounds, capture rules, scoring, hidden hands, permissions, stale/concurrent writes and storage failures. `pnpm build` checks TypeScript and creates the frontend bundle. The function is separately bundled for Node as a deployment check.

A real two-device game is the final acceptance check after deploying. This is a first version: no accounts, push notifications, recovery after clearing cookies, or offline multiplayer. Existing games on the earlier ChatGPT-hosted version are not migrated to Netlify; start new tables at the Netlify address.
