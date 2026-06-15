import { db, getMeta, nowIso, setMeta } from "./db";
import {
  apiConfigured,
  consensusOdds,
  fetchOddsEvents,
  fetchScores,
} from "./odds-api";
import {
  fetchEspnCards,
  fetchEspnFinalScores,
  fetchEspnOdds,
  type EspnFinalScore,
} from "./espn";
import { fetchOioEvents, fetchOioQuotes, oioConfigured } from "./odds-api-io";
import { completeMatchData, settleMatch } from "./bets";
import { teamPairKey } from "./teams";
import type { Match } from "./types";

// Rates must update at least every 30 minutes pre-kickoff (requirement); the
// bet counter closes at kickoff (enforced in placeBet and the UI). ESPN's
// keyless scoreboard is a single GET per refresh, so it can run every 10
// minutes; The Odds API stays at 30 to fit the free 500-credit/month tier.
const ODDS_REFRESH_KEYED_MS = 30 * 60 * 1000;
const ODDS_REFRESH_KEYLESS_MS = 10 * 60 * 1000;
const SCORES_SYNC_MS = 10 * 60 * 1000;
// Don't auto-settle a started match until a full match could plausibly have
// elapsed. Now that bets can be placed in-play, a feed that briefly reports a
// running game "completed" (an HT/transition glitch, or the end of regulation
// in a knockout heading to extra time) would otherwise settle every open bet
// on an interim score and the one-way guard would lock it. The admin's manual
// settle bypasses this floor.
const GROUP_FULLTIME_FLOOR_MS = 110 * 60 * 1000; // 90' + half-time + stoppage
const KO_FULLTIME_FLOOR_MS = 140 * 60 * 1000; // + possible extra time/penalties
const MARKET_ODDS_REFRESH_MS = 10 * 60 * 1000;
const MARKET_ODDS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// One /odds/multi call returns up to 10 matches with ALL their markets, so we
// fetch only the nearest 10 upcoming fixtures per refresh — exactly one odds
// call — to conserve the odds-api.io quota.
const MARKET_ODDS_MAX_MATCHES = 10;

// The active 1X2 refresh cadence, for UI copy ("refreshed every N min").
export function oddsRefreshMinutes(): number {
  return (apiConfigured() ? ODDS_REFRESH_KEYED_MS : ODDS_REFRESH_KEYLESS_MS) / 60_000;
}

export function listMatches(): Match[] {
  return db.prepare("SELECT * FROM matches ORDER BY kickoff, id").all() as Match[];
}

export function getMatch(id: number): Match | undefined {
  return db.prepare("SELECT * FROM matches WHERE id = ?").get(id) as
    | Match
    | undefined;
}

export type SyncResult = { updated: number } | { skipped: string };

// A 1X2 quote normalized from whichever odds source we used.
type OddsQuote = {
  apiId: string;
  home: string;
  away: string;
  kickoff: string;
  oh: number | null;
  od: number | null;
  oa: number | null;
};

