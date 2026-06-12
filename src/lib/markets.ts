import type { Match, MarketType } from "./types";

// Derives all betting markets from a match's 1X2 odds via a Poisson goal
// model. Markets are computed on the fly (deterministic for given odds), so
// they move automatically whenever the anchor 1X2 odds refresh. Odds are
// decimal x1000 integers throughout.

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
const CS_GRID = 4; // correct score grid covers 0-0 .. 4-4

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

  const model = modelForMatch(match);
  if (!model) return markets;
  const { lh, la } = model;

  const goals = scoreMatrix(lh, la, MAX_GOALS);

  // Asian handicap (goals) — auto-balanced line in quarter steps.
  {
    const candidates: number[] = [];
    for (let l = -3; l <= 3.0001; l += 0.25) candidates.push(Math.round(l * 4) / 4);
    const line = pickAhLine(goals, candidates);
    const oh = ahFairOdds(goals, line, "home");
    const oa = ahFairOdds(goals, -line, "away");
    if (oh && oa) {
      markets.push({
        market: "ah_goals",
        name: `Asian Handicap ${fmtLine(line)}`,
        line,
        selections: [
          { selection: "home", label: `${match.home_team} ${fmtLine(line)}`, odds: oh },
          { selection: "away", label: `${match.away_team} ${fmtLine(-line)}`, odds: oa },
        ],
      });
    }
  }

  // Goals over/under — quarter-step ladder around the expected total.
  {
    const totalDist = poissonRow(lh + la, MAX_GOALS * 2);
    const base = Math.max(1.5, Math.round(lh + la - 0.5) + 0.5);
    for (const line of quarterLadder(base)) {
      const m = totalsMarket("ou_goals", "Goals Over/Under", totalDist, line);
      if (m) markets.push(m);
    }
  }

  // Corners model: total scales with attacking intent, split with dominance.
  const cornersTotal = Math.min(13, Math.max(7.5, 8.5 + (lh + la) * 0.5));
  const share = Math.min(0.68, Math.max(0.32, 0.5 + (lh - la) * 0.07));
  const corners = scoreMatrix(cornersTotal * share, cornersTotal * (1 - share), MAX_CORNERS);

  // Asian handicap (corners) — quarter steps, like the goals handicap.
  {
    const candidates: number[] = [];
    for (let l = -6; l <= 6.0001; l += 0.25) candidates.push(Math.round(l * 4) / 4);
    const line = pickAhLine(corners, candidates);
    const oh = ahFairOdds(corners, line, "home");
    const oa = ahFairOdds(corners, -line, "away");
    if (oh && oa) {
      markets.push({
        market: "ah_corners",
        name: `Corners Handicap ${fmtLine(line)}`,
        line,
        selections: [
          { selection: "home", label: `${match.home_team} ${fmtLine(line)}`, odds: oh },
          { selection: "away", label: `${match.away_team} ${fmtLine(-line)}`, odds: oa },
        ],
      });
    }
  }

  // Corners over/under — quarter-step ladder.
  {
    const dist = poissonRow(cornersTotal, MAX_CORNERS * 2);
    const base = Math.round(cornersTotal - 0.5) + 0.5;
    for (const line of quarterLadder(base)) {
      const m = totalsMarket("ou_corners", "Corners Over/Under", dist, line);
      if (m) markets.push(m);
    }
  }

  // Cards over/under (yellow = 1, red = 2; flat expectation).
  {
    const cardsTotal = 4.2;
    const dist = poissonRow(cardsTotal, 20);
    for (const line of [3.5, 4.5, 5.5]) {
      const m = totalsMarket("ou_cards", "Cards Over/Under", dist, line);
      if (m) markets.push(m);
    }
  }

  // Correct score: 0-0 .. 4-4 grid plus "any other" buckets.
  {
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
          odds: probsToOdds(goals[i][j], CS_MARGIN),
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
