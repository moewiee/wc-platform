import type { Match, MarketType } from "./types";
import { db } from "./db";

// Derives all betting markets from a match's 1X2 odds via a Poisson goal
// model. Markets are computed on the fly (deterministic for given odds), so
// they move automatically whenever the anchor 1X2 odds refresh. Odds are
// decimal x1000 integers throughout.
//
// When the odds-api.io sync has stored fresh bookmaker quotes for a match
// (market_odds table), those take precedence: line markets adopt the
// bookmaker's lines wholesale (settlement is parametric in the line), the
// correct-score grid overlays per cell, and anything unquoted falls back to
// the model. Settlement semantics never change with the price source.

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

const MARGIN = 1.06; // bookmaker overround applied to model probabilities
const CS_MARGIN = 1.1;
const MAX_GOALS = 10;
const MAX_CORNERS = 24;
export const CS_GRID = 4; // correct score grid covers 0-0 .. 4-4

// ── Poisson machinery ───────────────────────────────────────────────────────

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

function probsToOdds(p: number, margin = MARGIN): number {
  const odds = 1 / Math.min(0.985, p * margin);
  return Math.max(1010, Math.min(200_000, Math.round(odds * 1000)));
}

// Fit home/away goal expectancies to the de-margined 1X2 probabilities.
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

function scoreMatrix(lh: number, la: number, max: number): number[][] {
  const hr = poissonRow(lh, max);
  const ar = poissonRow(la, max);
  return hr.map((p) => ar.map((q) => p * q));
}

// ── Asian handicap helpers ──────────────────────────────────────────────────

function halvesOf(line: number): [number, number] {
  // quarter lines split into the two adjacent half/integer lines
  return Math.round(line * 4) % 2 !== 0
    ? [line - 0.25, line + 0.25]
    : [line, line];
}

// Win-probability mass W and refund mass R for one side of an AH market over
// a (home, away) count matrix. `line` is from the chosen side's perspective.
function ahWR(
  matrix: number[][],
  line: number,
  side: "home" | "away"
): { W: number; R: number } {
  const halves = halvesOf(line);
  let W = 0;
  let R = 0;
  for (const l of halves) {
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        const diff = side === "home" ? i - j : j - i;
        const m = diff + l;
        if (m > 1e-9) W += matrix[i][j] / 2;
        else if (Math.abs(m) <= 1e-9) R += matrix[i][j] / 2;
      }
    }
  }
  return { W, R };
}

function ahFairOdds(matrix: number[][], line: number, side: "home" | "away"): number | null {
  const { W, R } = ahWR(matrix, line, side);
  if (W < 0.02) return null;
  const fair = (1 - R) / W;
  const priced = fair / MARGIN;
  if (priced <= 1.01) return null;
  return Math.max(1010, Math.min(200_000, Math.round(priced * 1000)));
}

// Pick the line that best balances the two sides.
function pickAhLine(matrix: number[][], candidates: number[]): number {
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const line of candidates) {
    const oh = ahFairOdds(matrix, line, "home");
    const oa = ahFairOdds(matrix, -line, "away");
    if (oh === null || oa === null) continue;
    const diff = Math.abs(oh - oa);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = line;
    }
  }
  return best;
}

function fmtLine(line: number): string {
  if (line === 0) return "0";
  return line > 0 ? `+${line}` : `${line}`;
}

// ── Market generation ───────────────────────────────────────────────────────

// Asian totals: integer lines push when total == line, quarter lines split
// into the two adjacent half/integer lines (same W/R treatment as handicaps).
function totalsFairOdds(
  dist: number[],
  line: number,
  side: "over" | "under",
  margin: number
): number | null {
  const halves = halvesOf(line);
  let W = 0;
  let R = 0;
  for (const l of halves) {
    for (let k = 0; k < dist.length; k++) {
      const m = side === "over" ? k - l : l - k;
      if (m > 1e-9) W += dist[k] / 2;
      else if (Math.abs(m) <= 1e-9) R += dist[k] / 2;
    }
  }
  if (W < 0.02) return null;
  const priced = (1 - R) / W / margin;
  if (priced <= 1.01) return null;
  return Math.max(1010, Math.min(200_000, Math.round(priced * 1000)));
}

function totalsMarket(
  market: MarketType,
  name: string,
  dist: number[],
  line: number,
  margin = MARGIN
): MatchMarket | null {
  const over = totalsFairOdds(dist, line, "over", margin);
  const under = totalsFairOdds(dist, line, "under", margin);
  if (over === null || under === null) return null;
  return {
    market,
    name: `${name} ${line}`,
    line,
    selections: [
      { selection: "over", label: `Over ${line}`, odds: over },
      { selection: "under", label: `Under ${line}`, odds: under },
    ],
  };
}

// base-1 .. base+1 in quarter steps (base is a half line, so the ladder mixes
// integer, quarter and half lines).
function quarterLadder(base: number): number[] {
  const lines: number[] = [];
  for (let l = base - 1; l <= base + 1.0001; l += 0.25) {
    lines.push(Math.round(l * 4) / 4);
  }
  return lines;
}

