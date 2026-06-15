// Real bookmaker odds for the derived markets via odds-api.io (keyed; free
// tier allows 100 requests/hour). Distinct from The Odds API (odds-api.ts):
// this source quotes per-market lines (AH ladders, totals, BTTS, correct
// score, corners, cards) which overlay the Poisson model in markets.ts.
// A single bookmaker keeps quotes coherent across markets.
import type { MarketType } from "./types";
import { CS_GRID } from "./markets";

const BASE = "https://api.odds-api.io/v3";
const LEAGUE = "international-fifa-world-cup";
const BOOKMAKER = "Bet365";

// ODDS_API_IO_KEY may hold several comma-separated keys (e.g. multiple free
// accounts): we round-robin across them and fail over on rate-limit so their
// quotas add up. Only multiplies the limit if odds-api.io meters per key.
function oioKeys(): string[] {
  return (process.env.ODDS_API_IO_KEY ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export function oioConfigured(): boolean {
  return oioKeys().length > 0;
}

// Round-robin cursor across the configured keys (module-scoped, best-effort).
let keyCursor = 0;

function isQuotaError(msg: string): boolean {
  return /rate|limit|quota|exceed|too many/i.test(msg);
}

// GET `url` (which must NOT include apiKey — it's appended here) as JSON,
// rotating keys per call and failing over to the next key on a rate-limit
// (HTTP 429 or a quota-style 200 {error}). Throws on a real domain error or
// when every key is exhausted.
async function getJson(url: string): Promise<unknown> {
  const keys = oioKeys();
  if (keys.length === 0) throw new Error("ODDS_API_IO_KEY is not configured");
  const sep = url.includes("?") ? "&" : "?";
  let lastErr: unknown;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(keyCursor + i) % keys.length];
    const res = await fetch(`${url}${sep}apiKey=${encodeURIComponent(key)}`, {
      cache: "no-store",
    });
    const body = await res.text();
    if (res.status === 429) {
      lastErr = new Error(`odds-api.io 429 (rate limited): ${body.slice(0, 120)}`);
      continue; // try the next key
    }
    if (!res.ok) throw new Error(`odds-api.io ${res.status}: ${body.slice(0, 200)}`);
    const data: unknown = JSON.parse(body);
    // The API reports domain errors (bad league/bookmaker) with HTTP 200; a
    // quota-style message there is also a reason to fail over.
    if (data && typeof data === "object" && "error" in data) {
      const msg = String((data as { error: string }).error);
      if (isQuotaError(msg) && i < keys.length - 1) {
        lastErr = new Error(`odds-api.io: ${msg}`);
        continue;
      }
      throw new Error(`odds-api.io: ${msg}`);
    }
    keyCursor = (keyCursor + i + 1) % keys.length; // spread the next call onward
    return data;
  }
  throw lastErr ?? new Error("odds-api.io: all keys rate limited");
}

export interface OioEvent {
  id: number;
  home: string;
  away: string;
  date: string;
}

export async function fetchOioEvents(): Promise<OioEvent[]> {
  const data = await getJson(
    `${BASE}/events?sport=football&league=${LEAGUE}&status=pending&limit=200`
  );
  return (Array.isArray(data) ? data : []) as OioEvent[];
}

// Currently in-play World Cup events — for mapping live matches whose
// oio_event_id wasn't set during the pre-match pass. Same shape as above.
export async function fetchOioLiveEvents(): Promise<OioEvent[]> {
  const data = await getJson(
    `${BASE}/events?sport=football&league=${LEAGUE}&status=live&limit=50`
  );
  return (Array.isArray(data) ? data : []) as OioEvent[];
}

export interface OioQuote {
  market: MarketType;
  line: number | null;
  selection: string;
  odds: number; // decimal x1000
}

// Feed market name → our market family. Alternative ladders are listed
// before the bookmaker's main line so the main line wins on the same hdp.
const AH_SOURCES: ReadonlyArray<readonly [string, MarketType]> = [
  ["Alternative Asian Handicap", "ah_goals"],
  ["Spread", "ah_goals"],
  ["Corners Spread", "ah_corners"],
];
const OU_SOURCES: ReadonlyArray<readonly [string, MarketType]> = [
  ["Alternative Total Goals", "ou_goals"],
  ["Totals", "ou_goals"],
  ["Alternative Corners", "ou_corners"],
  ["Corners Totals", "ou_corners"],
  ["Bookings Totals", "ou_cards"],
];

