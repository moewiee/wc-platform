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
import { completeMatchData, settleMatch } from "./bets";
import { teamPairKey } from "./teams";
import type { Match } from "./types";

// Rates update every 30 minutes pre-kickoff (requirement); the bet counter
// closes at kickoff (enforced in placeBet and the UI).
const ODDS_REFRESH_MS = 30 * 60 * 1000;
const SCORES_SYNC_MS = 10 * 60 * 1000;

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
  const last = getMeta("last_odds_refresh");
  if (!force && last && Date.now() - Date.parse(last) < ODDS_REFRESH_MS) {
    return { skipped: "Odds are fresh (refreshed within 30 minutes)." };
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
      "SELECT id, api_id, home_team, away_team FROM matches WHERE status = 'scheduled'"
    )
    .all() as Pick<Match, "id" | "api_id" | "home_team" | "away_team">[];
  const byApiId = new Map(open.filter((m) => m.api_id).map((m) => [m.api_id!, m]));
  const byPair = new Map(
    open.map((m) => [teamPairKey(m.home_team, m.away_team), m])
  );

  let settled = 0;
  for (const s of finals) {
    const match =
      (s.apiId && byApiId.get(s.apiId)) ?? byPair.get(teamPairKey(s.home, s.away));
    if (!match) continue;
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
