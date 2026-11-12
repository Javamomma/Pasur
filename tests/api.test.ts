import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameHandler } from '../server/game-api.ts';
import { memoryRoomStore } from '../dev/memory-rooms.ts';
import { options, type Game, type GameView } from '../lib/pasur.ts';
function client(handler: ReturnType<typeof createGameHandler>) {
  let cookie = '';
  return {
    async send(body: Record<string, unknown>, origin = 'https://pasur.example') {
      const response = await handler(
        new Request('https://pasur.example/api/game', {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify(body),
        }),
      );
      if (response.headers.has('set-cookie')) {
        cookie = response.headers.get('set-cookie')!.split(';')[0];
        assert.match(response.headers.get('set-cookie')!, /HttpOnly/);
        assert.match(response.headers.get('set-cookie')!, /Secure/);
      }
      return {
        status: response.status,
        data: (await response.json()) as GameView & { error: string },
      };
    },
    async read(code: string) {
      const response = await handler(
        new Request('https://pasur.example/api/game?code=' + code, { headers: { Cookie: cookie } }),
      );
      return {
        status: response.status,
        data: (await response.json()) as GameView & { error: string },
      };
    },
  };
}
for (const capacity of [2, 4])
  test(`${capacity}-player API round, permissions, privacy and reconnect`, async () => {
    const handler = createGameHandler(memoryRoomStore());
    const clients = Array.from({ length: capacity }, () => client(handler));
    let r = await clients[0].send({ action: 'create', name: 'Host', capacity });
    assert.equal(r.status, 200);
    const code = r.data.code;
    assert.equal((await client(handler).read(code)).status, 403);
    for (let i = 1; i < capacity; i++) {
      r = await clients[i].send({ action: 'join', name: 'Player ' + i, code });
      assert.equal(r.status, 200);
    }
    assert.equal(
      (await clients[1].send({ action: 'start', code, revision: r.data.revision })).status,
      403,
    );
    r = await clients[0].send({ action: 'start', code, revision: r.data.revision });
    assert.equal(r.status, 200);
    const rejoin = await clients[1].send({ action: 'join', code, name: 'Changed' });
    assert.equal(rejoin.status, 200);
    assert.equal(rejoin.data.players[1].name, 'Player 1');
    let moves = 0;
    while (r.data.phase === 'playing') {
      const g = r.data;
      const actor = g.turn;
      const state = (await clients[actor].read(code)).data;
      for (let i = 0; i < capacity; i++) {
        if (i !== actor) assert.deepEqual(state.players[i].hand, []);
        assert.ok(!('key' in state.players[i]));
      }
      assert.ok(!('deck' in state));
      const card = state.players[actor].hand[0],
        take = options(card, state.pool)[0] || [];
      const forbidden = await clients[(actor + 1) % capacity].send({
        action: 'play',
        code,
        card,
        take,
        revision: state.revision,
      });
      assert.equal(forbidden.status, 400);
      const stale = await clients[actor].send({
        action: 'play',
        code,
        card,
        take,
        revision: state.revision - 1,
      });
      assert.equal(stale.status, 409);
      r = await clients[actor].send({ action: 'play', code, card, take, revision: state.revision });
      assert.equal(r.status, 200);
      moves++;
    }
    assert.equal(moves, 48);
    assert.equal(r.data.phase, 'round');
    assert.equal(
      r.data.breakdown.reduce((n, b) => n + b.total, 0),
      20 + r.data.surs.reduce((n, s) => n + 5 * s, 0),
    );
    const reconnect = await clients[0].read(code);
    assert.deepEqual(reconnect.data.scores, r.data.scores);
  });