// Pull fresh 1X2 odds — The Odds API (bookmaker median) when a key is
// configured, otherwise DraftKings prices via ESPN's keyless scoreboard.
// Throttled so page loads don't burn quota; `force` is for the admin button.
export async function maybeRefreshOdds(force = false): Promise<SyncResult> {
  const refreshMs = apiConfigured()
    ? ODDS_REFRESH_KEYED_MS
    : ODDS_REFRESH_KEYLESS_MS;
  const last = getMeta("last_odds_refresh");
  if (!force && last && Date.now() - Date.parse(last) < refreshMs) {
    return {
      skipped: `Odds are fresh (refreshed within ${refreshMs / 60000} minutes).`,
    };
  }
  // Stamp before fetching so a failing API isn't hammered on every page load.
  setMeta("last_odds_refresh", nowIso());
  let quotes: OddsQuote[];
  try {
    if (apiConfigured()) {
      quotes = (await fetchOddsEvents()).map((ev) => ({
        apiId: ev.id,
        home: ev.home_team,
        away: ev.away_team,
        kickoff: ev.commence_time,
        oh: consensusOdds(ev, "home"),
        od: consensusOdds(ev, "draw"),
        oa: consensusOdds(ev, "away"),
      }));
    } else {
      // Prefix ESPN ids so a later Odds API setup never collides on api_id.
      quotes = (await fetchEspnOdds()).map((s) => ({
        apiId: `espn:${s.espn_id}`,
        home: s.home_team,
        away: s.away_team,
        kickoff: s.kickoff,
        oh: s.odds_home,
        od: s.odds_draw,
        oa: s.odds_away,
      }));
    }
    setMeta("last_api_error", "");
  } catch (e) {
    setMeta("last_api_error", e instanceof Error ? e.message : String(e));
    throw e;
  }

  const existing = db
    .prepare("SELECT id, api_id, home_team, away_team, status FROM matches")
    .all() as Pick<Match, "id" | "api_id" | "home_team" | "away_team" | "status">[];
  const byApiId = new Map(existing.filter((m) => m.api_id).map((m) => [m.api_id!, m]));
  // Only scheduled rows may absorb an API event by team-pair: a finished
  // group match must not swallow a knockout rematch of the same teams.
  const byPair = new Map(
    existing
      .filter((m) => m.status === "scheduled")
      .map((m) => [teamPairKey(m.home_team, m.away_team), m])
  );

  let updated = 0;
  const now = nowIso();
  db.transaction(() => {
    const update = db.prepare(`
      UPDATE matches SET api_id = @apiId, kickoff = @kickoff,
        odds_home = COALESCE(@oh, odds_home),
        odds_draw = COALESCE(@od, odds_draw),
        odds_away = COALESCE(@oa, odds_away),
        odds_updated_at = @now, odds_source = 'live'
      WHERE id = @id
    `);
    const insert = db.prepare(`
      INSERT INTO matches (api_id, home_team, away_team, kickoff,
        odds_home, odds_draw, odds_away, odds_updated_at, odds_source)
      VALUES (@apiId, @home, @away, @kickoff, @oh, @od, @oa, @now, 'live')
    `);
    const detachApiId = db.prepare("UPDATE matches SET api_id = NULL WHERE id = ?");
    for (const q of quotes) {
      let found =
        byApiId.get(q.apiId) ?? byPair.get(teamPairKey(q.home, q.away));
      if (found && found.status !== "scheduled") {
        if (found.status === "void") {
          // A voided (postponed) match reappeared in the feed — free the
          // api_id so the rescheduled fixture gets a fresh bettable row.
          detachApiId.run(found.id);
          found = undefined;
        } else {
          continue; // finished: already settled, ignore the event
        }
      }
      if (found) {
        update.run({
          apiId: q.apiId,
          kickoff: q.kickoff,
          oh: q.oh,
          od: q.od,
          oa: q.oa,
          now,
          id: found.id,
        });
      } else {
        // New fixture from the feed (e.g. knockout round pairing decided).
        insert.run({
          apiId: q.apiId,
          home: q.home,
          away: q.away,
          kickoff: q.kickoff,
          oh: q.oh,
          od: q.od,
          oa: q.oa,
          now,
        });
      }
      updated++;
    }
  })();
  return { updated };
}