// Odds come back as decimal strings ("1.850"); store as x1000 integers.
function dec(v: unknown): number | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const odds = Math.round(parseFloat(String(v)) * 1000);
  if (!Number.isFinite(odds) || odds <= 1000 || odds > 9_999_000) return null;
  return odds;
}

type OioMarket = { name?: string; odds?: Record<string, unknown>[] };

export function parseOioMarkets(feedMarkets: OioMarket[]): OioQuote[] {
  const byName = new Map<string, OioMarket>();
  for (const m of feedMarkets) if (m?.name) byName.set(m.name, m);
  // Keyed so later sources overwrite earlier ones on the same line.
  const out = new Map<string, OioQuote>();
  const put = (q: OioQuote) => out.set(`${q.market}|${q.line}|${q.selection}`, q);

  // Match result (1X2) from the bookmaker's moneyline. Same {home,draw,away}
  // shape pre-match and in-play, so this is the live 1X2 source too.
  for (const e of byName.get("ML")?.odds ?? []) {
    const home = dec(e.home);
    const draw = dec(e.draw);
    const away = dec(e.away);
    if (home === null || draw === null || away === null) continue;
    put({ market: "h2h", line: null, selection: "home", odds: home });
    put({ market: "h2h", line: null, selection: "draw", odds: draw });
    put({ market: "h2h", line: null, selection: "away", odds: away });
  }

  for (const [src, market] of AH_SOURCES) {
    for (const e of byName.get(src)?.odds ?? []) {
      const line = typeof e.hdp === "number" ? e.hdp : null; // home handicap
      // Spread/Corners Spread quote the two sides as over/under (over = the
      // home team covering the handicap, under = the away side); some books
      // label them home/away instead — accept either shape.
      const home = dec(e.home) ?? dec(e.over);
      const away = dec(e.away) ?? dec(e.under);
      if (line === null || home === null || away === null) continue;
      put({ market, line, selection: "home", odds: home });
      put({ market, line, selection: "away", odds: away });
    }
  }
  for (const [src, market] of OU_SOURCES) {
    for (const e of byName.get(src)?.odds ?? []) {
      const line = typeof e.hdp === "number" ? e.hdp : null;
      const over = dec(e.over);
      const under = dec(e.under);
      if (line === null || over === null || under === null) continue;
      // Booking-points lines (30.5, 50, …) are a different proposition from
      // card counts; only card-count-sized lines settle against cards_total.
      if (market === "ou_cards" && line > 15) continue;
      put({ market, line, selection: "over", odds: over });
      put({ market, line, selection: "under", odds: under });
    }
  }
  for (const e of byName.get("Both Teams To Score")?.odds ?? []) {
    const yes = dec(e.yes);
    const no = dec(e.no);
    if (yes === null || no === null) continue;
    put({ market: "btts", line: null, selection: "yes", odds: yes });
    put({ market: "btts", line: null, selection: "no", odds: no });
  }
  // Feed labels ("2-1") match our correct-score selection keys; scores
  // outside our 0-CS_GRID grid belong to the model's "any other" buckets.
  for (const e of byName.get("Correct Score")?.odds ?? []) {
    const m = typeof e.label === "string" ? e.label.match(/^(\d+)-(\d+)$/) : null;
    const odds = dec(e.odds);
    if (!m || odds === null) continue;
    const h = Number(m[1]);
    const a = Number(m[2]);
    if (h > CS_GRID || a > CS_GRID) continue;
    put({ market: "correct_score", line: null, selection: `${h}-${a}`, odds });
  }
  return [...out.values()];
}

// Batched odds: /odds/multi takes up to 10 event ids per request.
export async function fetchOioQuotes(
  eventIds: string[]
): Promise<Map<string, OioQuote[]>> {
  const result = new Map<string, OioQuote[]>();
  for (let i = 0; i < eventIds.length; i += 10) {
    const chunk = eventIds.slice(i, i + 10);
    const data = await getJson(
      `${BASE}/odds/multi?eventIds=${chunk.join(",")}` +
        `&bookmakers=${encodeURIComponent(BOOKMAKER)}`
    );
    for (const ev of (Array.isArray(data) ? data : []) as {
      id?: number;
      bookmakers?: Record<string, OioMarket[]>;
    }[]) {
      const markets = ev.bookmakers?.[BOOKMAKER];
      if (ev.id === undefined || !Array.isArray(markets)) continue;
      result.set(String(ev.id), parseOioMarkets(markets));
    }
  }
  return result;
}