// ── Real bookmaker odds overlay ─────────────────────────────────────────────

interface RealQuote {
  market: MarketType;
  line: number | null;
  selection: string;
  odds: number;
}

// If the 10-minute sync has been dead this long, fresh model prices beat
// stale bookmaker prices.
const REAL_FRESH_MS = 6 * 60 * 60 * 1000;

function loadRealQuotes(matchId: number): Map<MarketType, RealQuote[]> {
  const rows = db
    .prepare(
      "SELECT market, line, selection, odds, updated_at FROM market_odds WHERE match_id = ?"
    )
    .all(matchId) as (RealQuote & { updated_at: string })[];
  const grouped = new Map<MarketType, RealQuote[]>();
  for (const r of rows) {
    if (Date.now() - Date.parse(r.updated_at) > REAL_FRESH_MS) continue;
    const list = grouped.get(r.market) ?? [];
    list.push({ market: r.market, line: r.line, selection: r.selection, odds: r.odds });
    grouped.set(r.market, list);
  }
  return grouped;
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

function modelAhOdds(
  matrix: number[][],
  line: number
): { home: number; away: number } | null {
  const home = ahFairOdds(matrix, line, "home");
  const away = ahFairOdds(matrix, -line, "away");
  return home && away ? { home, away } : null;
}

// Ladders span LADDER_HALF levels each side of the main (most balanced) line —
// 2 above, 2 below — and recenter whenever the main line moves.
const LADDER_HALF = 2;
const AH_STEP = 0.25;

// AH ladder centered on the most balanced line (home/away odds closest): the
// bookmaker's when real prices exist, else the model's auto-balanced line. Each
// step is the real price where quoted and the model price otherwise.
function ahLadder(
  matrix: number[][],
  rows: RealQuote[] | undefined,
  market: MarketType,
  title: string,
  match: Match,
  candidates: number[]
): MatchMarket[] {
  const real = realAhPairs(rows);
  let center: number | null = null;
  if (real.size) {
    let bestGap = Infinity;
    for (const [line, p] of real) {
      const gap = Math.abs(p.home - p.away);
      if (gap < bestGap) {
        bestGap = gap;
        center = line;
      }
    }
  } else {
    center = pickAhLine(matrix, candidates);
  }
  if (center === null) return [];
  const out: MatchMarket[] = [];
  for (let i = -LADDER_HALF; i <= LADDER_HALF; i++) {
    const line = Math.round((center + i * AH_STEP) * 100) / 100;
    const odds = real.get(line) ?? modelAhOdds(matrix, line);
    if (odds) out.push(ahMarket(market, title, match, line, odds.home, odds.away));
  }
  return out;
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

// Over/under ladder centered on the most balanced line (over/under odds
// closest): the bookmaker's when real prices exist, else the model's. Each step
// (`step` apart) is the real price where quoted and the model price otherwise.
function totalsLadder(
  dist: number[],
  rows: RealQuote[] | undefined,
  market: MarketType,
  title: string,
  candidates: number[],
  step: number
): MatchMarket[] {
  const real = realTotalsPairs(rows);
  let center: number | null = null;
  if (real.size) {
    let bestGap = Infinity;
    for (const [line, e] of real) {
      const gap = Math.abs(e.over - e.under);
      if (gap < bestGap) {
        bestGap = gap;
        center = line;
      }
    }
  } else {
    let bestGap = Infinity;
    for (const line of candidates) {
      const m = totalsMarket(market, title, dist, line);
      if (!m) continue;
      const gap = Math.abs(m.selections[0].odds - m.selections[1].odds);
      if (gap < bestGap) {
        bestGap = gap;
        center = line;
      }
    }
  }
  if (center === null) return [];
  center = Math.round(center / step) * step;
  const out: MatchMarket[] = [];
  for (let i = -LADDER_HALF; i <= LADDER_HALF; i++) {
    const line = Math.round((center + i * step) * 100) / 100;
    if (line <= 0) continue;
    const r = real.get(line);
    if (r) out.push(totalsPair(market, title, line, r.over, r.under));
    else {
      const m = totalsMarket(market, title, dist, line);
      if (m) out.push(m);
    }
  }
  return out;
}

export function marketsForMatch(match: Match): MatchMarket[] {
  const markets: MatchMarket[] = [];

  // 1X2 — the anchor market, straight from stored odds.
  if (match.odds_home && match.odds_draw && match.odds_away) {
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

  const real = loadRealQuotes(match.id);

  const model = modelForMatch(match);
  if (!model) return markets;
  const { lh, la } = model;

  const goals = scoreMatrix(lh, la, MAX_GOALS);

  // Asian handicap (goals) — main line ±2 levels.
  {
    const candidates: number[] = [];
    for (let l = -3; l <= 3.0001; l += 0.25) candidates.push(Math.round(l * 4) / 4);
    markets.push(...ahLadder(goals, real.get("ah_goals"), "ah_goals", "Asian Handicap", match, candidates));
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
    } else {
      let both = 0;
      for (let i = 1; i <= MAX_GOALS; i++) {
        for (let j = 1; j <= MAX_GOALS; j++) both += goals[i][j];
      }
      const noProb = Math.max(0, 1 - both);
      if (both >= 0.02 && noProb >= 0.02) {
        markets.push({
          market: "btts",
          name: "Both Teams To Score",
          line: null,
          selections: [
            { selection: "yes", label: "Yes", odds: probsToOdds(both) },
            { selection: "no", label: "No", odds: probsToOdds(noProb) },
          ],
        });
      }
    }
  }

  // Goals over/under — main line ±2 levels around the expected total.
  {
    const totalDist = poissonRow(lh + la, MAX_GOALS * 2);
    const base = Math.max(1.5, Math.round(lh + la - 0.5) + 0.5);
    markets.push(...totalsLadder(totalDist, real.get("ou_goals"), "ou_goals", "Goals Over/Under", quarterLadder(base), 0.25));
  }

  // Corners model: total scales with attacking intent, split with dominance.
  const cornersTotal = Math.min(13, Math.max(7.5, 8.5 + (lh + la) * 0.5));
  const share = Math.min(0.68, Math.max(0.32, 0.5 + (lh - la) * 0.07));
  const corners = scoreMatrix(cornersTotal * share, cornersTotal * (1 - share), MAX_CORNERS);

  // Asian handicap (corners) — main line ±2 levels.
  {
    const candidates: number[] = [];
    for (let l = -6; l <= 6.0001; l += 0.25) candidates.push(Math.round(l * 4) / 4);
    markets.push(...ahLadder(corners, real.get("ah_corners"), "ah_corners", "Corners Handicap", match, candidates));
  }

  // Corners over/under — main line ±2 levels.
  {
    const dist = poissonRow(cornersTotal, MAX_CORNERS * 2);
    const base = Math.round(cornersTotal - 0.5) + 0.5;
    markets.push(...totalsLadder(dist, real.get("ou_corners"), "ou_corners", "Corners Over/Under", quarterLadder(base), 0.25));
  }

  // Cards over/under (yellow = 1, red = 2; flat expectation when no quotes) —
  // main line ±2 levels on half-point steps.
  {
    const cardsTotal = 4.2;
    const dist = poissonRow(cardsTotal, 20);
    markets.push(...totalsLadder(dist, real.get("ou_cards"), "ou_cards", "Cards Over/Under", [2.5, 3.5, 4.5, 5.5, 6.5], 0.5));
  }

  // Correct score: 0-0 .. 4-4 grid plus "any other" buckets. Bookmaker odds
  // overlay per cell; the buckets stay model-priced (a bookmaker's "any
  // other" covers a different score set than our grid, so its price would
  // settle wrong here).
  {
    const csReal = new Map(
      (real.get("correct_score") ?? []).map((r) => [r.selection, r.odds])
    );
    const selections: MarketSelection[] = [];
    let otherHome = 0;
    let otherDraw = 0;
    let otherAway = 0;
    for (let i = 0; i <= MAX_GOALS; i++) {
      for (let j = 0; j <= MAX_GOALS; j++) {
        const p = goals[i][j];
        if (i <= CS_GRID && j <= CS_GRID) continue;
        if (i > j) otherHome += p;
        else if (i === j) otherDraw += p;
        else otherAway += p;
      }
    }
    for (let i = 0; i <= CS_GRID; i++) {
      for (let j = 0; j <= CS_GRID; j++) {
        selections.push({
          selection: `${i}-${j}`,
          label: `${i} - ${j}`,
          odds: csReal.get(`${i}-${j}`) ?? probsToOdds(goals[i][j], CS_MARGIN),
        });
      }
    }
    selections.push(
      { selection: "other_home", label: `Any other ${match.home_team} win`, odds: probsToOdds(otherHome, CS_MARGIN) },
      { selection: "other_draw", label: "Any other draw", odds: probsToOdds(otherDraw, CS_MARGIN) },
      { selection: "other_away", label: `Any other ${match.away_team} win`, odds: probsToOdds(otherAway, CS_MARGIN) }
    );
    markets.push({
      market: "correct_score",
      name: "Correct Score",
      line: null,
      selections,
    });
  }

  return markets;
}

export function findSelection(
  match: Match,
  market: MarketType,
  line: number | null,
  selection: string
): { odds: number; label: string; marketName: string } | null {
  for (const m of marketsForMatch(match)) {
    if (m.market !== market) continue;
    if (m.line === null !== (line === null)) continue;
    if (m.line !== null && line !== null && Math.abs(m.line - line) > 1e-6) continue;
    const sel = m.selections.find((s) => s.selection === selection);
    if (sel) return { odds: sel.odds, label: `${m.name} · ${sel.label}`, marketName: m.name };
  }
  return null;
}

// ── Settlement ──────────────────────────────────────────────────────────────

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
