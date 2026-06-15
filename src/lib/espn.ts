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
interface EspnOddsSide {
  open?: { odds?: string };
  close?: { odds?: string };
}
interface EspnEvent {
  id?: string;
  date?: string;
  competitions?: {
    date?: string;
    status?: {
      clock?: number; // elapsed seconds (e.g. 5400 at full time)
      displayClock?: string; // running game clock, e.g. "67'"
      type?: { state?: string; completed?: boolean; shortDetail?: string };
    };
    competitors?: EspnCompetitor[];
    odds?: {
      moneyline?: { home?: EspnOddsSide; away?: EspnOddsSide; draw?: EspnOddsSide };
    }[];
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

// American moneyline ("+250", "-120", "EVEN") → decimal odds ×1000.
function americanToDecimal(odds: string | undefined): number | null {
  if (!odds) return null;
  const s = odds.trim().toUpperCase();
  if (s === "EVEN" || s === "PK") return 2000;
  const n = Number(s.replace("+", ""));
  if (!Number.isFinite(n) || n === 0) return null;
  const dec = n > 0 ? 1 + n / 100 : 1 + 100 / -n;
  return Math.max(1010, Math.min(200_000, Math.round(dec * 1000)));
}

export interface EspnOddsEvent {
  espn_id: string;
  home_team: string;
  away_team: string;
  kickoff: string;
  odds_home: number; // decimal x1000
  odds_draw: number;
  odds_away: number;
}

// 1X2 quotes (DraftKings via ESPN) for upcoming matches — the keyless odds
// source when no ODDS_API_KEY is configured. Events without a complete
// moneyline (e.g. knockout placeholders) are skipped.
export async function fetchEspnOdds(daysAhead = 45): Promise<EspnOddsEvent[]> {
  const from = new Date(Date.now() - 6 * 3600 * 1000);
  const to = new Date(Date.now() + daysAhead * 24 * 3600 * 1000);
  const url = `${SCOREBOARD_URL}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`ESPN scoreboard ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { events?: EspnEvent[] };

  const quotes: EspnOddsEvent[] = [];
  for (const ev of data.events ?? []) {
    const comp = ev.competitions?.[0];
    if (!ev.id || comp?.status?.type?.state !== "pre") continue;
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const kickoffMs = Date.parse(ev.date ?? comp.date ?? "");
    if (!Number.isFinite(kickoffMs)) continue;
    const ml = comp.odds?.[0]?.moneyline;
    const oh = americanToDecimal(ml?.home?.close?.odds ?? ml?.home?.open?.odds);
    const od = americanToDecimal(ml?.draw?.close?.odds ?? ml?.draw?.open?.odds);
    const oa = americanToDecimal(ml?.away?.close?.odds ?? ml?.away?.open?.odds);
    if (!oh || !od || !oa) continue;
    quotes.push({
      espn_id: ev.id,
      home_team: home.team.displayName,
      away_team: away.team.displayName,
      kickoff: new Date(kickoffMs).toISOString().replace(".000Z", "Z"),
      odds_home: oh,
      odds_draw: od,
      odds_away: oa,
    });
  }
  return quotes;
}

export interface EspnLiveScore {
  home_team: string;
  away_team: string;
  home_score: number;
  away_score: number;
  clock: string; // display label for the lobby: "71'", "HT", "FT"
  state: string; // ESPN match state: "pre" | "in" | "post"
  detail: string; // shortDetail, e.g. "HT", "FT", "2nd Half" — NOT a minute
  displayClock: string; // running clock string, e.g. "67'", "45'+2"
  clockSeconds: number | null; // elapsed seconds when the feed provides it
}

// Matches currently being played (state "in") or just ended but not yet
// settled (state "post"), with the match clock — feeds the lobby's live
// score display.
export async function fetchEspnLiveScores(): Promise<EspnLiveScore[]> {
  const from = new Date(Date.now() - 24 * 3600 * 1000);
  const to = new Date(Date.now() + 24 * 3600 * 1000);
  const url = `${SCOREBOARD_URL}?dates=${yyyymmdd(from)}-${yyyymmdd(to)}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`ESPN scoreboard ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { events?: EspnEvent[] };

  const live: EspnLiveScore[] = [];
  for (const ev of data.events ?? []) {
    const comp = ev.competitions?.[0];
    const status = comp?.status;
    const state = status?.type?.state;
    if (state !== "in" && state !== "post") continue;
    const home = comp?.competitors?.find((c) => c.homeAway === "home");
    const away = comp?.competitors?.find((c) => c.homeAway === "away");
    if (!home?.team?.displayName || !away?.team?.displayName) continue;
    const hs = Number(home.score);
    const as = Number(away.score);
    if (!Number.isInteger(hs) || !Number.isInteger(as)) continue;
    const detail = status?.type?.shortDetail ?? "";
    const displayClock = status?.displayClock ?? "";
    const clockSeconds =
      typeof status?.clock === "number" && Number.isFinite(status.clock)
        ? status.clock
        : null;
    live.push({
      home_team: home.team.displayName,
      away_team: away.team.displayName,
      home_score: hs,
      away_score: as,
      clock: state === "post" ? "FT" : detail || displayClock || "LIVE",
      state: state ?? "",
      detail,
      displayClock,
      clockSeconds,
    });
  }
  return live;
}

// Total cards across both teams from the match box score, with a red worth
// two yellows (yellow = 1, red = 2) — the definition the ou_cards market
// uses. Returns null when the box score doesn't carry all four card stats,
// so callers leave those bets pending.
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
      total += s.name === "redCards" ? 2 * n : n;
      found++;
    }
  }
  return found === 4 ? total : null;
}
