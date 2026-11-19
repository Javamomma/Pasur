import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIMING,
  pollDelay,
  shouldPause,
  createPoller,
  acceptReply,
  submitMove,
  request,
  classifyFailure,
  isGameView,
} from '../lib/connection.ts';

// No wall-clock waits: timers and Date are mocked, promises are flushed explicitly.
const fast = { playingMs: 10, idleMs: 30, pauseAfterMs: 120, requestTimeoutMs: 50 };
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};
const clock = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  return {
    /** Advance `ms` in `step` slices, letting promise chains run between slices. */
    async advance(ms: number, step = 1) {
      for (let done = 0; done < ms; done += step) {
        t.mock.timers.tick(step);
        await settle();
      }
    },
  };
};

test('timing constants match the plan', () => {
  assert.deepEqual(TIMING, {
    playingMs: 1500,
    idleMs: 5000,
    pauseAfterMs: 600_000,
    requestTimeoutMs: 10_000,
  });
});

test('poll fast only while playing', () => {
  assert.equal(pollDelay('playing', TIMING), 1500);
  for (const p of ['lobby', 'round', 'finished']) assert.equal(pollDelay(p, TIMING), 5000);
});

test('pause only after the idle limit', () => {
  assert.equal(shouldPause(0, 599_999, TIMING), false);
  assert.equal(shouldPause(0, 600_000, TIMING), true);
});

test('poller delay follows the phase', async (t) => {
  const c = clock(t);
  let phase = 'playing';
  let polls = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
    },
    phase: () => phase,
    timing: fast,
    onPause: () => {},
  });
  p.start();
  await c.advance(9);
  assert.equal(polls, 0);
  await c.advance(1);
  assert.equal(polls, 1);
  phase = 'lobby';
  await c.advance(10); // the wait already scheduled was a playing one
  assert.equal(polls, 2);
  await c.advance(29);
  assert.equal(polls, 2);
  await c.advance(1);
  assert.equal(polls, 3);
  p.stop();
});

test('reschedule restarts the wait when the phase changes', async (t) => {
  const c = clock(t);
  let phase = 'lobby';
  let polls = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
    },
    phase: () => phase,
    timing: fast,
    onPause: () => {},
  });
  p.start();
  await c.advance(5);
  phase = 'playing';
  p.reschedule();
  await c.advance(10);
  assert.equal(polls, 1);
  p.stop();
});

test('pauses after the idle limit, polls nothing while paused, resumes on demand', async (t) => {
  const c = clock(t);
  let polls = 0;
  let paused = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
    },
    phase: () => 'playing',
    timing: fast,
    onPause: () => paused++,
  });
  p.start();
  await c.advance(115);
  assert.equal(paused, 0);
  await c.advance(15);
  assert.equal(paused, 1);
  assert.equal(p.isPaused(), true);
  const atPause = polls;
  await c.advance(1000, 10);
  assert.equal(polls, atPause);
  p.resume();
  await settle();
  assert.equal(polls, atPause + 1, 'resume polls immediately');
  assert.equal(p.isPaused(), false);
  await c.advance(10);
  assert.equal(polls, atPause + 2, 'the schedule continues');
  await c.advance(100); // idle clock was reset: not paused yet
  assert.equal(p.isPaused(), false);
  p.stop();
});

test('a revision change resets the idle clock', async (t) => {
  const c = clock(t);
  let paused = 0;
  const p = createPoller({
    poll: async () => {},
    phase: () => 'playing',
    timing: fast,
    onPause: () => paused++,
  });
  p.start();
  for (let i = 0; i < 6; i++) {
    await c.advance(100);
    p.noteChange();
  }
  assert.equal(paused, 0);
  p.stop();
});

test('never two polls in flight; hidden tabs skip; stop ends the schedule', async (t) => {
  const c = clock(t);
  let running = 0,
    max = 0,
    polls = 0,
    hidden = true;
  let release: () => void = () => {};
  const p = createPoller({
    poll: async () => {
      running++;
      max = Math.max(max, running);
      polls++;
      await new Promise<void>((r) => (release = r));
      running--;
    },
    phase: () => 'playing',
    timing: fast,
    onPause: () => {},
    isHidden: () => hidden,
  });
  p.start();
  await c.advance(50);
  assert.equal(polls, 0, 'hidden: no polls');
  hidden = false;
  void p.kick();
  void p.kick();
  void p.kick();
  await settle();
  assert.equal(polls, 1);
  assert.equal(max, 1);
  release();
  await settle();
  assert.equal(polls, 2, 'the queued kick runs once after the first poll');
  release();
  await settle();
  p.stop();
  const n = polls;
  await c.advance(100);
  assert.equal(polls, n);
});

