import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createGameHandler } from '../server/game-api.ts';
import { memoryRoomStore } from './memory-rooms.ts';

// Dev only (`pnpm table`): the real createGameHandler on an in-memory store, plus /__table/* routes.
type Hold = { ms: number; left: number; action?: string };
const LOG_DIR = '.local-table';
const LOG_FILE = LOG_DIR + '/requests.log';

const readBody = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
};
const json = (res: ServerResponse, data: unknown, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function localTable(): Plugin {
  return {
    name: 'pasur-local-table',
    apply: 'serve',
    configureServer(server) {
      const store = memoryRoomStore();
      const handler = createGameHandler(store);
      const log: string[] = [];
      const holds: Hold[] = [];
      mkdirSync(LOG_DIR, { recursive: true });

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
        try {
          if (url.pathname === '/api/game') {
            const started = performance.now();
            const method = req.method || 'GET';
            const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req);
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers))
              if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
            let action = 'poll';
            if (method !== 'GET') {
              action = 'unknown';
              try {
                const parsed = JSON.parse(body?.toString() || '');
                if (typeof parsed?.action === 'string') action = parsed.action;
              } catch {}
            }
            const response = await handler(new Request(url, { method, headers, body }));
            const out = Buffer.from(await response.arrayBuffer());
            const hold = holds.find((h) => !h.action || h.action === action);
            if (hold) {
              if (--hold.left <= 0) holds.splice(holds.indexOf(hold), 1);
              await sleep(hold.ms);
            }
            let code = url.searchParams.get('code');
            if (!code)
              try {
                code = JSON.parse(body?.toString() || '').code ?? null;
              } catch {}
            const text = JSON.stringify({
              t: Date.now(),
              method,
              action,
              code: code || undefined,
              status: response.status,
              ms: Math.round(performance.now() - started),
            });
            log.push(text);
            appendFileSync(LOG_FILE, text + '\n');
            const h: Record<string, string | string[]> = {};
            response.headers.forEach((v, k) => (h[k] = v));
            const cookies = response.headers.getSetCookie();
            if (cookies.length) h['set-cookie'] = cookies;
            res.writeHead(response.status, h);
            return res.end(out);
          }
          if (!url.pathname.startsWith('/__table/')) return next();

          const route = url.pathname.slice('/__table/'.length);
          if (req.method === 'GET' && route === 'log')
            return json(
              res,
              log.map((l) => JSON.parse(l)),
            );
          if (req.method === 'GET' && route === 'rooms')
            return json(
              res,
              [...store.rows.values()].map(({ game: g }) => ({
                code: g.code,
                phase: g.phase,
                round: g.round,
                revision: g.revision,
                seats: g.players.map((p) => ({ name: p.name, hasKey: !!p.key })),
              })),
            );
          if (req.method !== 'POST') return json(res, { error: 'Not found' }, 404);
          // A web page on another site must not drive these routes (a form POST is a "simple" request).
          const origin = req.headers.origin;
          if (origin !== undefined && origin !== 'http://' + req.headers.host)
            return json(res, { error: 'Foreign origin' }, 403);
          if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || ''))
            return json(res, { error: 'Content-Type must be application/json' }, 415);
          let b: Record<string, unknown> = {};
          try {
            b = JSON.parse((await readBody(req)).toString() || '{}');
          } catch {
            return json(res, { error: 'Invalid JSON' }, 400);
          }
          if (route === 'hold') {
            const ms = b.ms;
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > 120000)
              return json(res, { error: 'ms must be a number from 0 to 120000' }, 400);
            const left = b.count === undefined ? 1 : b.count;
            if (typeof left !== 'number' || !Number.isSafeInteger(left) || left < 1)
              return json(res, { error: 'count must be a positive integer' }, 400);
            holds.push({
              ms,
              left,
              action: typeof b.action === 'string' ? b.action : undefined,
            });
            return json(res, { ok: true, holds: holds.length });
          }
          if (route === 'unseat') {
            const row = store.rows.get(String(b.code));
            const seat = Number(b.seat);
            if (!row || !row.game.players[seat]) return json(res, { error: 'No such seat' }, 404);
            row.game.players[seat].key = randomUUID();
            return json(res, { ok: true });
          }
          if (route === 'delete')
            return store.delete(String(b.code))
              ? json(res, { ok: true })
              : json(res, { error: 'No such table' }, 404);
          return json(res, { error: 'Not found' }, 404);
        } catch (e) {
          return json(res, { error: String((e as Error).message || e) }, 500);
        }
      });

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 5174;
        console.log(
          `Local table: http://127.0.0.1:${port}  (dev routes: /__table/log, /__table/rooms, POST /__table/hold|unseat|delete)`,
        );
      });
    },
  };
}
