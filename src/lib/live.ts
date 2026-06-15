import { db, nowIso } from "./db";
import { fetchEspnLiveScores, type EspnLiveScore } from "./espn";
import {
  fetchOioLiveEvents,
  fetchOioQuotes,
  oioConfigured,
} from "./odds-api-io";
import { teamPairKey } from "./teams";
import type { Match } from "./types";

// In-play state hub. The ESPN scoreboard is the only live source and it lags
// real life by up to ~a minute, so this module's job is twofold:
//   1. persist the last-observed score/minute per match (live_state), and
//   2. decide when in-play betting must be SUSPENDED so a viewer who is ahead
//      of our feed can't snipe a stale price.
// Pricing lives in markets.ts; placement in bets.ts reads the persisted row
// synchronously so the priced snapshot matches the booked bet.

// In-play betting can be turned off entirely (graceful degradation, like the
// optional API keys). Default ON — the feature the product now wants.
export function inPlayEnabled(): boolean {
  return process.env.INPLAY_BETTING !== "off";
}

const LOBBY_TTL_MS = 60 * 1000; // lobby score board freshness
const FRESH_TTL_MS = 8 * 1000; // micro-cache for pricing/placement (don't hammer ESPN)
// No fresh observation in this long ⇒ we don't actually know the score ⇒ suspend.
const STALE_MS = 150 * 1000;
// After we OBSERVE a score change, pause this long. Must exceed the feed lag
// plus a poll interval so the window while prices re-settle is covered. (It
// cannot cover the window BEFORE we observe the goal — that is the irreducible
// feed-latency risk, bounded instead by the wide live margin, the min-odds
// floor and the lower in-play stake cap.)
const COOLOFF_MS = 150 * 1000;
// Game minute not advancing for this long (HT, VAR, late stoppage, a frozen
// feed) ⇒ suspend. Longer than the ~60s a single minute legitimately lasts.
const FROZEN_MS = 130 * 1000;
// Knockout matches can go to extra time; the bookmaker's full-time line and a
// full-time settlement that includes ET goals diverge near the regulation end.
// Group matches (group_name set) can't, so only ET-capable matches are gated.
const KO_SUSPEND_FROM_MINUTE = 80;
// How often to pull fresh Bet365 in-play odds while a match is live (driven by
// the match-page poll + placement, not the slow sync loop). Env-tunable so a
// bigger odds-api.io quota can poll faster; default fits the free tier.
// Clamped to [10s, 120s]: the upper bound stays below markets.ts'
// LIVE_QUOTE_FRESH_MS (3 min) so healthy quotes never expire between refreshes
// (which would falsely self-suspend in-play).
const LIVE_ODDS_REFRESH_MS = Math.min(
  120_000,
  Math.max(10_000, Number(process.env.LIVE_ODDS_REFRESH_MS) || 45_000)
);
// A placement force-fetch still shares this micro-window so a burst of bets
// can't each spend an API call.
const LIVE_ODDS_FORCE_MIN_MS = 8 * 1000;
// A bet may only price off a live quote written this recently — so a failed
// force-fetch (no new quote) fails closed at placement instead of booking a
// quote up to LIVE_QUOTE_FRESH_MS old (which the slower display board tolerates).
const PLACEMENT_QUOTE_FRESH_MS = 20 * 1000;
// Early settlement acts only on a score that has held steady this long, so a
// goal later disallowed by VAR (the feed reverts within the window) never
// triggers a wrongful settle.
const EARLY_RESOLVE_CONFIRM_MS = 5 * 60 * 1000;

export interface LiveScoreRow {
  match_id: number;
  home_score: number;
  away_score: number;
  clock: string;
}

interface LiveStateRow {
  match_id: number;
  home_score: number;
  away_score: number;
  minute: number | null;
  state: string | null;
  detail: string | null;
  observed_at: string;
  minute_seen_at: string;
  last_change_at: string | null;
  suspend_until: string | null;
  corners_home: number | null;
  corners_away: number | null;
}

export interface LiveContext {
  available: boolean; // we have a usable observation for this started match
  suspended: boolean; // betting paused right now
  reason: string; // shown to the user when unavailable/suspended
  homeScore: number;
  awayScore: number;
  minute: number | null;
  clock: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __wcLiveFeed: { at: number; feed: EspnLiveScore[] } | undefined;
  // eslint-disable-next-line no-var
  var __wcLiveOddsAt: number | undefined; // last Bet365 in-play odds refresh (ms)
}

