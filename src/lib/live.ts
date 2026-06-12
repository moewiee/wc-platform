import { db, nowIso } from "./db";
import { fetchEspnLiveScores } from "./espn";
import { teamPairKey } from "./teams";
import type { Match } from "./types";

// In-play scores for the lobby, mapped to our match ids. Cached in-process
// for a minute so polling clients share one upstream call.

export interface LiveScoreRow {
  match_id: number;
  home_score: number;
  away_score: number;
  clock: string;
}

const TTL_MS = 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __wcLiveCache: { at: number; rows: LiveScoreRow[] } | undefined;
}

export async function getLiveScores(): Promise<LiveScoreRow[]> {
  const cached = global.__wcLiveCache;
  if (cached && Date.now() - cached.at < TTL_MS) return cached.rows;

  // Kicked off but not yet settled — the rows the lobby flags as LIVE.
  const inPlay = db
    .prepare(
      "SELECT id, home_team, away_team FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
    )
    .all(nowIso()) as Pick<Match, "id" | "home_team" | "away_team">[];

  let rows: LiveScoreRow[] = [];
  if (inPlay.length > 0) {
    try {
      const feed = await fetchEspnLiveScores();
      const byPair = new Map(
        feed.map((s) => [teamPairKey(s.home_team, s.away_team), s])
      );
      rows = inPlay.flatMap((m) => {
        const s = byPair.get(teamPairKey(m.home_team, m.away_team));
        return s
          ? [{ match_id: m.id, home_score: s.home_score, away_score: s.away_score, clock: s.clock }]
          : [];
      });
    } catch {
      rows = cached?.rows ?? []; // keep showing the last known scores
    }
  }
  global.__wcLiveCache = { at: Date.now(), rows };
  return rows;
}