test('Concurrent joins cannot occupy the same seat or overwrite each other', async () => {
  const store = memoryRoomStore();
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>((r) => {
    release = r;
  });
  const read = store.read;
  store.read = async (code) => {
    const snapshot = await read(code);
    reads++;
    if (reads === 2) release();
    if (reads <= 2) await barrier;
    return snapshot;
  };
  const handler = createGameHandler(store);
  const host = client(handler);
  const { data: g } = await host.send({ action: 'create', name: 'Host', capacity: 2 });
  const results = await Promise.all([
    client(handler).send({ action: 'join', name: 'A', code: g.code }),
    client(handler).send({ action: 'join', name: 'B', code: g.code }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 1);
  assert.equal((await host.read(g.code)).data.players.length, 2);
});
test('CSRF, invalid input, unsupported methods and storage errors fail safely', async () => {
  const h = createGameHandler(memoryRoomStore()),
    c = client(h);
  assert.equal(
    (await c.send({ action: 'create', name: 'Host' }, 'https://evil.example')).status,
    403,
  );
  assert.equal((await c.send({ action: 'create', name: '' })).status, 400);
  assert.equal(
    (await h(new Request('https://pasur.example/api/game', { method: 'DELETE' }))).status,
    405,
  );
  const malformed = await h(
    new Request('https://pasur.example/api/game', {
      method: 'POST',
      headers: { Origin: 'https://pasur.example' },
      body: 'null',
    }),
  );
  assert.equal(malformed.status, 400);
  const broken = createGameHandler({
    read: async () => {
      throw Error('secret details');
    },
    create: async () => {
      throw Error('secret details');
    },
    save: async () => {
      throw Error('secret details');
    },
  });
  const unavailable = await client(broken).send({ action: 'create', name: 'Host' });
  assert.equal(unavailable.status, 503);
  assert.ok(!unavailable.data.error.includes('secret'));
});

type TestClient = ReturnType<typeof client>;
async function twoPlayerTable() {
  const store = memoryRoomStore();
  const handler = createGameHandler(store);
  const host = client(handler),
    guest = client(handler);
  let r = await host.send({ action: 'create', name: 'Host', capacity: 2 });
  const code = r.data.code;
  r = await guest.send({ action: 'join', name: 'Guest', code });
  return { store, host, guest, code, seats: [host, guest], revision: r.data.revision };
}
async function playRound(seats: TestClient[], code: string) {
  let state = (await seats[0].read(code)).data;
  while (state.phase === 'playing') {
    const actor = state.turn;
    state = (await seats[actor].read(code)).data;
    const card = state.players[actor].hand[0];
    const take = options(card, state.pool)[0] || [];
    const r = await seats[actor].send({
      action: 'play',
      code,
      card,
      take,
      revision: state.revision,
    });
    assert.equal(r.status, 200);
    state = r.data;
  }
  return state;
}
function assertNoLeaks(view: GameView, seat: number) {
  view.players.forEach((p, i) => {
    if (i !== seat) assert.deepEqual(p.hand, []);
    assert.ok(!('key' in p));
  });
  assert.ok(!('deck' in view));
  assert.ok(!('key' in view));
}
async function tableAtRoundEnd() {
  const t = await twoPlayerTable();
  const dealt = await t.host.send({ action: 'start', code: t.code, revision: t.revision });
  assert.equal(dealt.status, 200);
  const ended = await playRound(t.seats, t.code);
  assert.equal(ended.phase, 'round');
  return { ...t, ended };
}

test('A non-host can deal the next round', async () => {
  const t = await tableAtRoundEnd();
  const r = await t.guest.send({ action: 'start', code: t.code, revision: t.ended.revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.round, 2);
  assert.equal(r.data.phase, 'playing');
  assert.match(r.data.message, /^Guest dealt round 2\. \S.* starts\.$/);
  assertNoLeaks(r.data, 1);
  assertNoLeaks((await t.host.read(t.code)).data, 0);
});

test('The host dealing a later round or a rematch is named too', async () => {
  const t = await tableAtRoundEnd();
  let state = (await t.host.send({ action: 'start', code: t.code, revision: t.ended.revision }))
    .data;
  assert.match(state.message, /^Host dealt round 2\. \S.* starts\.$/);
  for (let rounds = 2; ; rounds++) {
    assert.ok(rounds < 40, 'the game never finished');
    state = await playRound(t.seats, t.code);
    if (state.phase === 'finished') break;
    state = (await t.host.send({ action: 'start', code: t.code, revision: state.revision })).data;
  }
  const r = await t.host.send({ action: 'rematch', code: t.code, revision: state.revision });
  assert.equal(r.status, 200);
  assert.match(r.data.message, /^Host started a rematch\. \S.* starts\.$/);
});

test('A non-host can start a rematch, and only after the game has ended', async () => {
  const t = await tableAtRoundEnd();
  const early = await t.guest.send({ action: 'rematch', code: t.code, revision: t.ended.revision });
  assert.equal(early.status, 403);
  assert.equal(early.data.error, 'A rematch can start after the game ends.');
  let state = t.ended;
  for (let rounds = 1; state.phase !== 'finished'; rounds++) {
    assert.ok(rounds < 40, 'the game never finished');
    const next = await t.guest.send({ action: 'start', code: t.code, revision: state.revision });
    assert.equal(next.status, 200);
    state = await playRound(t.seats, t.code);
  }
  assert.equal(
    (await t.host.send({ action: 'start', code: t.code, revision: state.revision })).status,
    400,
  );
  const r = await t.guest.send({ action: 'rematch', code: t.code, revision: state.revision });
  assert.equal(r.status, 200);
  assert.equal(r.data.phase, 'playing');
  assert.match(r.data.message, /^Guest started a rematch\. \S.* starts\.$/);
  assert.deepEqual(r.data.scores, [0, 0]);
  assert.equal(r.data.round, 1);
  assertNoLeaks(r.data, 1);
});

test('The first deal from the lobby stays host-only; strangers still cannot deal', async () => {
  const t = await twoPlayerTable();
  const r = await t.guest.send({ action: 'start', code: t.code, revision: t.revision });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'Only the host can make the first deal.');
  assert.equal((await t.guest.read(t.code)).data.phase, 'lobby');
  const stranger = await client(createGameHandler(t.store)).send({
    action: 'start',
    code: t.code,
    revision: t.revision,
  });
  assert.equal(stranger.status, 403);
});

test('Two simultaneous "Next round" requests: one deals, the other gets 409', async () => {
  const t = await tableAtRoundEnd();
  // Hold both reads until both requests hold the same snapshot, so only the
  // conditional save (not the revision check) can stop the second one.
  let reads = 0;
  let release!: () => void;
  const barrier = new Promise<void>((res) => {
    release = res;
  });
  const read = t.store.read;
  t.store.read = async (code) => {
    const snapshot = await read(code);
    reads++;
    if (reads === 2) release();
    if (reads <= 2) await barrier;
    return snapshot;
  };
  const results = await Promise.all([
    t.host.send({ action: 'start', code: t.code, revision: t.ended.revision }),
    t.guest.send({ action: 'start', code: t.code, revision: t.ended.revision }),
  ]);
  assert.equal(reads, 2);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results.find((r) => r.status === 200)!;
  assertNoLeaks(winner.data, winner === results[0] ? 0 : 1);
  const after = (await t.host.read(t.code)).data;
  assert.equal(after.round, 2);
  assert.equal(after.phase, 'playing');
  assertNoLeaks(after, 0);
});