// Real per-market quotes (AH, totals, BTTS, correct score, corners, cards)
// from odds-api.io for the nearest upcoming fixtures; they overlay the Poisson
// prices in marketsForMatch. Quota: the nearest 10 matches = exactly 1 batched
// /odds call per refresh (+ a rare events call only while ids are unmapped) —
// ~6 requests/hour against the free tier's 100.
export async function maybeRefreshMarketOdds(force = false): Promise<SyncResult> {
  if (!oioConfigured()) return { skipped: "ODDS_API_IO_KEY is not configured." };
  const last = getMeta("last_market_odds_refresh");
  if (!force && last && Date.now() - Date.parse(last) < MARKET_ODDS_REFRESH_MS) {
    return { skipped: "Market odds are fresh (refreshed within 10 minutes)." };
  }
  setMeta("last_market_odds_refresh", nowIso());

  const now = Date.now();
  // listMatches() is ordered by kickoff, so this is the nearest N upcoming.
  const targets = listMatches()
    .filter((m) => {
      if (m.status !== "scheduled") return false;
      const kickoff = Date.parse(m.kickoff);
      return kickoff > now && kickoff - now < MARKET_ODDS_WINDOW_MS;
    })
    .slice(0, MARKET_ODDS_MAX_MATCHES);
  if (targets.length === 0) return { updated: 0 };

  try {
    // Map our matches to feed event ids once; ids are stable afterwards.
    if (targets.some((m) => !m.oio_event_id)) {
      const events = await fetchOioEvents();
      const byPair = new Map(events.map((e) => [teamPairKey(e.home, e.away), e]));
      const stamp = db.prepare("UPDATE matches SET oio_event_id = ? WHERE id = ?");
      for (const m of targets) {
        if (m.oio_event_id) continue;
        const ev = byPair.get(teamPairKey(m.home_team, m.away_team));
        if (ev) {
          m.oio_event_id = String(ev.id);
          stamp.run(m.oio_event_id, m.id);
        }
      }
    }
    const mapped = targets.filter((m) => m.oio_event_id);
    const quotes = await fetchOioQuotes(mapped.map((m) => m.oio_event_id!));

    // Pre-match rows only (in_play = 0); the live refresh owns in_play = 1.
    const del = db.prepare("DELETE FROM market_odds WHERE match_id = ? AND in_play = 0");
    const ins = db.prepare(
      `INSERT INTO market_odds (match_id, market, line, selection, odds, updated_at, in_play)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    );
    let updated = 0;
    const ts = nowIso();
    db.transaction(() => {
      for (const m of mapped) {
        const qs = quotes.get(m.oio_event_id!);
        if (!qs?.length) continue; // keep last quotes; staleness guard expires them
        del.run(m.id);
        for (const q of qs) ins.run(m.id, q.market, q.line, q.selection, q.odds, ts);
        updated++;
      }
    })();
    setMeta("last_oio_error", "");
    return { updated };
  } catch (e) {
    setMeta("last_oio_error", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

// A full-time result normalized from whichever score source we used.
type FinalScore = {
  apiId?: string;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
};

// The Odds API scores feed (needs ODDS_API_KEY; matches by api_id first).
async function fetchOddsApiFinals(): Promise<FinalScore[]> {
  const scores = await fetchScores(3);
  const finals: FinalScore[] = [];
  for (const s of scores) {
    if (!s.completed || !s.scores) continue;
    const homeEntry = s.scores.find((e) => e.name === s.home_team);
    const awayEntry = s.scores.find((e) => e.name === s.away_team);
    if (!homeEntry || !awayEntry) continue;
    const hs = Number(homeEntry.score);
    const as = Number(awayEntry.score);
    if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;
    finals.push({
      apiId: s.id,
      home: s.home_team,
      away: s.away_team,
      homeScore: hs,
      awayScore: as,
    });
  }
  return finals;
}

// Pull final scores for recently finished matches and settle all bets on them.
// Source: The Odds API when a key is configured, otherwise ESPN's keyless
// scoreboard. Both only provide goals, so corners/cards bets stay pending for
// the admin to complete.
export async function maybeSyncScores(force = false): Promise<SyncResult> {
  const due = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
      )
      .get(nowIso()) as { n: number }
  ).n;
  if (due === 0) return { skipped: "No started matches awaiting a result." };
  const last = getMeta("last_scores_sync");
  if (!force && last && Date.now() - Date.parse(last) < SCORES_SYNC_MS) {
    return { skipped: "Scores were synced within the last 10 minutes." };
  }
  setMeta("last_scores_sync", nowIso());
  let espnFinals: EspnFinalScore[] | null = null;
  let finals: FinalScore[];
  try {
    if (apiConfigured()) {
      finals = await fetchOddsApiFinals();
    } else {
      espnFinals = await fetchEspnFinalScores(3);
      finals = espnFinals.map((s) => ({
        home: s.home_team,
        away: s.away_team,
        homeScore: s.home_score,
        awayScore: s.away_score,
      }));
    }
    setMeta("last_api_error", "");
  } catch (e) {
    setMeta("last_api_error", e instanceof Error ? e.message : String(e));
    throw e;
  }

  const open = db
    .prepare(
      "SELECT id, api_id, home_team, away_team, kickoff, group_name FROM matches WHERE status = 'scheduled'"
    )
    .all() as Pick<Match, "id" | "api_id" | "home_team" | "away_team" | "kickoff" | "group_name">[];
  const byApiId = new Map(open.filter((m) => m.api_id).map((m) => [m.api_id!, m]));
  const byPair = new Map(
    open.map((m) => [teamPairKey(m.home_team, m.away_team), m])
  );

  let settled = 0;
  for (const s of finals) {
    const match =
      (s.apiId && byApiId.get(s.apiId)) ?? byPair.get(teamPairKey(s.home, s.away));
    if (!match) continue;
    // Full-time floor: ignore a "completed" report on a match too young to
    // have truly finished, so a feed glitch can't settle a live game early.
    const floor = match.group_name ? GROUP_FULLTIME_FLOOR_MS : KO_FULLTIME_FLOOR_MS;
    if (Date.now() - Date.parse(match.kickoff) < floor) continue;
    const res = settleMatch(match.id, {
      homeScore: s.homeScore,
      awayScore: s.awayScore,
    });
    if (!res.error) settled++;
  }

  // Completion pass: fill corners/cards on recently finished matches from
  // ESPN box scores so ah_corners/ou_corners/ou_cards bets settle without the
  // admin. Best-effort — anything still missing stays pending and is retried
  // on the next sync (or entered manually).
  const cutoff = new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString();
  const incomplete = db
    .prepare(
      `SELECT id, home_team, away_team FROM matches
       WHERE status = 'finished' AND kickoff >= ?
         AND (corners_home IS NULL OR corners_away IS NULL OR cards_total IS NULL)`
    )
    .all(cutoff) as Pick<Match, "id" | "home_team" | "away_team">[];
  if (incomplete.length > 0) {
    try {
      espnFinals ??= await fetchEspnFinalScores(3);
      const espnByPair = new Map(
        espnFinals.map((s) => [teamPairKey(s.home_team, s.away_team), s])
      );
      for (const m of incomplete) {
        const s = espnByPair.get(teamPairKey(m.home_team, m.away_team));
        if (!s) continue;
        const cards = await fetchEspnCards(s.espn_id);
        if (s.corners_home === null && s.corners_away === null && cards === null) continue;
        completeMatchData(m.id, s.corners_home, s.corners_away, cards);
      }
    } catch (e) {
      setMeta("last_api_error", e instanceof Error ? e.message : String(e));
    }
  }
  return { updated: settled };
}
