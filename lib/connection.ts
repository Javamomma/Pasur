// How the page talks to the server: timing, polling schedule. Plain TypeScript (no React),
// so Node tests can import it directly.

export const TIMING = {
  playingMs: 1500,
  idleMs: 5000,
  pauseAfterMs: 600_000,
  requestTimeoutMs: 10_000,
};
export type Timing = typeof TIMING;

/** Poll fast while cards are being played; slowly in the lobby, between rounds and at the end. */
export const pollDelay = (phase: string, timing: Timing = TIMING) =>
  phase === 'playing' ? timing.playingMs : timing.idleMs;

/** True once the table has not changed for `pauseAfterMs`. */
export const shouldPause = (lastChangeAt: number, now: number, timing: Timing = TIMING) =>
  now - lastChangeAt >= timing.pauseAfterMs;

export type PollResult = 'stop' | void;

/**
 * A setTimeout chain (never two polls in flight). The delay follows the current phase.
 * After `pauseAfterMs` without noteChange() it stops and calls onPause(); resume() continues.
 */
export function createPoller(o: {
  poll: () => Promise<PollResult>;
  phase: () => string;
  timing?: Timing;
  onPause: () => void;
  /** The poller left the paused state on its own (a new revision arrived). */
  onResume?: () => void;
  isHidden?: () => boolean;
  now?: () => number;
}) {
  const timing = o.timing ?? TIMING;
  const now = o.now ?? Date.now;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let inFlight = false;
  let again = false;
  let paused = false;
  let stopped = true;
  let lastChange = now();

  const schedule = () => {
    clearTimeout(timer);
    if (stopped || paused) return;
    timer = setTimeout(tick, pollDelay(o.phase(), timing));
  };
  let chain: Promise<void> = Promise.resolve();
  const run = (): Promise<void> => {
    if (inFlight) {
      again = true;
      return chain; // resolves once the poll in flight (and the one queued behind it) is done
    }
    if (o.isHidden?.()) return Promise.resolve();
    inFlight = true;
    chain = go();
    return chain;
  };
  const go = async (): Promise<void> => {
    let result: PollResult;
    try {
      result = await o.poll();
    } catch {
      result = undefined;
    } finally {
      inFlight = false;
    }
    if (result === 'stop') stopped = true;
    if (again && !stopped) {
      again = false;
      if (!o.isHidden?.()) {
        inFlight = true;
        return go();
      }
    }
  };
  async function tick() {
    if (stopped) return;
    // Never decide to pause while a poll is in flight: whatever started it schedules the next
    // tick, and that tick decides once the reply (and any new revision) has been seen.
    if (inFlight) return;
    if (shouldPause(lastChange, now(), timing)) {
      paused = true;
      o.onPause();
      return;
    }
    await run();
    schedule();
  }
  return {
    start() {
      stopped = false;
      paused = false;
      running = true;
      lastChange = now();
      schedule();
    },
    stop() {
      stopped = true;
      running = false;
      clearTimeout(timer);
    },
    /** The table changed (new revision): restart the idle clock. */
    noteChange() {
      lastChange = now();
      // A new revision proves the table is alive: leave a pause that raced with the poll.
      if (paused && running && !stopped) {
        paused = false;
        o.onResume?.();
        schedule();
      }
    },
    /** The phase changed: restart the wait so a slow lobby delay does not outlast a fast playing one. */
    reschedule() {
      if (running && !paused && !stopped && !inFlight) schedule();
    },
    isPaused: () => paused,
    /** Leave the paused state: poll right away, reset the idle clock, keep the schedule going. */
    resume() {
      if (!running || !paused) return;
      paused = false;
      lastChange = now();
      void run().then(schedule);
    },
    /** Poll now (visible again, back online, a check after an unsure move) without changing the idle clock. */
    kick(): Promise<void> {
      if (!running || stopped) return Promise.resolve();
      if (paused) {
        this.resume();
        return chain;
      }
      clearTimeout(timer); // the timer scheduled earlier must not fire (and pause) during this poll
      return run().then(schedule);
    },
  };
}

type TableRef = { code: string; revision: number };

/**
 * The one rule for taking a server reply onto the screen. With no table yet, or a deliberate
 * switch (create, join, first load, back to your table), accept. Otherwise only a newer
 * revision of the same table.
 */
export function acceptReply(
  current: TableRef | null | undefined,
  incoming: TableRef,
  opts: { switchTable: boolean },
): boolean {
  if (!current || opts.switchTable) return true;
  return incoming.code === current.code && incoming.revision > current.revision;
}

