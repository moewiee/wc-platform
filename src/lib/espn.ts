// Keyless score source: ESPN's public World Cup JSON. The scoreboard gives
// final scores and corners (wonCorners); total cards need one extra summary
// call per match (fetchEspnCards). No odds.
const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const SUMMARY_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/summary";

export interface EspnFinalScore {
  espn_id: string;
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  corners_home: number | null;
  corners_away: number | null;
}

interface EspnStatistic {
  name?: string;
  displayValue?: string;
}
interface EspnCompetitor {
  homeAway?: string;
  score?: string;
  team?: { displayName?: string };
  statistics?: EspnStatistic[];
}
interface EspnEvent {
  id?: string;
  competitions?: {
    status?: { type?: { state?: string; completed?: boolean } };
    competitors?: EspnCompetitor[];
  }[];
}

function intStat(c: EspnCompetitor, name: string): number | null {
  const v = c.statistics?.find((s) => s.name === name)?.displayValue;
  const n = Number(v);
  return v !== undefined && Number.isInteger(n) && n >= 0 ? n : null;
}

function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Full-time results from the last `daysBack` days (UTC date window).
export async function fetchEspnFinalScores(
  daysBack = 3
): Promise<EspnFinalScore[]> {
  const from = new Date(Date.now() - daysBack * 24 * 3600 * 1000);
  const to = new Date(Date.now() + 24 * 3600 * 1000);
  const url = `${SCOREBOARD_URL}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`ESPN scoreboard ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { events?: EspnEvent[] };

  const finals: EspnFinalScore[] = [];
  for (const ev of data.events ?? []) {
    const comp = ev.competitions?.[0];
    const status = comp?.status?.type;
    if (!ev.id || !status?.completed || status.state !== "post") continue;
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const hs = Number(home.score);
    const as = Number(away.score);
    if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;
    finals.push({
      espn_id: ev.id,
      home_team: home.team.displayName,
      away_team: away.team.displayName,
      home_score: hs,
      away_score: as,
      corners_home: intStat(home, "wonCorners"),
      corners_away: intStat(away, "wonCorners"),
    });
  }
  return finals;
}

// Total cards (yellow + red across both teams) from the match box score —
// the definition the ou_cards market uses. Returns null when the box score
// doesn't carry all four card stats, so callers leave those bets pending.
export async function fetchEspnCards(eventId: string): Promise<number | null> {
  const res = await fetch(`${SUMMARY_URL}?event=${eventId}`, { cache: "no-store" });
  if (!res.ok) return null;
  const data = (await res.json()) as {
    boxscore?: { teams?: { statistics?: EspnStatistic[] }[] };
  };
  const teams = data.boxscore?.teams ?? [];
  let total = 0;
  let found = 0;
  for (const t of teams) {
    for (const s of t.statistics ?? []) {
      if (s.name !== "yellowCards" && s.name !== "redCards") continue;
      const n = Number(s.displayValue);
      if (!Number.isInteger(n) || n < 0) return null;
      total += n;
      found++;
    }
  }
  return found === 4 ? total : null;
}
