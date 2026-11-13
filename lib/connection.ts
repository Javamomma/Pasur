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
  const run = async () => {
    if (inFlight) {
      again = true;
      return;
    }
    if (o.isHidden?.()) return;
    inFlight = true;
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
      return run();
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
    isPaused: () => paused,
    /** Leave the paused state: poll right away, reset the idle clock, keep the schedule going. */
    resume() {
      if (!running || !paused) return;
      paused = false;
      lastChange = now();
      void run().then(schedule);
    },
    /** Poll now (visible again, back online, a check after an unsure move) without changing the idle clock. */
    kick() {
      if (!running || stopped) return;
      if (paused) return this.resume();
      void run().then(schedule);
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