test('a poll that asks to stop ends the schedule', async (t) => {
  const c = clock(t);
  let polls = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
      return 'stop';
    },
    phase: () => 'playing',
    timing: fast,
    onPause: () => {},
  });
  p.start();
  await c.advance(100);
  assert.equal(polls, 1);
  p.stop();
});

test('acceptReply: an older reply never replaces a newer table', () => {
  const t = (code: string, revision: number) => ({ code, revision });
  let state: { code: string; revision: number } | null = null;
  const deliver = (incoming: { code: string; revision: number }, switchTable = false) => {
    if (acceptReply(state, incoming, { switchTable })) state = incoming;
  };
  deliver(t('AAAAAAAAAA', 5), true);
  deliver(t('AAAAAAAAAA', 7));
  deliver(t('AAAAAAAAAA', 6));
  assert.equal(state!.revision, 7);
  deliver(t('AAAAAAAAAA', 7));
  assert.equal(state!.revision, 7);
  deliver(t('BBBBBBBBBB', 99));
  assert.deepEqual(state, t('AAAAAAAAAA', 7));
  deliver(t('BBBBBBBBBB', 1), true);
  assert.deepEqual(state, t('BBBBBBBBBB', 1));
  assert.equal(acceptReply(null, t('CCCCCCCCCC', 3), { switchTable: false }), true);
});

const hang = ((_: string, init?: RequestInit) =>
  new Promise<Response>((_res, rej) =>
    init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError'))),
  )) as unknown as typeof fetch;
const validView = (revision = 1) => ({
  code: 'AAAAAAAAAA',
  revision,
  phase: 'lobby',
  seat: 0,
  players: [{ name: 'A', hand: [], handCount: 0 }],
  pool: [],
  scores: [0, 0],
  rules: { goal: 62 },
  captured: [[], []],
  surs: [0, 0],
});
const game = (revision: number) =>
  new Response(JSON.stringify(validView(revision)), { status: 200 });

test('a move that times out is sent once, then checked once, never re-sent', async (t) => {
  const c = clock(t);
  const calls: string[] = [];
  const fakeFetch = ((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push(method);
    return method === 'POST' ? hang(url, init) : Promise.resolve(game(8));
  }) as unknown as typeof fetch;
  let uncertain = 0;
  let checked: unknown = null;
  const timing = { ...fast, requestTimeoutMs: 30 };
  const done = submitMove(
    fakeFetch,
    { url: '/api/game', init: { method: 'POST', body: '{}' } },
    timing,
    {
      onUncertain: () => uncertain++,
      check: async () => {
        checked = await request(fakeFetch, '/api/game?code=AAAAAAAAAA', {}, timing);
      },
    },
  );
  await settle();
  assert.deepEqual(calls, ['POST']);
  await c.advance(30);
  const out = await done;
  assert.equal(out.outcome, 'uncertain');
  assert.equal(uncertain, 1);
  assert.deepEqual(calls, ['POST', 'GET']);
  assert.equal((checked as { kind: string }).kind, 'reply');
});

test('a slow poll is abandoned after the limit and reported as failed', async (t) => {
  const c = clock(t);
  const r = request(hang, '/api/game?code=A', {}, { ...fast, requestTimeoutMs: 20 });
  await c.advance(20);
  assert.equal((await r).kind, 'failed');
});

test('a cancelled request is neither failed nor uncertain', async () => {
  const ctl = new AbortController();
  const r = request(hang, '/api/game?code=A', {}, TIMING, ctl.signal);
  ctl.abort();
  assert.equal((await r).kind, 'cancelled');
  assert.equal((await request(hang, '/x', {}, TIMING, ctl.signal)).kind, 'cancelled');
  let uncertain = 0;
  const ctl2 = new AbortController();
  const m = submitMove(
    hang,
    { url: '/api/game', init: { method: 'POST' } },
    TIMING,
    { onUncertain: () => uncertain++, check: async () => assert.fail('no check') },
    ctl2.signal,
  );
  ctl2.abort();
  assert.equal((await m).outcome, 'cancelled');
  assert.equal(uncertain, 0);
});

test('an OK reply that is not a table is a failure, and a POST of that kind is uncertain', async () => {
  const html = (async () =>
    new Response('<!doctype html>', { status: 200 })) as unknown as typeof fetch;
  assert.equal((await request(html, '/api/game?code=A', {})).kind, 'failed');
  let uncertain = 0;
  let checks = 0;
  const m = await submitMove(html, { url: '/api/game', init: { method: 'POST' } }, TIMING, {
    onUncertain: () => uncertain++,
    check: async () => {
      checks++;
    },
  });
  assert.equal(m.outcome, 'uncertain');
  assert.deepEqual([uncertain, checks], [1, 1]);
  const err = (async () =>
    new Response('{"error":"No"}', { status: 403 })) as unknown as typeof fetch;
  const r = await request(err, '/x', {});
  assert.equal(r.kind === 'reply' && r.status, 403);
});