// Shared ESPN fetch with a short cache so concurrent pollers/bets reuse one
// upstream call. `fetched` is true only when we actually hit ESPN, so callers
// re-persist live_state (advancing observed_at) on real observations rather
// than on every cached read. Never throws — on error the previous feed is
// reused (and if there is none, the empty result lets staleness suspend).
async function getFreshFeed(
  maxAgeMs: number
): Promise<{ feed: EspnLiveScore[]; fetched: boolean }> {
  const cached = global.__wcLiveFeed;
  if (cached && Date.now() - cached.at < maxAgeMs) return { feed: cached.feed, fetched: false };
  try {
    const feed = await fetchEspnLiveScores();
    global.__wcLiveFeed = { at: Date.now(), feed };
    return { feed, fetched: true };
  } catch {
    return { feed: cached?.feed ?? [], fetched: false };
  }
}

// Game minute from the feed, or null when we must not price (HT, finished,
// unparseable). Fail-closed: anything we can't read as an active 1..90+ minute
// returns null and the caller suspends. Never trusts shortDetail as a minute.
function liveMinute(s: EspnLiveScore): number | null {
  if (s.state !== "in") return null; // pre/post — not live play
  const detail = (s.detail || "").toUpperCase();
  // The half-time interval (no play) — suspend rather than price a phantom minute.
  if (detail === "HT" || detail.includes("HALFTIME") || detail.includes("HALF TIME")) {
    return null;
  }
  // Prefer the running display clock ("67'", "45'+2"); fall back to seconds.
  const dc = (s.displayClock || "").match(/(\d{1,3})/);
  if (dc) {
    const m = Number(dc[1]);
    if (m >= 1 && m <= 130) return Math.min(m, 95);
  }
  if (typeof s.clockSeconds === "number" && s.clockSeconds > 0) {
    return Math.min(Math.floor(s.clockSeconds / 60), 95);
  }
  return null;
}

const getStateRow = db.prepare("SELECT * FROM live_state WHERE match_id = ?");
const upsertState = db.prepare(`
  INSERT INTO live_state
    (match_id, home_score, away_score, minute, state, detail,
     observed_at, minute_seen_at, last_change_at, suspend_until,
     corners_home, corners_away)
  VALUES (@match_id, @home_score, @away_score, @minute, @state, @detail,
          @observed_at, @minute_seen_at, @last_change_at, @suspend_until,
          @corners_home, @corners_away)
  ON CONFLICT(match_id) DO UPDATE SET
    home_score = excluded.home_score,
    away_score = excluded.away_score,
    minute = excluded.minute,
    state = excluded.state,
    detail = excluded.detail,
    observed_at = excluded.observed_at,
    minute_seen_at = excluded.minute_seen_at,
    last_change_at = excluded.last_change_at,
    suspend_until = excluded.suspend_until,
    corners_home = excluded.corners_home,
    corners_away = excluded.corners_away
`);

// Persist the latest feed observation for every started, unsettled match.
// A score change (in either direction — feed flaps are debounced the same as
// real goals) arms the cool-off; a minute that hasn't advanced keeps its
// original minute_seen_at so freeze detection can fire.
function syncLiveState(feed: EspnLiveScore[]): void {
  const started = db
    .prepare(
      "SELECT id, home_team, away_team FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
    )
    .all(nowIso()) as Pick<Match, "id" | "home_team" | "away_team">[];
  if (started.length === 0) return;
  const byPair = new Map(feed.map((s) => [teamPairKey(s.home_team, s.away_team), s]));
  const now = nowIso();
  const nowMs = Date.now();
  db.transaction(() => {
    for (const m of started) {
      const s = byPair.get(teamPairKey(m.home_team, m.away_team));
      if (!s) continue; // not in the feed window — existing row goes stale → suspend
      const prev = getStateRow.get(m.id) as LiveStateRow | undefined;
      const minute = liveMinute(s);
      const scoreChanged =
        !!prev && (prev.home_score !== s.home_score || prev.away_score !== s.away_score);
      const minuteUnchanged = !!prev && prev.minute === minute && minute !== null;
      upsertState.run({
        match_id: m.id,
        home_score: s.home_score,
        away_score: s.away_score,
        minute,
        state: s.state,
        detail: s.detail,
        observed_at: now,
        minute_seen_at: minuteUnchanged ? prev!.minute_seen_at : now,
        // "stable since": reset on a score change AND at first observation, so
        // early settlement only acts on a score we've watched hold steady.
        last_change_at: scoreChanged || !prev ? now : prev.last_change_at,
        suspend_until: scoreChanged
          ? new Date(nowMs + COOLOFF_MS).toISOString()
          : (prev?.suspend_until ?? null),
        corners_home: s.corners_home,
        corners_away: s.corners_away,
      });
    }
  })();
}

