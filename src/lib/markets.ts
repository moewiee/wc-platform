import type { Match, MarketType } from "./types";
import { db } from "./db";

// All offered markets come from REAL bookmaker quotes (odds-api.io / Bet365),
// stored in the market_odds table by the odds sync. There is NO model-derived
// pricing: a market is offered only when the bookmaker actually quotes it,
// pre-match and in-play alike. The 1X2 anchor falls back to the stored real
// 1X2 (DraftKings via ESPN, or The Odds API) pre-match when the bookmaker
// hasn't posted its moneyline yet; in-play 1X2 comes only from the live
// moneyline. Settlement (settleSelection) is purely a function of the final
// result, so an in-play bet settles identically to the same pre-match
// selection.
//
// modelForMatch (a Poisson fit of the de-margined 1X2) remains ONLY to power
// the statistical "expert tips" personas — it never prices an offered market.

export interface MarketSelection {
  selection: string;
  label: string;
  odds: number; // x1000
}

export interface MatchMarket {
  market: MarketType;
  name: string;
  line: number | null;
  selections: MarketSelection[];
}

export interface ResultData {
  homeScore: number;
  awayScore: number;
  cornersHome: number | null;
  cornersAway: number | null;
  cardsTotal: number | null;
}

export type SettleOutcome =
  | "win"
  | "lose"
  | "push"
  | "half_win"
  | "half_lose"
  | "pending";

const MAX_GOALS = 10; // Poisson truncation for the tips model fit
export const CS_GRID = 4; // correct-score grid covers 0-0 .. 4-4
// Pre-match quotes are usable for hours; in-play quotes go stale in minutes
// (and stale ⇒ in-play betting suspends, see live.ts).
const REAL_FRESH_MS = 6 * 60 * 60 * 1000;
const LIVE_QUOTE_FRESH_MS = 3 * 60 * 1000;

// ── Tips model (Poisson fit of the 1X2 — NOT used to price any market) ───────

function poissonRow(lambda: number, max: number): number[] {
  const row = new Array<number>(max + 1);
  let p = Math.exp(-lambda);
  row[0] = p;
  for (let k = 1; k <= max; k++) {
    p = (p * lambda) / k;
    row[k] = p;
  }
  return row;
}

const fitCache = new Map<string, { lh: number; la: number }>();

function fitLambdas(ph: number, pd: number, pa: number): { lh: number; la: number } {
  const key = `${ph.toFixed(4)}|${pd.toFixed(4)}|${pa.toFixed(4)}`;
  const cached = fitCache.get(key);
  if (cached) return cached;

  const STEPS: number[] = [];
  for (let l = 0.15; l <= 4.0001; l += 0.05) STEPS.push(l);
  const rows = STEPS.map((l) => poissonRow(l, MAX_GOALS));

  let best = { lh: 1.3, la: 1.1 };
  let bestErr = Infinity;
  for (let a = 0; a < STEPS.length; a++) {
    for (let b = 0; b < STEPS.length; b++) {
      let win = 0;
      let draw = 0;
      for (let i = 0; i <= MAX_GOALS; i++) {
        for (let j = 0; j <= MAX_GOALS; j++) {
          const p = rows[a][i] * rows[b][j];
          if (i > j) win += p;
          else if (i === j) draw += p;
        }
      }
      const err =
        (win - ph) * (win - ph) +
        (draw - pd) * (draw - pd) +
        (1 - win - draw - pa) * (1 - win - draw - pa);
      if (err < bestErr) {
        bestErr = err;
        best = { lh: STEPS[a], la: STEPS[b] };
      }
    }
  }
  fitCache.set(key, best);
  return best;
}

export function modelForMatch(
  match: Match
): { lh: number; la: number; ph: number; pd: number; pa: number } | null {
  if (!match.odds_home || !match.odds_draw || !match.odds_away) return null;
  const rh = 1000 / match.odds_home;
  const rd = 1000 / match.odds_draw;
  const ra = 1000 / match.odds_away;
  const total = rh + rd + ra;
  const ph = rh / total;
  const pd = rd / total;
  const pa = ra / total;
  const { lh, la } = fitLambdas(ph, pd, pa);
  return { lh, la, ph, pd, pa };
}

// ── Real bookmaker quotes → markets ──────────────────────────────────────────

interface RealQuote {
  market: MarketType;
  line: number | null;
  selection: string;
  odds: number;
}