test('isGameView accepts a real table and rejects anything the page could not render', () => {
  assert.equal(isGameView(validView()), true);
  const bad: unknown[] = [null, undefined, '', 'x', [], {}, { code: 'A', revision: 1 }];
  const { code: _c, ...noCode } = validView();
  bad.push(noCode, { ...validView(), code: 'SHORT' }, { ...validView(), revision: NaN });
  bad.push({ ...validView(), phase: 'weird' }, { ...validView(), seat: '0' });
  bad.push({ ...validView(), players: [{ name: 'A', hand: [] }] }, { ...validView(), players: {} });
  bad.push({ ...validView(), pool: null }, { ...validView(), scores: [0] });
  bad.push({ ...validView(), scores: [0, 'x'] }, { ...validView(), rules: {} });
  bad.push({ ...validView(), captured: null }, { ...validView(), surs: null });
  // The reviewer's blank-page body: valid JSON, 200, not a table.
  bad.push({ code: 'AAAAAAAAAA', revision: 1 });
  for (const b of bad) assert.equal(isGameView(b), false, JSON.stringify(b));
});

test('a 200 with valid but malformed JSON is a failure (poll) and uncertain (POST)', async () => {
  const odd = (async () =>
    new Response('{"code":"AAAAAAAAAA","revision":1}', { status: 200 })) as unknown as typeof fetch;
  assert.equal((await request(odd, '/api/game?code=AAAAAAAAAA', {})).kind, 'failed');
  let checks = 0;
  const m = await submitMove(odd, { url: '/api/game', init: { method: 'POST' } }, TIMING, {
    check: async () => {
      checks++;
    },
  });
  assert.equal(m.outcome, 'uncertain');
  assert.equal(checks, 1);
});

test('classifyFailure: honest messages, and which failures stop polling', () => {
  const reply = (status: number, data: unknown) => ({
    kind: 'reply' as const,
    ok: status < 400,
    status,
    data,
  });
  const interrupted = { message: 'Connection interrupted. Reconnecting…', stopPolling: false };
  assert.deepEqual(classifyFailure(reply(403, { error: 'Nope' })), {
    message: 'This browser is no longer seated at this table.',
    stopPolling: true,
    gone: true,
  });
  assert.deepEqual(classifyFailure(reply(404, { error: 'Nope' })), {
    message: 'This table no longer exists.',
    stopPolling: true,
    gone: true,
  });
  assert.deepEqual(classifyFailure(reply(409, { error: 'The table changed.' })), {
    message: 'The table changed.',
    stopPolling: true,
    gone: false,
  });
  assert.deepEqual(classifyFailure(reply(409, {})), {
    message: 'Please try again.',
    stopPolling: true,
    gone: false,
  });
  for (const r of [
    reply(500, { error: 'boom' }),
    reply(503, null),
    reply(200, null),
    { kind: 'failed' as const },
  ])
    assert.deepEqual(classifyFailure(r), { ...interrupted, gone: false });
});

test('kick near the idle deadline: the old timer cannot pause during the kicked poll, and its new revision keeps polling', async (t) => {
  const c = clock(t);
  let polls = 0;
  let paused = 0;
  let release!: () => void;
  let hold = false;
  let p!: ReturnType<typeof createPoller>;
  p = createPoller({
    poll: async () => {
      polls++;
      if (hold) await new Promise<void>((r) => (release = r));
    },
    phase: () => 'lobby', // 30 ms between polls
    timing: fast,
    onPause: () => paused++,
  });
  p.start();
  await c.advance(100); // polls at 30, 60, 90; next timer at 120 = the idle deadline
  hold = true;
  const before = polls;
  void p.kick();
  await settle();
  assert.equal(polls, before + 1, 'kicked poll is in flight');
  await c.advance(60); // the old timer would have fired at 120 and paused
  assert.equal(paused, 0, 'no pause while the kicked poll is in flight');
  hold = false;
  p.noteChange(); // the kicked reply brought a new revision
  release();
  await settle();
  await c.advance(100);
  assert.equal(paused, 0);
  assert.equal(p.isPaused(), false);
  assert.ok(polls > before + 2, 'polling continues');
  p.stop();
});

test('a new revision that arrives after the pause un-pauses and reschedules', async (t) => {
  const c = clock(t);
  let polls = 0;
  let paused = 0;
  let resumed = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
    },
    phase: () => 'playing',
    timing: fast,
    onPause: () => paused++,
    onResume: () => resumed++,
  });
  p.start();
  await c.advance(130);
  assert.equal(p.isPaused(), true);
  const atPause = polls;
  p.noteChange();
  assert.equal(p.isPaused(), false);
  assert.equal(resumed, 1);
  await c.advance(25);
  assert.ok(polls > atPause, 'polling is scheduled again');
  assert.equal(paused, 1);
  p.stop();
});