export type Fetch = typeof fetch;

const isArr = (x: unknown) => Array.isArray(x);
const isNum = (x: unknown) => typeof x === 'number' && Number.isFinite(x);

/**
 * The one check for "this body is a table": the shape the page actually reads (see `view()` in
 * lib/pasur.ts). Anything else is not a table, however valid the JSON.
 */
export function isGameView(d: unknown): d is { code: string; revision: number } {
  const o = d as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false;
  return (
    typeof o.code === 'string' &&
    o.code.length === 10 &&
    isNum(o.revision) &&
    ['lobby', 'playing', 'round', 'finished'].includes(o.phase) &&
    isNum(o.seat) &&
    isArr(o.players) &&
    o.players.every(
      (p: any) =>
        // eslint-disable-line @typescript-eslint/no-explicit-any
        !!p && typeof p.name === 'string' && isArr(p.hand) && isNum(p.handCount),
    ) &&
    isArr(o.pool) &&
    isArr(o.scores) &&
    o.scores.length === 2 &&
    o.scores.every(isNum) &&
    !!o.rules &&
    typeof o.rules === 'object' &&
    isNum(o.rules.goal) &&
    isArr(o.captured) &&
    isArr(o.surs)
  );
}

/**
 * What a request came to: the server answered (any status), it did not (network error, timeout,
 * or an OK reply that is not a table), or the caller cancelled it.
 */
export type Reply =
  | { kind: 'reply'; ok: boolean; status: number; data: any }
  | { kind: 'failed' }
  | { kind: 'cancelled' };

/**
 * One request with a time limit and an optional cancel signal. `data` is null when the body is
 * not JSON. An OK reply whose body is not a table counts as failed. A cancelled request is
 * neither a failure nor uncertain.
 */
export async function request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  timing: Timing = TIMING,
  signal?: AbortSignal,
): Promise<Reply> {
  if (signal?.aborted) return { kind: 'cancelled' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timing.requestTimeoutMs);
  const onCancel = () => ctl.abort();
  signal?.addEventListener('abort', onCancel);
  try {
    const r = await fetchFn(url, { ...init, signal: ctl.signal });
    const data = await r.json().catch(() => null);
    if (signal?.aborted) return { kind: 'cancelled' };
    if (r.ok && !isGameView(data)) return { kind: 'failed' };
    return { kind: 'reply', ok: r.ok, status: r.status, data };
  } catch {
    return signal?.aborted ? { kind: 'cancelled' } : { kind: 'failed' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCancel);
  }
}

/**
 * Send a move exactly once. If it times out or the network fails we cannot know whether the
 * server stored it: say so (onUncertain), look at the table once (check), and never send again.
 */
export async function submitMove(
  fetchFn: Fetch,
  post: { url: string; init: RequestInit },
  timing: Timing,
  hooks: { onUncertain?: () => void; check: () => Promise<void> },
  signal?: AbortSignal,
): Promise<
  | { outcome: 'reply'; reply: Extract<Reply, { kind: 'reply' }> }
  | { outcome: 'uncertain' }
  | { outcome: 'cancelled' }
> {
  const reply = await request(fetchFn, post.url, post.init, timing, signal);
  if (reply.kind === 'cancelled') return { outcome: 'cancelled' };
  if (reply.kind === 'reply') return { outcome: 'reply', reply };
  hooks.onUncertain?.();
  await hooks.check();
  return { outcome: 'uncertain' };
}

/**
 * Turn a failed request into what to tell the player. 403 / 404 are final ("gone"); network
 * errors, timeouts, 5xx and bodies that are not JSON are temporary; any other 4xx shows the
 * server's own message. `stopPolling` is true for everything that retrying cannot fix.
 */
export function classifyFailure(reply: Exclude<Reply, { kind: 'cancelled' }>): {
  message: string;
  stopPolling: boolean;
  gone: boolean;
} {
  const interrupted = {
    message: 'Connection interrupted. Reconnecting…',
    stopPolling: false,
    gone: false,
  };
  if (reply.kind === 'failed') return interrupted;
  if (reply.status === 403)
    return {
      message: 'This browser is no longer seated at this table.',
      stopPolling: true,
      gone: true,
    };
  if (reply.status === 404)
    return { message: 'This table no longer exists.', stopPolling: true, gone: true };
  if (reply.status >= 500 || reply.data === null || typeof reply.data !== 'object')
    return interrupted;
  if (reply.status >= 400)
    return { message: reply.data.error || 'Please try again.', stopPolling: true, gone: false };
  return interrupted;
}