// Quotes fresher than maxAgeMs for the given source (live vs pre-match),
// grouped by market. Stale rows are dropped, so a market with no fresh rows
// simply isn't offered (in-play this is what makes betting suspend when the
// live feed stops updating). The in_play filter guarantees the live sheet
// never reads a pre-match row (a stale pre-match price must never price a live
// bet) and vice-versa.
function loadRealQuotes(
  matchId: number,
  maxAgeMs: number,
  inPlay: boolean
): Map<MarketType, RealQuote[]> {
  const rows = db
    .prepare(
      "SELECT market, line, selection, odds, updated_at FROM market_odds WHERE match_id = ? AND in_play = ?"
    )
    .all(matchId, inPlay ? 1 : 0) as (RealQuote & { updated_at: string })[];
  const grouped = new Map<MarketType, RealQuote[]>();
  for (const r of rows) {
    if (Date.now() - Date.parse(r.updated_at) > maxAgeMs) continue;
    const list = grouped.get(r.market) ?? [];
    list.push({ market: r.market, line: r.line, selection: r.selection, odds: r.odds });
    grouped.set(r.market, list);
  }
  return grouped;
}

function fmtLine(line: number): string {
  if (line === 0) return "0";
  return line > 0 ? `+${line}` : `${line}`;
}

function ahMarket(
  market: MarketType,
  title: string,
  match: Match,
  line: number,
  home: number,
  away: number
): MatchMarket {
  return {
    market,
    name: `${title} ${fmtLine(line)}`,
    line,
    selections: [
      { selection: "home", label: `${match.home_team} ${fmtLine(line)}`, odds: home },
      { selection: "away", label: `${match.away_team} ${fmtLine(-line)}`, odds: away },
    ],
  };
}

// Coherent real AH pairs keyed by home-handicap line. The feed labels lines
// from the home perspective (home odds at line L is the home team +L), but
// which stored away line opposes a given home line depends on the source's
// sign convention: for some matches the away price for "home +L / away -L" is
// stored at line -L (cross), for others at line +L (same). We detect the
// convention by coherence — a real two-way AH book has an overround just above
// 1, so the wrong pairing (mixing two favourites, or a sub-1 book) is rejected.
function realAhPairs(
  rows: RealQuote[] | undefined
): Map<number, { home: number; away: number }> {
  const empty = new Map<number, { home: number; away: number }>();
  if (!rows?.length) return empty;
  const homeByLine = new Map<number, number>();
  const awayByLine = new Map<number, number>();
  for (const r of rows) {
    if (r.line === null) continue;
    if (r.selection === "home") homeByLine.set(r.line, r.odds);
    else if (r.selection === "away") awayByLine.set(r.line, r.odds);
  }
  const coherent = (home: number, away: number) => {
    const overround = 1000 / home + 1000 / away;
    return overround > 1.005 && overround < 1.2;
  };
  const build = (awayLineForHomeLine: (line: number) => number) => {
    const m = new Map<number, { home: number; away: number }>();
    for (const [line, home] of homeByLine) {
      const away = awayByLine.get(awayLineForHomeLine(line));
      if (away !== undefined && coherent(home, away)) m.set(line, { home, away });
    }
    return m;
  };
  const cross = build((line) => -line); // away for "home +L" stored at -L
  const same = build((line) => line); //  away for "home +L" stored at  L
  return cross.size >= same.size ? cross : same;
}

// Complete real over/under pairs keyed by line.
function realTotalsPairs(
  rows: RealQuote[] | undefined
): Map<number, { over: number; under: number }> {
  const byLine = new Map<number, { over?: number; under?: number }>();
  for (const r of rows ?? []) {
    if (r.line === null) continue;
    const e = byLine.get(r.line) ?? {};
    if (r.selection === "over" || r.selection === "under") e[r.selection] = r.odds;
    byLine.set(r.line, e);
  }
  const out = new Map<number, { over: number; under: number }>();
  for (const [line, e] of byLine) if (e.over && e.under) out.set(line, { over: e.over, under: e.under });
  return out;
}

function totalsPair(
  market: MarketType,
  title: string,
  line: number,
  over: number,
  under: number
): MatchMarket {
  return {
    market,
    name: `${title} ${line}`,
    line,
    selections: [
      { selection: "over", label: `Over ${line}`, odds: over },
      { selection: "under", label: `Under ${line}`, odds: under },
    ],
  };
}

const AH_FAMILIES: ReadonlyArray<readonly [MarketType, string]> = [
  ["ah_goals", "Asian Handicap"],
  ["ah_corners", "Corners Handicap"],
];
const OU_FAMILIES: ReadonlyArray<readonly [MarketType, string]> = [
  ["ou_goals", "Goals Over/Under"],
  ["ou_corners", "Corners Over/Under"],
  ["ou_cards", "Cards Over/Under"],
];

