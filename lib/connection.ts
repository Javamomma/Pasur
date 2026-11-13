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

/** What a request came to: the server answered (any status), or it did not (network error / timeout). */
export type Reply = { kind: 'reply'; ok: boolean; status: number; data: any } | { kind: 'failed' };

/** One request with a time limit. `data` is null when the body is not JSON. */
export async function request(
  fetchFn: Fetch,
  url: string,
  init: RequestInit,
  timing: Timing = TIMING,
): Promise<Reply> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timing.requestTimeoutMs);
  try {
    const r = await fetchFn(url, { ...init, signal: ctl.signal });
    const data = await r.json().catch(() => null);
    return { kind: 'reply', ok: r.ok, status: r.status, data };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
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
): Promise<
  { outcome: 'reply'; reply: Extract<Reply, { kind: 'reply' }> } | { outcome: 'uncertain' }
> {
  const reply = await request(fetchFn, post.url, post.init, timing);
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
export function classifyFailure(reply: Reply): {
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