// Refresh live_state from a (micro-cached) feed read. Called by the lobby
// board, the per-match markets poll, and in-play placement.
async function refreshLiveState(maxAgeMs: number): Promise<void> {
  const due = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
      )
      .get(nowIso()) as { n: number }
  ).n;
  if (due === 0) return;
  const { feed, fetched } = await getFreshFeed(maxAgeMs);
  if (fetched) syncLiveState(feed);
}

// Pull fresh Bet365 in-play odds for the live matches into market_odds (the
// same table + parser the pre-match overlay uses, now incl. ML→1X2). A market
// the bookmaker isn't posting (suspended) is left to age out, which makes
// liveMarketsForMatch drop it → in-play suspends. Best-effort.
async function refreshLiveOdds(
  live: Pick<Match, "id" | "home_team" | "away_team" | "oio_event_id">[]
): Promise<void> {
  if (!oioConfigured() || live.length === 0) return;
  const mapped = live.filter((m) => m.oio_event_id);
  const unmapped = live.filter((m) => !m.oio_event_id);
  if (unmapped.length) {
    const events = await fetchOioLiveEvents();
    const byPair = new Map(events.map((e) => [teamPairKey(e.home, e.away), e]));
    const stamp = db.prepare("UPDATE matches SET oio_event_id = ? WHERE id = ?");
    for (const m of unmapped) {
      const ev = byPair.get(teamPairKey(m.home_team, m.away_team));
      if (!ev) continue;
      m.oio_event_id = String(ev.id);
      stamp.run(m.oio_event_id, m.id);
      mapped.push(m);
    }
  }
  if (!mapped.length) return;
  const quotes = await fetchOioQuotes(mapped.map((m) => m.oio_event_id!));
  // Live rows only (in_play = 1); pre-match rows (in_play = 0) are left alone
  // and are never read by the in-play sheet.
  const del = db.prepare("DELETE FROM market_odds WHERE match_id = ? AND in_play = 1");
  const ins = db.prepare(
    "INSERT INTO market_odds (match_id, market, line, selection, odds, updated_at, in_play) VALUES (?, ?, ?, ?, ?, ?, 1)"
  );
  const ts = nowIso();
  db.transaction(() => {
    for (const m of mapped) {
      const qs = quotes.get(m.oio_event_id!);
      if (!qs?.length) continue; // bookmaker not quoting — keep last; freshness expires it
      del.run(m.id);
      for (const q of qs) ins.run(m.id, q.market, q.line, q.selection, q.odds, ts);
    }
  })();
}

// The live score (and live corner total, when the feed carries it) for a match
// ONLY if it's safe to settle bets against early: a fresh observation (not
// stale) that has held steady for the confirmation window (so it isn't a goal
// mid-VAR). Null otherwise.
export function getConfirmedLiveScore(
  matchId: number
): { home: number; away: number; cornersTotal: number | null } | null {
  const row = getStateRow.get(matchId) as LiveStateRow | undefined;
  if (!row || !row.last_change_at) return null;
  const now = Date.now();
  if (now - Date.parse(row.observed_at) > STALE_MS) return null; // feed gone quiet — don't trust it
  if (now - Date.parse(row.last_change_at) < EARLY_RESOLVE_CONFIRM_MS) return null; // not yet stable
  const cornersTotal =
    row.corners_home !== null && row.corners_away !== null
      ? row.corners_home + row.corners_away
      : null;
  return { home: row.home_score, away: row.away_score, cornersTotal };
}

// Refresh ESPN observations (score/clock/corners) into live_state with no odds
// fetch — used by the sync loop so early settlement works without page traffic.
export async function refreshLiveObservations(): Promise<void> {
  await refreshLiveState(FRESH_TTL_MS);
}

// Has this match a live (in_play=1) quote written within the placement window?
// Used to fail closed at placement when the force-fetch couldn't refresh.
export function hasFreshLiveQuote(matchId: number): boolean {
  const row = db
    .prepare(
      "SELECT MAX(updated_at) AS t FROM market_odds WHERE match_id = ? AND in_play = 1"
    )
    .get(matchId) as { t: string | null };
  return !!row.t && Date.now() - Date.parse(row.t) <= PLACEMENT_QUOTE_FRESH_MS;
}