// Build a match's full market sheet from real quotes only. `maxAgeMs` gates
// quote freshness; `allowStoredH2h` lets the pre-match path fall back to the
// stored (real) 1X2 anchor when the bookmaker moneyline isn't quoted (never
// in-play — a stale pre-match 1X2 must not price a live bet).
function buildMarkets(
  match: Match,
  maxAgeMs: number,
  allowStoredH2h: boolean,
  inPlay: boolean
): MatchMarket[] {
  const real = loadRealQuotes(match.id, maxAgeMs, inPlay);
  const markets: MatchMarket[] = [];

  // 1X2 — bookmaker moneyline, else (pre-match only) the stored real anchor.
  const h2h = real.get("h2h");
  const hq = h2h?.find((r) => r.selection === "home")?.odds;
  const dq = h2h?.find((r) => r.selection === "draw")?.odds;
  const aq = h2h?.find((r) => r.selection === "away")?.odds;
  if (hq && dq && aq) {
    markets.push({
      market: "h2h",
      name: "Full Time Result (1X2)",
      line: null,
      selections: [
        { selection: "home", label: match.home_team, odds: hq },
        { selection: "draw", label: "Draw", odds: dq },
        { selection: "away", label: match.away_team, odds: aq },
      ],
    });
  } else if (allowStoredH2h && match.odds_home && match.odds_draw && match.odds_away) {
    markets.push({
      market: "h2h",
      name: "Full Time Result (1X2)",
      line: null,
      selections: [
        { selection: "home", label: match.home_team, odds: match.odds_home },
        { selection: "draw", label: "Draw", odds: match.odds_draw },
        { selection: "away", label: match.away_team, odds: match.odds_away },
      ],
    });
  }

  // Asian handicaps (goals, corners) — one market per quoted line, ascending.
  for (const [mkt, title] of AH_FAMILIES) {
    const lines = [...realAhPairs(real.get(mkt)).entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, p] of lines) markets.push(ahMarket(mkt, title, match, line, p.home, p.away));
  }

  // Totals (goals, corners, cards) — one market per quoted line, ascending.
  for (const [mkt, title] of OU_FAMILIES) {
    const lines = [...realTotalsPairs(real.get(mkt)).entries()].sort((a, b) => a[0] - b[0]);
    for (const [line, e] of lines) markets.push(totalsPair(mkt, title, line, e.over, e.under));
  }

  // Both teams to score.
  {
    const rows = real.get("btts");
    const yes = rows?.find((r) => r.selection === "yes")?.odds;
    const no = rows?.find((r) => r.selection === "no")?.odds;
    if (yes && no) {
      markets.push({
        market: "btts",
        name: "Both Teams To Score",
        line: null,
        selections: [
          { selection: "yes", label: "Yes", odds: yes },
          { selection: "no", label: "No", odds: no },
        ],
      });
    }
  }

  // Correct score — exactly the cells the bookmaker quotes (h-a keys).
  {
    const cells = (real.get("correct_score") ?? [])
      .filter((r) => /^\d+-\d+$/.test(r.selection))
      .sort((a, b) => {
        const [ah, aa] = a.selection.split("-").map(Number);
        const [bh, ba] = b.selection.split("-").map(Number);
        return ah + aa - (bh + ba) || ah - bh;
      })
      .map((r) => ({
        selection: r.selection,
        label: r.selection.replace("-", " - "),
        odds: r.odds,
      }));
    if (cells.length) {
      markets.push({ market: "correct_score", name: "Correct Score", line: null, selections: cells });
    }
  }

  return markets;
}

// Pre-match sheet: pre-match quotes only, lenient freshness, stored-1X2
// fallback allowed.
export function marketsForMatch(match: Match): MatchMarket[] {
  return buildMarkets(match, REAL_FRESH_MS, true, false);
}

// In-play sheet: live (in_play=1) quotes only, tight freshness (stale ⇒ empty ⇒
// suspended), live moneyline only for 1X2 (never the stale pre-match anchor).
export function liveMarketsForMatch(match: Match): MatchMarket[] {
  return buildMarkets(match, LIVE_QUOTE_FRESH_MS, false, true);
}

