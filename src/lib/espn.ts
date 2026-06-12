// Keyless fallback score source: ESPN's public World Cup scoreboard JSON.
// Used by maybeSyncScores when no ODDS_API_KEY is configured. Final scores
// only — no odds, no corners/cards (those bets stay pending for the admin).
const SCOREBOARD_URL =
  "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";

export interface EspnFinalScore {
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
}

interface EspnCompetitor {
  homeAway?: string;
  score?: string;
  team?: { displayName?: string };
}
interface EspnEvent {
  competitions?: {
    status?: { type?: { state?: string; completed?: boolean } };
    competitors?: EspnCompetitor[];
  }[];
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
    if (!status?.completed || status.state !== "post") continue;
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const hs = Number(home.score);
    const as = Number(away.score);
    if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;
    finals.push({
      home_team: home.team.displayName,
      away_team: away.team.displayName,
      home_score: hs,
      away_score: as,
    });
  }
  return finals;
}
