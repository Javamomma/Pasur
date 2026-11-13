'use client';
import { useState, useEffect, useRef } from 'react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  acceptReply,
  classifyFailure,
  createPoller,
  request,
  submitMove,
  TIMING,
} from '@/lib/connection';
import { label, rank, options, team, count, suitSymbols, type GameView } from '@/lib/pasur';
import {
  Share2,
  ArrowLeft,
  BookOpen,
  Users,
  LockKeyhole,
  Copy,
  Check,
  Club,
  ChevronRight,
} from 'lucide-react';
function PlayingCard({
  card,
  selected,
  onClick,
  disabled = false,
}: {
  card: string;
  selected?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  const r = rank(card),
    text = label(card).slice(0, -1);
  return (
    <button
      type="button"
      className={`playing-card ${'DH'.includes(card[0]) ? 'red' : ''} ${selected ? 'selected' : ''}`}
      aria-label={label(card)}
      aria-pressed={!!selected}
      disabled={disabled || !onClick}
      onClick={onClick}
    >
      <span className="corner">
        {text}
        <small>{suitSymbols[card[0]]}</small>
      </span>
      <span className="pip">{r > 10 ? text : suitSymbols[card[0]]}</span>
      <span className="bottom-corner">
        {text}
        {suitSymbols[card[0]]}
      </span>
    </button>
  );
}
const UNSURE = 'Not sure that went through — checking the table…';
const UNSURE_NO_TABLE = 'Not sure that went through. Check your connection and try again.';
class UncertainMove extends Error {}
class CancelledMove extends Error {}
export default function Home() {
  const [name, setName] = useState(''),
    [code, setCode] = useState(''),
    [capacity, setCapacity] = useState('2'),
    [goal, setGoal] = useState('62'),
    [unlimited, setUnlimited] = useState(false),
    [cancelSurs, setCancelSurs] = useState(true),
    [screen, setScreen] = useState<'home' | 'join' | 'table'>('home'),
    [game, setGame] = useState<GameView | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [card, setCard] = useState(''),
    [take, setTake] = useState<string[]>([]),
    [copied, setCopied] = useState(false),
    [lastCode, setLastCode] = useState(''),
    [restoring, setRestoring] = useState(false),
    [paused, setPaused] = useState(false),
    [lost, setLost] = useState<{ message: string; gone: boolean } | null>(null);
  const pollerRef = useRef<ReturnType<typeof createPoller> | null>(null);
  const current = useRef<GameView | null>(null);
  current.current = game;
  const navGen = useRef(0);
  // Every navigation (restore, create, join, home, join screen) takes a new generation;
  // an async result may be applied only while its generation is still the latest.
  const subId = useRef(0); // only the latest submission may touch busy / notice / error
  const subCtl = useRef<AbortController | null>(null);
  const beginNav = () => {
    subCtl.current?.abort(); // leaving: outstanding submissions and their checks stop
    setRestoring(false);
    return ++navGen.current;
  };
  const isLatest = (gen: number) => gen === navGen.current;
  // `switchTable` is true only for a deliberate navigation whose generation is still the latest.
  function accept(g: GameView, switchTable = false) {
    const ok = acceptReply(current.current, g, { switchTable });
    setGame((old) => (acceptReply(old, g, { switchTable }) ? g : old));
    if (!ok) return false;
    setCode(g.code);
    setScreen('table');
    localStorage.setItem('pasur-last-table', g.code);
    setLastCode(g.code);
    history.replaceState(null, '', '?table=' + g.code);
    return true;
  }
  // The server says this table is gone for this browser: don't offer it again.
  function forgetTable(c: string) {
    if (localStorage.getItem('pasur-last-table') === c) localStorage.removeItem('pasur-last-table');
    setLastCode((l) => (l === c ? '' : l));
  }
  const getTable = (c: string, signal?: AbortSignal) =>
    request(
      fetch,
      '/api/game?code=' + encodeURIComponent(c),
      { cache: 'no-store' },
      TIMING,
      signal,
    );
  async function send(action: string, extra: Record<string, unknown> = {}) {
    const deliberate = action === 'create' || action === 'join';
    const gen = deliberate ? beginNav() : navGen.current;
    const id = ++subId.current;
    const mine = () => subId.current === id;
    subCtl.current?.abort();
    const ctl = (subCtl.current = new AbortController());
    // The table this move is FOR (a create has none yet, so it cannot be checked).
    const sentCode = action === 'create' ? '' : current.current?.code || code;
    const onTable = !!current.current;
    setBusy(true);
    setError('');
    try {
      const out = await submitMove(
        fetch,
        {
          url: '/api/game',
          init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action,
              code: sentCode,
              name,
              capacity: Number(capacity),
              goal: Number(goal),
              surLimit: unlimited ? 999 : 50,
              cancelSurs,
              revision: current.current?.revision,
              ...extra,
            }),
          },
        },
        TIMING,
        {
          // The move may or may not have reached the server. Never re-send it: look once,
          // at the table it was for.
          onUncertain: () => {
            if (!mine()) return;
            setBusy(false);
            if (!sentCode) setError(UNSURE_NO_TABLE);
            else if (onTable) setNotice(UNSURE);
            else setError(UNSURE);
          },
          check: async () => {
            if (!sentCode) return;
            // Keep the notice readable for a moment even when the check is instant.
            const [r] = await Promise.all([
              getTable(sentCode, ctl.signal),
              new Promise((res) => setTimeout(res, 2000)),
            ]);
            if (r.kind === 'cancelled') return;
            // A 200 for a timed-out join means the join landed: show it (a deliberate switch).
            const landed = r.kind === 'reply' && r.ok && isLatest(gen);
            if (landed) accept(r.data as GameView, action === 'join');
            if (!mine()) return;
            setNotice((n) => (n === UNSURE ? '' : n));
            setError((e) => (e !== UNSURE ? e : landed ? '' : UNSURE_NO_TABLE));
          },
        },
        ctl.signal,
      );
      if (out.outcome === 'cancelled') throw new CancelledMove();
      if (out.outcome === 'uncertain') throw new UncertainMove();
      const { ok, status, data } = out.reply;
      if (status === 409 && (action === 'start' || action === 'rematch') && current.current) {
        // Someone else already dealt: show the table as it is now, no error banner.
        const fresh = await getTable(current.current.code, ctl.signal);
        if (fresh.kind === 'reply' && fresh.ok) {
          if (isLatest(gen)) accept(fresh.data as GameView);
          return fresh.data as GameView;
        }
      }
      if (!ok) throw Error(data?.error || 'Please try again.');
      if (!isLatest(gen)) return data as GameView;
      accept(data, deliberate);
      setCard('');
      setTake([]);
      localStorage.setItem('pasur-name', name);
      return data as GameView;
    } catch (e) {
      if (!(e instanceof UncertainMove) && !(e instanceof CancelledMove) && mine())
        setError((e as Error).message);
      throw e;
    } finally {
      if (mine()) setBusy(false);
    }
  }
  const act = (a: string, x: Record<string, unknown> = {}) => {
    void send(a, x).catch(() => {});
  };
  useEffect(() => {
    setName(localStorage.getItem('pasur-name') || '');
    setLastCode(localStorage.getItem('pasur-last-table') || '');
    const c =
      new URLSearchParams(location.search).get('table') || localStorage.getItem('pasur-last-table');
    if (c) {
      setCode(c);
      setScreen('join');
      const gen = beginNav();
      void getTable(c).then((r) => {
        if (r.kind === 'reply' && r.ok && isLatest(gen)) accept(r.data as GameView, true);
      });
    }
  }, []);
  useEffect(() => {
    if (screen !== 'table' || !game) return;
    let stopped = false;
    const ctl = new AbortController();
    const poller = createPoller({
      phase: () => current.current?.phase ?? 'lobby',
      isHidden: () => document.hidden,
      onPause: () => !stopped && setPaused(true),
      poll: async () => {
        const r = await getTable(game.code, ctl.signal);
        if (stopped || r.kind === 'cancelled') return;
        if (r.kind === 'reply' && r.ok) {
          setNotice((n) => (n === UNSURE ? n : ''));
          setGame((old) => (acceptReply(old, r.data, { switchTable: false }) ? r.data : old));
        } else {
          const f = classifyFailure(r);
          if (!f.stopPolling) return setNotice(f.message);
          setNotice('');
          setLost({ message: f.message, gone: f.gone });
          if (f.gone) forgetTable(game.code);
          return 'stop';
        }
      },
    });
    pollerRef.current = poller;
    const wake = () => {
      setPaused(false);
      poller.kick();
    };
    const onVisible = () => !document.hidden && wake();
    // A tap resumes only a paused table; during play it must not trigger polls.
    const onTap = () => poller.isPaused() && wake();
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('click', onTap, true);
    poller.start();
    return () => {
      stopped = true;
      ctl.abort();
      poller.stop();
      pollerRef.current = null;
      setPaused(false);
      setLost(null);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('click', onTap, true);
    };
  }, [screen, game?.code]);
  useEffect(() => () => subCtl.current?.abort(), []);
  useEffect(() => {
    pollerRef.current?.noteChange();
  }, [game?.revision]);
  useEffect(() => {
    pollerRef.current?.reschedule();
  }, [game?.phase]);
  useEffect(() => {
    setCard('');
    setTake([]);
  }, [game?.revision]);
  useEffect(() => {
    const ctx = (
      document as unknown as {
        modelContext?: { registerTool: (tool: unknown, options: unknown) => Promise<void> };
      }
    ).modelContext;
    if (!ctx) return;
    const ctl = new AbortController();
    Promise.resolve(
      ctx.registerTool(
        {
          name: 'read_pasur_table',
          title: 'Read your Pasur table',
          description: 'Read the current table, your hand and scores. Opponent hands are hidden.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          annotations: { readOnlyHint: true, untrustedContentHint: true },
          execute: () => {
            const g = current.current;
            if (!g) throw Error('Join a table first.');
            return {
              code: g.code,
              phase: g.phase,
              seat: g.seat,
              turn: g.turn,
              pool: g.pool,
              hand: g.players[g.seat].hand,
              scores: g.scores,
            };
          },
        },
        { signal: ctl.signal },
      ),
    ).catch(() => {});
    return () => ctl.abort();
  }, []);
  async function share() {
    if (!game) return;
    const url = location.origin + '/?table=' + game.code;
    try {
      if (navigator.share) {
        await navigator.share({
          title: 'Join my Pasur table',
          text: 'Join my family Pasur table.',
          url,
        });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2200);
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError('Copy this invitation: ' + url);
    }
  }
  const myTurn = !!game && game.phase === 'playing' && game.turn === game.seat;
  const legal = card && game ? options(card, game.pool) : [];
  const valid =
    !!card &&
    (legal.length
      ? legal.some((a) => [...a].sort().join() === [...take].sort().join())
      : take.length === 0);
  function choose(c: string) {
    if (!myTurn || !game) return;
    setCard(c);
    const opts = options(c, game.pool);
    setTake(opts.length === 1 ? opts[0] : []);
  }
  const teamName = (t: number) =>
    game?.players
      .filter((_, i) => team(i) === t)
      .map((p) => p.name)
      .join(' & ') || 'Waiting';
  const knownCode = game?.code || lastCode;
  async function backToTable() {
    if (!knownCode || restoring) return;
    setError('');
    if (game && game.code === knownCode) {
      accept(game, true);
      return;
    }
    const gen = beginNav();
    setRestoring(true);
    const r = await getTable(knownCode);
    if (isLatest(gen)) {
      if (r.kind === 'reply' && r.ok) accept(r.data as GameView, true);
      else if (r.kind !== 'cancelled') {
        const f = classifyFailure(r);
        if (f.gone) forgetTable(knownCode);
        setError(f.stopPolling ? f.message : 'Connection interrupted. Try again.');
      }
      setRestoring(false);
    }
  }
  function goHome() {
    beginNav();
    if (lost?.gone) setGame(null);
    setScreen('home');
    setError('');
    history.replaceState(null, '', '/');
  }
  return (
    <main className="app-shell">
      <header className="app-header">
        <button className="wordmark" onClick={goHome} aria-label="Pasur home">
          <Club size={24} />
          <span>
            pasur<span className="wordmark-dot">.</span>
          </span>
          <span lang="fa" className="persian">
            پاسور
          </span>
        </button>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" className="help-button">
              <BookOpen size={17} />
              <span>How to play</span>
            </Button>
          </DialogTrigger>
          <DialogContent className="rules-dialog">
            <DialogTitle>At the Pasur table</DialogTitle>
            <DialogDescription>
              Two players, or four in partnerships. Play goes to the right.
            </DialogDescription>
            <div className="rule-copy">
              <p>
                <b>Make eleven.</b> Play a number card and capture table cards that bring the total
                to 11. Aces count as 1.
              </p>
              <p>
                <b>Face cards.</b> A queen takes one queen; a king takes one king. A jack takes all
                number cards and jacks.
              </p>
              <p>
                <b>Sur.</b> Clear the table without a jack for 5 points. No surs in the final deal.
                By default, opposing surs cancel, and a team with 50 points cannot score or cancel a
                sur.
              </p>
              <p>
                <b>Score.</b> Seven clubs: 7 points. Each ace and jack: 1. The 2♣: 2. The 10♦: 3.
                First to the selected target wins; tied scores continue.
              </p>
              <p>
                <b>Per shodam.</b> Claim once your captured points plus your previous score reach
                the target. Both sides are counted.
              </p>
              <p>
                <b>Four players.</b> Seats 1 and 3 form one team; seats 2 and 4 form the other. Join
                in that order.
              </p>
              <a href="https://www.pagat.com/fishing/pasur.html" target="_blank" rel="noreferrer">
                Full rules reference ↗
              </a>
            </div>
          </DialogContent>
        </Dialog>
      </header>
      {error && (
        <div className="error" role="alert">
          {error}
          <button onClick={() => setError('')} aria-label="Dismiss error">
            ×
          </button>
        </div>
      )}
      {paused && screen === 'table' && (
        <button type="button" className="connection" onClick={() => pollerRef.current?.resume()}>
          Paused while nobody is playing. Tap to reconnect.
        </button>
      )}
      {lost && screen === 'table' && (
        <div className="connection" role="alert">
          {lost.message}
          <Button variant="secondary" onClick={goHome}>
            Back to the home screen
          </Button>
        </div>
      )}
      {!paused && !lost && notice && screen === 'table' && (
        <div className="connection" role="status">
          {notice}
        </div>
      )}
      {screen !== 'table' ? (
        <section className="welcome">
          <div className="welcome-heading">
            <div className="eyebrow">THE FAMILY TABLE</div>
            <h1>A hand of Pasur.</h1>
            <p>Pick your seats. Bring your people.</p>
          </div>
          <div className="setup-panel">
            {screen === 'home' && knownCode && (
              <div className="resume">
                <Button
                  className="primary-action"
                  disabled={restoring}
                  onClick={() => void backToTable()}
                >
                  {restoring ? 'Opening your table…' : 'Back to your table'}
                  <ChevronRight size={18} />
                </Button>
                <p>
                  Table {knownCode}
                  {game?.code === knownCode &&
                    ' · ' +
                      (game.phase === 'lobby'
                        ? 'Lobby'
                        : game.phase === 'finished'
                          ? 'Game complete'
                          : `Round ${game.round}`)}
                </p>
              </div>
            )}
            <div className="setup-title">
              <h2>{screen === 'join' ? 'Join the table' : 'Set the table'}</h2>
              <LockKeyhole size={19} />
            </div>
            <label className="field">
              Your name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name at the table"
                maxLength={24}
                autoComplete="nickname"
              />
            </label>
            {screen === 'join' ? (
              <>
                <label className="field">
                  Table code
                  <Input
                    value={code}
                    onChange={(e) =>
                      setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ''))
                    }
                    maxLength={10}
                    placeholder="10-character code"
                    className="code-input"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                </label>
                <Button
                  className="primary-action"
                  disabled={busy || !name.trim() || code.length !== 10}
                  onClick={() => act('join')}
                >
                  {busy ? 'Joining…' : 'Join table'}
                  <ChevronRight size={18} />
                </Button>
                <Button variant="ghost" className="secondary-action" onClick={goHome}>
                  <ArrowLeft size={16} />
                  Create a different table
                </Button>
              </>
            ) : (
              <>
                <div className="field">
                  Seats
                  <RadioGroup value={capacity} onValueChange={setCapacity} className="seat-options">
                    <label className={capacity === '2' ? 'seat-choice active' : 'seat-choice'}>
                      <RadioGroupItem value="2" />
                      <span>
                        <b>2 players</b>
                        <small>Head to head</small>
                      </span>
                      <Users size={20} />
                    </label>
                    <label className={capacity === '4' ? 'seat-choice active' : 'seat-choice'}>
                      <RadioGroupItem value="4" />
                      <span>
                        <b>4 players</b>
                        <small>Two teams</small>
                      </span>
                      <Users size={20} />
                    </label>
                  </RadioGroup>
                </div>
                <details className="house-rules">
                  <summary>
                    House rules{' '}
                    <span>
                      To {goal} · {cancelSurs ? 'Cancel surs' : 'Keep all surs'}
                    </span>
                  </summary>
                  <div className="rules-settings">
                    <label className="field">
                      Winning score
                      <RadioGroup value={goal} onValueChange={setGoal} className="inline-options">
                        <label>
                          <RadioGroupItem value="62" />
                          62 points
                        </label>
                        <label>
                          <RadioGroupItem value="100" />
                          100 points
                        </label>
                      </RadioGroup>
                    </label>
                    <label className="switch-row">
                      <span>Opposing surs cancel</span>
                      <Switch checked={cancelSurs} onCheckedChange={setCancelSurs} />
                    </label>
                    <label className="switch-row">
                      <span>Allow surs above 50 points</span>
                      <Switch checked={unlimited} onCheckedChange={setUnlimited} />
                    </label>
                  </div>
                </details>
                <Button
                  variant={knownCode ? 'outline' : 'default'}
                  className={knownCode ? 'secondary-action create-secondary' : 'primary-action'}
                  disabled={busy || !name.trim()}
                  onClick={() => act('create')}
                >
                  {busy ? 'Setting the table…' : 'Create private table'}
                  <ChevronRight size={18} />
                </Button>
                <Button
                  variant="ghost"
                  className="secondary-action"
                  onClick={() => {
                    beginNav();
                    setScreen('join');
                    setGame(null);
                    setCode('');
                  }}
                >
                  Have an invitation? Join a table
                </Button>
              </>
            )}
          </div>
          <div className="welcome-footer">
            <span>♣</span>
            <p>
              One link. Every phone.
              <br />
              <small>Keep this browser to return to your seat.</small>
            </p>
          </div>
        </section>
      ) : (
        game && (
          <section className="game-layout">
            <div className="table-toolbar">
              <Button variant="ghost" onClick={goHome}>
                <ArrowLeft size={17} />
                Tables
              </Button>
              <span>
                {game.capacity === 2 ? 'Head to head' : 'Partnerships'} · To {game.rules.goal}
              </span>
              <Button variant="ghost" onClick={share}>
                {copied ? <Check size={17} /> : <Share2 size={17} />}Invite
              </Button>
            </div>
            {game.phase === 'lobby' ? (
              <div className="lobby-panel">
                <div className="eyebrow">YOUR TABLE IS OPEN</div>
                <h1>Save a seat.</h1>
                <p>
                  Share the invitation with{' '}
                  {game.capacity === 2 ? 'one family member' : 'three family members'}.
                </p>
                <button
                  className="room-code"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(game.code);
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    } catch {
                      setError('Your table code is ' + game.code);
                    }
                  }}
                  aria-label="Copy table code"
                >
                  {game.code}
                  <Copy size={20} />
                </button>
                <div className="seat-list">
                  {Array.from({ length: game.capacity }, (_, i) => (
                    <div key={i} className="lobby-seat">
                      <span className="avatar">
                        {game.players[i]?.name.charAt(0).toUpperCase() || '+'}
                      </span>
                      <span>
                        <b>
                          {game.players[i]?.name || 'Open seat'}
                          {i === game.seat ? ' (you)' : ''}
                        </b>
                        <small>
                          {game.capacity === 4 ? `Team ${i % 2 === 0 ? 'one' : 'two'} · ` : ''}Seat{' '}
                          {i + 1}
                          {i === 0 ? ' · Host' : ''}
                        </small>
                      </span>
                      {game.players[i] && <Check size={18} />}
                    </div>
                  ))}
                </div>
                <p className="lobby-rules">
                  Surs {game.rules.cancelSurs ? 'cancel' : 'accumulate'} ·{' '}
                  {game.rules.surLimit === 50 ? 'Sur cutoff: 50' : 'No sur cutoff'}
                </p>
                <Button
                  className="primary-action"
                  onClick={() => act('start')}
                  disabled={busy || game.players.length !== game.capacity || game.seat !== 0}
                >
                  {game.players.length !== game.capacity
                    ? `Waiting for ${game.capacity - game.players.length} more…`
                    : game.seat === 0
                      ? 'Deal the cards'
                      : 'Waiting for the host to deal'}
                </Button>
                <Button variant="outline" className="secondary-action" onClick={share}>
                  <Share2 size={17} />
                  Share invitation
                </Button>
              </div>
            ) : (
              <>
                <div className="scoreboard">
                  {[team(game.seat), 1 - team(game.seat)].map((t) => (
                    <div className={'score-side ' + (t === team(game.seat) ? 'ours' : '')} key={t}>
                      <span>
                        {game.capacity === 4
                          ? t === team(game.seat)
                            ? 'Your team'
                            : 'Other team'
                          : teamName(t)}
                      </span>
                      <strong>
                        {game.scores[t]}
                        <small> / {game.rules.goal}</small>
                      </strong>
                      <span className="capture-stats">
                        ♣ {game.captured[t].filter((c) => c[0] === 'C').length} collected ·{' '}
                        {game.surs[t]} sur{game.surs[t] === 1 ? '' : 's'}
                      </span>
                    </div>
                  ))}
                </div>
                {game.phase === 'playing' ? (
                  <>
                    <div className="play-table">
                      <div className="opponents">
                        {game.players.map(
                          (p, i) =>
                            i !== game.seat && (
                              <div
                                key={i}
                                className={'opponent ' + (i === game.turn ? 'turn' : '')}
                              >
                                <span className="avatar">{p.name.charAt(0).toUpperCase()}</span>
                                <b>{p.name}</b>
                                {game.capacity === 4 && (
                                  <small>
                                    {team(i) === team(game.seat) ? 'Partner' : 'Opponent'}
                                  </small>
                                )}
                                <div
                                  className="card-backs"
                                  aria-label={p.handCount + ' hidden cards'}
                                >
                                  {Array.from({ length: p.handCount }, (_, j) => (
                                    <span key={j} />
                                  ))}
                                </div>
                              </div>
                            ),
                        )}
                      </div>
                      <div className="table-label">
                        ROUND {game.round} <span>·</span> DEAL {game.deal} <span>·</span>{' '}
                        {game.remaining === 0 ? 'FINAL DEAL' : game.remaining + ' IN DECK'}
                      </div>
                      <div className="pool" aria-label="Cards on the table">
                        {game.pool.length ? (
                          game.pool.map((c) => (
                            <PlayingCard
                              card={c}
                              key={c}
                              selected={take.includes(c)}
                              disabled={!myTurn || !card || busy}
                              onClick={() =>
                                setTake((old) =>
                                  old.includes(c) ? old.filter((x) => x !== c) : [...old, c],
                                )
                              }
                            />
                          ))
                        ) : (
                          <div className="empty-table">
                            ♣<small>The table is clear</small>
                          </div>
                        )}
                      </div>
                      <p className="last-play" aria-live="polite">
                        {game.message}
                      </p>
                    </div>
                    <div className="your-hand">
                      <div className="hand-heading">
                        <span className={myTurn ? 'turn-label' : ''}>
                          {myTurn ? 'Your turn' : `${game.players[game.turn].name}’s turn`}
                        </span>
                        <small>{game.players[game.seat].name} · Your hand</small>
                      </div>
                      <div className="hand-cards">
                        {game.players[game.seat].hand.map((c) => (
                          <PlayingCard
                            key={c}
                            card={c}
                            selected={card === c}
                            disabled={!myTurn || busy}
                            onClick={() => choose(c)}
                          />
                        ))}
                      </div>
                      <p className="move-hint">
                        {!myTurn
                          ? 'Your hand stays private.'
                          : !card
                            ? 'Choose a card to play.'
                            : !legal.length
                              ? 'No capture — this card stays on the table.'
                              : legal.length > 1 && !valid
                                ? 'Choose the table cards to capture.'
                                : `${label(card)} takes ${take.map(label).join(' + ')}`}
                      </p>
                      <Button
                        className="primary-action"
                        disabled={busy || !myTurn || !valid}
                        onClick={() => act('play', { card, take })}
                      >
                        {busy
                          ? 'Playing…'
                          : !myTurn
                            ? 'Waiting for your turn'
                            : card
                              ? take.length
                                ? 'Capture cards'
                                : 'Play card'
                              : 'Select a card'}
                      </Button>
                      {game.scores[team(game.seat)] +
                        count(game.captured[team(game.seat)], game.surs[team(game.seat)]).total >=
                        game.rules.goal && (
                        <Button
                          className="secondary-action"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act('claim')}
                        >
                          Per shodam · Claim the game
                        </Button>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="round-result">
                    <div className="eyebrow">
                      {game.phase === 'finished' ? 'GAME COMPLETE' : 'CARDS COUNTED'}
                    </div>
                    <h1>
                      {game.phase === 'finished'
                        ? game.winner === team(game.seat)
                          ? 'You win!'
                          : 'Well played.'
                        : `Round ${game.round}`}
                    </h1>
                    {game.phase === 'finished' && <p>{teamName(game.winner!)} won the game.</p>}
                    <div className="score-table-wrap">
                      <table className="score-table">
                        <thead>
                          <tr>
                            <th>Points</th>
                            <th>
                              {game.capacity === 4 ? 'Your team' : game.players[game.seat].name}
                            </th>
                            <th>
                              {game.capacity === 4
                                ? 'Other team'
                                : game.players[1 - game.seat].name}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {(
                            [
                              'clubPoints',
                              'aces',
                              'jacks',
                              'twoClubs',
                              'tenDiamonds',
                              'surs',
                              'total',
                            ] as const
                          ).map((k) => (
                            <tr key={k}>
                              <th>
                                {
                                  {
                                    clubPoints: 'Seven clubs',
                                    aces: 'Aces',
                                    jacks: 'Jacks',
                                    twoClubs: '2 ♣',
                                    tenDiamonds: '10 ♦',
                                    surs: 'Surs',
                                    total: 'Round total',
                                  }[k]
                                }
                              </th>
                              {[team(game.seat), 1 - team(game.seat)].map((t) => (
                                <td key={t}>{game.breakdown[t]?.[k] * (k === 'surs' ? 5 : 1)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <Button
                      className="primary-action"
                      disabled={busy}
                      onClick={() => act(game.phase === 'finished' ? 'rematch' : 'start')}
                    >
                      {game.phase === 'finished' ? 'Play again' : 'Deal next round'}
                    </Button>
                  </div>
                )}
              </>
            )}
            <footer className="table-footer">
              <LockKeyhole size={13} />
              Invitation-only table · {game.code}
            </footer>
          </section>
        )
      )}
    </main>
  );
}