function findIn(
  markets: MatchMarket[],
  market: MarketType,
  line: number | null,
  selection: string
): { odds: number; label: string; marketName: string } | null {
  for (const m of markets) {
    if (m.market !== market) continue;
    if ((m.line === null) !== (line === null)) continue;
    if (m.line !== null && line !== null && Math.abs(m.line - line) > 1e-6) continue;
    const sel = m.selections.find((s) => s.selection === selection);
    if (sel) return { odds: sel.odds, label: `${m.name} · ${sel.label}`, marketName: m.name };
  }
  return null;
}

// Server-side re-price for a pre-match bet (never trust a client price).
export function findSelection(
  match: Match,
  market: MarketType,
  line: number | null,
  selection: string
): { odds: number; label: string; marketName: string } | null {
  return findIn(marketsForMatch(match), market, line, selection);
}

// Server-side re-price for an in-play bet against the fresh live sheet.
export function findLiveSelection(
  match: Match,
  market: MarketType,
  line: number | null,
  selection: string
): { odds: number; label: string; marketName: string } | null {
  return findIn(liveMarketsForMatch(match), market, line, selection);
}

// ── Settlement ──────────────────────────────────────────────────────────────

function halvesOf(line: number): [number, number] {
  // quarter lines split into the two adjacent half/integer lines
  return Math.round(line * 4) % 2 !== 0
    ? [line - 0.25, line + 0.25]
    : [line, line];
}

function ahHalfOutcome(margin: number): 1 | 0 | -1 {
  if (margin > 1e-9) return 1;
  if (margin < -1e-9) return -1;
  return 0;
}

function combineHalves(a: 1 | 0 | -1, b: 1 | 0 | -1): SettleOutcome {
  const sum = a + b;
  if (sum === 2) return "win";
  if (sum === 1) return "half_win";
  if (sum === 0) return a === 0 && b === 0 ? "push" : "lose"; // (+1,-1) cannot occur on adjacent lines
  if (sum === -1) return "half_lose";
  return "lose";
}

function settleAh(diff: number, line: number, selection: string): SettleOutcome {
  // `line` is the HOME handicap; away side gets the negation.
  const l = selection === "home" ? line : -line;
  const d = selection === "home" ? diff : -diff;
  const [l1, l2] = halvesOf(l);
  return combineHalves(ahHalfOutcome(d + l1), ahHalfOutcome(d + l2));
}

function settleTotals(total: number, line: number, selection: string): SettleOutcome {
  // Asian totals: integer line pushes on an exact hit, quarter line settles as
  // half stake on each adjacent line. Half lines behave as plain win/lose.
  const sign = selection === "over" ? 1 : -1;
  const [l1, l2] = halvesOf(line);
  return combineHalves(
    ahHalfOutcome((total - l1) * sign),
    ahHalfOutcome((total - l2) * sign)
  );
}

export function settleSelection(
  market: MarketType,
  line: number | null,
  selection: string,
  d: ResultData
): SettleOutcome {
  switch (market) {
    case "h2h": {
      const result =
        d.homeScore > d.awayScore ? "home" : d.homeScore < d.awayScore ? "away" : "draw";
      return selection === result ? "win" : "lose";
    }
    case "ah_goals":
      return settleAh(d.homeScore - d.awayScore, line ?? 0, selection);
    case "ou_goals":
      return settleTotals(d.homeScore + d.awayScore, line ?? 2.5, selection);
    case "ah_corners":
      if (d.cornersHome === null || d.cornersAway === null) return "pending";
      return settleAh(d.cornersHome - d.cornersAway, line ?? 0, selection);
    case "ou_corners":
      if (d.cornersHome === null || d.cornersAway === null) return "pending";
      return settleTotals(d.cornersHome + d.cornersAway, line ?? 9.5, selection);
    case "ou_cards":
      if (d.cardsTotal === null) return "pending";
      return settleTotals(d.cardsTotal, line ?? 4.5, selection);
    case "btts": {
      const both = d.homeScore > 0 && d.awayScore > 0;
      return (selection === "yes") === both ? "win" : "lose";
    }
    case "correct_score": {
      const inGrid = d.homeScore <= CS_GRID && d.awayScore <= CS_GRID;
      if (selection === "other_home")
        return !inGrid && d.homeScore > d.awayScore ? "win" : "lose";
      if (selection === "other_draw")
        return !inGrid && d.homeScore === d.awayScore ? "win" : "lose";
      if (selection === "other_away")
        return !inGrid && d.homeScore < d.awayScore ? "win" : "lose";
      return selection === `${d.homeScore}-${d.awayScore}` ? "win" : "lose";
    }
  }
}