// Refresh in-play state: ESPN score/clock (cheap, free — the suspension
// tripwire + display) plus throttled Bet365 odds (the budgeted call). Driven by
// the match-page markets poll and by placement (force) — NOT the slow sync
// loop — so we only spend odds quota while a live match is actually watched.
async function maybeRefreshLive(force: boolean): Promise<void> {
  const live = db
    .prepare(
      "SELECT id, home_team, away_team, oio_event_id FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
    )
    .all(nowIso()) as Pick<Match, "id" | "home_team" | "away_team" | "oio_event_id">[];
  if (live.length === 0) return;
  await refreshLiveState(force ? FRESH_TTL_MS : LIVE_ODDS_REFRESH_MS);
  const prev = global.__wcLiveOddsAt ?? 0;
  const since = Date.now() - prev;
  if (since < (force ? LIVE_ODDS_FORCE_MIN_MS : LIVE_ODDS_REFRESH_MS)) return;
  // Claim the window before awaiting so concurrent calls don't all fetch; on
  // failure restore it so the next call retries (and placement fails closed via
  // hasFreshLiveQuote rather than booking a stale quote).
  global.__wcLiveOddsAt = Date.now();
  try {
    await refreshLiveOdds(live);
  } catch {
    global.__wcLiveOddsAt = prev;
  }
}

function contextFromRow(match: Match, row: LiveStateRow | undefined): LiveContext {
  if (!row) {
    return {
      available: false,
      suspended: true,
      reason: "Waiting for the live feed…",
      homeScore: 0,
      awayScore: 0,
      minute: null,
      clock: "LIVE",
    };
  }
  const minute = row.minute;
  const clock =
    row.state === "post" ? "FT" : minute !== null ? `${minute}'` : row.detail || "LIVE";
  const base = {
    available: true,
    homeScore: row.home_score,
    awayScore: row.away_score,
    minute,
    clock,
  };
  const susp = (reason: string): LiveContext => ({ ...base, suspended: true, reason });
  const now = Date.now();
  if (row.state === "post") return susp("Match finished — settling.");
  if (now - Date.parse(row.observed_at) > STALE_MS) return susp("Reconnecting to the live feed…");
  if (minute === null) return susp("Half-time — betting resumes shortly.");
  if (now - Date.parse(row.minute_seen_at) > FROZEN_MS) return susp("Play paused — prices updating.");
  if (row.suspend_until && Date.parse(row.suspend_until) > now)
    return susp("Prices updating after a goal…");
  if (!match.group_name && minute >= KO_SUSPEND_FROM_MINUTE)
    return susp("In-play paused — knockout heading for extra time.");
  return { ...base, suspended: false, reason: "" };
}

// Current in-play context for one started match: refreshes ESPN score + (when
// due, or forced at placement) Bet365 odds, then reads the persisted row and
// decides whether betting is open. `force` (placement) bypasses the odds
// throttle. Quote freshness itself gates pricing in markets.ts — this decides
// the ESPN-derived suspensions (goal cool-off, HT/FT, stale, knockout ET).
export async function getLiveContext(match: Match, force = false): Promise<LiveContext> {
  await maybeRefreshLive(force);
  return contextFromRow(match, getStateRow.get(match.id) as LiveStateRow | undefined);
}

// Same decision, but WITHOUT a feed fetch — reads the already-persisted row.
// placeBet uses this inside its synchronous transaction (it can't await) after
// getLiveContext has refreshed the row, so the suspension re-check and the bet
// share one snapshot.
export function getLiveContextSync(match: Match): LiveContext {
  return contextFromRow(match, getStateRow.get(match.id) as LiveStateRow | undefined);
}

// In-play scores for the lobby, mapped to our match ids. Refreshes (and
// reuses) the shared live state; on feed failure rows go stale and read as
// their last-known value, which is acceptable for a display-only board.
export async function getLiveScores(): Promise<LiveScoreRow[]> {
  await refreshLiveState(LOBBY_TTL_MS);
  const rows = db
    .prepare(
      `SELECT ls.match_id, ls.home_score, ls.away_score, ls.minute, ls.state, ls.detail
       FROM live_state ls
       JOIN matches m ON m.id = ls.match_id
       WHERE m.status = 'scheduled' AND m.kickoff <= ?`
    )
    .all(nowIso()) as (Pick<LiveStateRow, "match_id" | "home_score" | "away_score" | "minute" | "state" | "detail">)[];
  return rows.map((r) => ({
    match_id: r.match_id,
    home_score: r.home_score,
    away_score: r.away_score,
    clock: r.state === "post" ? "FT" : r.minute !== null ? `${r.minute}'` : r.detail || "LIVE",
  }));
}
