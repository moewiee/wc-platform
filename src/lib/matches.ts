import { db, getMeta, nowIso, setMeta } from "./db";
import {
  apiConfigured,
  consensusOdds,
  fetchOddsEvents,
  fetchScores,
} from "./odds-api";
import { settleMatch } from "./bets";
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

// Pull fresh 1X2 odds from The Odds API. Throttled so page loads don't burn
// the free monthly quota; `force` is for the admin button.
export async function maybeRefreshOdds(force = false): Promise<SyncResult> {
  if (!apiConfigured()) return { skipped: "No ODDS_API_KEY configured — using seeded odds." };
  const last = getMeta("last_odds_refresh");
  if (!force && last && Date.now() - Date.parse(last) < ODDS_REFRESH_MS) {
    return { skipped: "Odds are fresh (refreshed within 30 minutes)." };
  }
  // Stamp before fetching so a failing API isn't hammered on every page load.
  setMeta("last_odds_refresh", nowIso());
  let events;
  try {
    events = await fetchOddsEvents();
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
    for (const ev of events) {
      const oh = consensusOdds(ev, "home");
      const od = consensusOdds(ev, "draw");
      const oa = consensusOdds(ev, "away");
      let found =
        byApiId.get(ev.id) ??
        byPair.get(teamPairKey(ev.home_team, ev.away_team));
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
          apiId: ev.id,
          kickoff: ev.commence_time,
          oh,
          od,
          oa,
          now,
          id: found.id,
        });
      } else {
        // New fixture from the API (e.g. knockout round pairing decided).
        insert.run({
          apiId: ev.id,
          home: ev.home_team,
          away: ev.away_team,
          kickoff: ev.commence_time,
          oh,
          od,
          oa,
          now,
        });
      }
      updated++;
    }
  })();
  return { updated };
}

// Pull final scores for recently finished matches and settle all bets on them.
// The API only provides goals, so corners/cards bets stay pending for the
// admin to complete.
export async function maybeSyncScores(force = false): Promise<SyncResult> {
  if (!apiConfigured()) return { skipped: "No ODDS_API_KEY configured — settle matches from the Admin page." };
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
  let scores;
  try {
    scores = await fetchScores(3);
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
  for (const s of scores) {
    if (!s.completed || !s.scores) continue;
    const match =
      byApiId.get(s.id) ?? byPair.get(teamPairKey(s.home_team, s.away_team));
    if (!match) continue;
    const homeEntry = s.scores.find((e) => e.name === s.home_team);
    const awayEntry = s.scores.find((e) => e.name === s.away_team);
    if (!homeEntry || !awayEntry) continue;
    const hs = Number(homeEntry.score);
    const as = Number(awayEntry.score);
    if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;
    const res = settleMatch(match.id, { homeScore: hs, awayScore: as });
    if (!res.error) settled++;
  }
  return { updated: settled };
}
