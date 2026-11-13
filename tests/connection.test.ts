import test from 'node:test';
import assert from 'node:assert/strict';
import { TIMING, pollDelay, shouldPause, createPoller } from '../lib/connection.ts';

const fast = { playingMs: 10, idleMs: 30, pauseAfterMs: 120, requestTimeoutMs: 50 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

test('poller follows the phase, pauses when idle, resumes on demand', async () => {
  let phase = 'playing';
  let polls = 0;
  let paused = 0;
  const p = createPoller({
    poll: async () => {
      polls++;
    },
    phase: () => phase,
    timing: fast,
    onPause: () => paused++,
  });
  p.start();
  await sleep(55);
  const playingPolls = polls;
  assert.ok(playingPolls >= 3, `expected several fast polls, got ${playingPolls}`);
  phase = 'lobby';
  await sleep(40); // let the next scheduled delay switch over
  const before = polls;
  await sleep(90);
  assert.ok(polls - before <= 4, `lobby polls should be slower, got ${polls - before}`);
  await sleep(150);
  assert.equal(paused, 1);
  assert.equal(p.isPaused(), true);
  const atPause = polls;
  await sleep(100);
  assert.equal(polls, atPause, 'no polls while paused');
  p.resume();
  await sleep(5);
  assert.ok(polls > atPause, 'resume polls immediately');
  assert.equal(p.isPaused(), false);
  p.stop();
});

test('a revision change resets the idle clock', async () => {
  let paused = 0;
  const p = createPoller({
    poll: async () => {},
    phase: () => 'playing',
    timing: fast,
    onPause: () => paused++,
  });
  p.start();
  for (let i = 0; i < 4; i++) {
    await sleep(60);
    p.noteChange();
  }
  assert.equal(paused, 0);
  p.stop();
});

test('never two polls in flight, hidden tabs skip, stop ends the schedule', async () => {
  let running = 0,
    max = 0,
    polls = 0,
    hidden = true;
  const p = createPoller({
    poll: async () => {
      running++;
      max = Math.max(max, running);
      polls++;
      await sleep(25);
      running--;
    },
    phase: () => 'playing',
    timing: fast,
    onPause: () => {},
    isHidden: () => hidden,
  });
  p.start();
  await sleep(50);
  assert.equal(polls, 0, 'hidden: no polls');
  hidden = false;
  p.kick();
  p.kick();
  await sleep(100);
  assert.ok(polls > 0);
  assert.equal(max, 1);
  p.stop();
  const n = polls;
  await sleep(60);
  assert.equal(polls, n);
});

test('a poll that asks to stop ends the schedule', async () => {
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
  await sleep(80);
  assert.equal(polls, 1);
  p.stop();
});

test('acceptReply: an older reply never replaces a newer table', async () => {
  const { acceptReply } = await import('../lib/connection.ts');
  const t = (code: string, revision: number) => ({ code, revision });
  let state: { code: string; revision: number } | null = null;
  const deliver = (incoming: { code: string; revision: number }, switchTable = false) => {
    if (acceptReply(state, incoming, { switchTable })) state = incoming;
  };
  deliver(t('AAAAAAAAAA', 5), true); // initial load
  deliver(t('AAAAAAAAAA', 7));
  deliver(t('AAAAAAAAAA', 6)); // late reply
  assert.equal(state!.revision, 7);
  deliver(t('AAAAAAAAAA', 7)); // same revision: nothing new
  assert.equal(state!.revision, 7);
  deliver(t('BBBBBBBBBB', 99)); // another table, not deliberate
  assert.deepEqual(state, t('AAAAAAAAAA', 7));
  deliver(t('BBBBBBBBBB', 1), true); // create / join / back-to-table
  assert.deepEqual(state, t('BBBBBBBBBB', 1));
  assert.equal(acceptReply(null, t('CCCCCCCCCC', 3), { switchTable: false }), true);
});
