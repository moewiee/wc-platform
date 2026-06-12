import { setMeta } from "./db";

// Client for The Odds API v4 — https://the-odds-api.com
// Free tier: 500 credits/month. Odds call costs markets x regions credits,
// scores call with daysFrom costs 2. We throttle callers in matches.ts.
const API_BASE = "https://api.the-odds-api.com/v4";

export interface ApiOutcome {
  name: string;
  price: number;
}
export interface ApiMarket {
  key: string;
  outcomes: ApiOutcome[];
}
export interface ApiBookmaker {
  key: string;
  title: string;
  markets: ApiMarket[];
}
export interface ApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: ApiBookmaker[];
}
export interface ApiScoreEntry {
  name: string;
  score: string;
}
export interface ApiScore {
  id: string;
  commence_time: string;
  completed: boolean;
  home_team: string;
  away_team: string;
  scores: ApiScoreEntry[] | null;
}

function cfg() {
  return {
    key: process.env.ODDS_API_KEY?.trim() ?? "",
    sport: process.env.ODDS_API_SPORT_KEY?.trim() || "soccer_fifa_world_cup",
    regions: process.env.ODDS_API_REGIONS?.trim() || "eu",
  };
}

export function apiConfigured(): boolean {
  return cfg().key.length > 0;
}

export function apiSportKey(): string {
  return cfg().sport;
}

async function apiGet<T>(
  apiPath: string,
  params: Record<string, string>
): Promise<T> {
  const url = new URL(`${API_BASE}${apiPath}`);
  url.searchParams.set("apiKey", cfg().key);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { cache: "no-store" });
  const remaining = res.headers.get("x-requests-remaining");
  if (remaining !== null) setMeta("api_requests_remaining", remaining);
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Odds API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchOddsEvents(): Promise<ApiEvent[]> {
  const { sport, regions } = cfg();
  return apiGet<ApiEvent[]>(`/sports/${sport}/odds`, {
    regions,
    markets: "h2h",
    oddsFormat: "decimal",
    dateFormat: "iso",
  });
}

export async function fetchScores(daysFrom = 3): Promise<ApiScore[]> {
  const { sport } = cfg();
  return apiGet<ApiScore[]>(`/sports/${sport}/scores`, {
    daysFrom: String(daysFrom),
    dateFormat: "iso",
  });
}

// Median price across bookmakers for one side of the 1X2 market, as odds x1000.
export function consensusOdds(
  ev: ApiEvent,
  side: "home" | "draw" | "away"
): number | null {
  const target =
    side === "draw"
      ? "draw"
      : (side === "home" ? ev.home_team : ev.away_team).toLowerCase();
  const prices: number[] = [];
  for (const bm of ev.bookmakers ?? []) {
    const market = bm.markets?.find((m) => m.key === "h2h");
    const outcome = market?.outcomes?.find(
      (o) => o.name.toLowerCase() === target
    );
    if (outcome && typeof outcome.price === "number" && outcome.price > 1) {
      prices.push(outcome.price);
    }
  }
  if (prices.length === 0) return null;
  prices.sort((a, b) => a - b);
  const mid = prices.length >> 1;
  const median =
    prices.length % 2 === 1 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
  return Math.round(median * 1000);
}
