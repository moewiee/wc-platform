import { db, nowIso } from "./db";
import {
  findLiveSelection,
  findSelection,
  lockedOutcome,
  settleSelection,
  type ResultData,
  type SettleOutcome,
} from "./markets";
import {
  getConfirmedLiveScore,
  getLiveContext,
  getLiveContextSync,
  hasFreshLiveQuote,
  inPlayEnabled,
  refreshLiveObservations,
  type LiveContext,
} from "./live";
import { fetchEspnCards } from "./espn";
import {
  combineOddsX1000,
  fmtPts,
  halfLosePayout,
  halfWinPayout,
  MAX_INPLAY_STAKE_PER_MATCH_POINTS,
  MAX_PARLAY_LEGS,
  MAX_PARLAY_PAYOUT_POINTS,
  MAX_PARLAY_STAKE_POINTS,
  MAX_STAKE_PER_MATCH_POINTS,
  MIN_PARLAY_LEGS,
  MIN_STAKE_POINTS,
  parlayPayoutPoints,
  payoutPoints,
} from "./money";
import type {
  Bet,
  BetWithMatch,
  LegStatus,
  MarketType,
  Match,
  OpenBetRow,
  Parlay,
  ParlayLeg,
  ParlayLegWithMatch,
  ParlayStatus,
  ParlayWithLegs,
  Pick3,
} from "./types";

class BetError extends Error {}
// Thrown when an in-play price has moved materially against the bettor since
// they saw it; carries the fresh price so the UI can re-quote.
class RequoteError extends Error {
  constructor(message: string, readonly newOdds: number) {
    super(message);
  }
}

// Re-quote only when the fresh live price is more than this fraction WORSE for
// the bettor than the price they submitted. One-directional: any other move
// (including one in the bettor's favour) books at the genuine fresh price, so a
// bettor can't use the check to fish for a better-than-current price.
const INPLAY_ODDS_TOLERANCE = 0.02;

// Players can only cancel a bet within this window after placing it (and
// never once the match has kicked off).
export const CANCEL_WINDOW_MS = 30 * 60 * 1000;

function getBet(id: number): Bet | undefined {
  return db.prepare("SELECT * FROM bets WHERE id = ?").get(id) as
    | Bet
    | undefined;
}

// Adjust a user's balance and record the transaction. Must run inside a
// db.transaction so balance and ledger never diverge. A ledger row is tied to
// either a single bet (betId) or a parlay (parlayId), never both.
function applyBalanceChange(
  userId: number,
  amountPoints: number,
  type: string,
  betId: number | null,
  note: string,
  parlayId: number | null = null
): number {
  const row = db
    .prepare("SELECT balance_points FROM users WHERE id = ?")
    .get(userId) as { balance_points: number } | undefined;
  if (!row) throw new BetError("User not found.");
  const newBalance = row.balance_points + amountPoints;
  if (newBalance < 0) throw new BetError("Insufficient balance.");
  db.prepare("UPDATE users SET balance_points = ? WHERE id = ?").run(
    newBalance,
    userId
  );
  db.prepare(
    "INSERT INTO transactions (user_id, amount_points, balance_after_points, type, bet_id, parlay_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, amountPoints, newBalance, type, betId, parlayId, note, nowIso());
  return newBalance;
}

export interface PlaceBetResult {
  bet?: Bet;
  error?: string;
  newOdds?: number; // present on an in-play re-quote (×1000)
}

// Insert a priced bet and debit the stake. MUST run inside a db.transaction.
function recordBet(
  userId: number,
  match: Match,
  market: MarketType,
  line: number | null,
  selection: string,
  offer: { odds: number; label: string },
  stakePoints: number,
  inPlay: boolean,
  noteSuffix: string
): Bet {
  const payout = payoutPoints(stakePoints, offer.odds);
  const info = db
    .prepare(
      `INSERT INTO bets (user_id, match_id, market, line, selection, label,
         stake_points, odds, potential_payout_points, in_play, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .run(
      userId,
      match.id,
      market,
      line,
      selection,
      offer.label,
      stakePoints,
      offer.odds,
      payout,
      inPlay ? 1 : 0,
      nowIso()
    );
  const betId = Number(info.lastInsertRowid);
  applyBalanceChange(
    userId,
    -stakePoints,
    "bet_stake",
    betId,
    `${offer.label} (${match.home_team} vs ${match.away_team})${noteSuffix}`
  );
  return getBet(betId)!;
}

// A player's open stake exposed on one match: single bets on it PLUS every
// pending parlay that includes a leg on it (the full parlay stake is at risk on
// each of its matches). Must run inside the transaction.
function committedOnMatch(userId: number, matchId: number): number {
  const betSum = (
    db
      .prepare(
        "SELECT COALESCE(SUM(stake_points), 0) AS total FROM bets WHERE user_id = ? AND match_id = ? AND status = 'pending'"
      )
      .get(userId, matchId) as { total: number }
  ).total;
  const parlaySum = (
    db
      .prepare(
        `SELECT COALESCE(SUM(p.stake_points), 0) AS total
         FROM parlay_legs l JOIN parlays p ON p.id = l.parlay_id
         WHERE p.user_id = ? AND l.match_id = ? AND p.status = 'pending'`
      )
      .get(userId, matchId) as { total: number }
  ).total;
  return betSum + parlaySum;
}

// Per-match open-stake cap across all markets (pre-match + in-play combined).
// Throws if the new stake would breach it. Must run inside the transaction.
function assertMatchCap(userId: number, matchId: number, stakePoints: number): void {
  const existing = committedOnMatch(userId, matchId);
  if (existing + stakePoints > MAX_STAKE_PER_MATCH_POINTS) {
    const remaining = MAX_STAKE_PER_MATCH_POINTS - existing;
    throw new BetError(
      remaining > 0
        ? `You can stake at most ${fmtPts(MAX_STAKE_PER_MATCH_POINTS)} pts per match. You have ${fmtPts(remaining)} pts left on this match.`
        : `You've reached the ${fmtPts(MAX_STAKE_PER_MATCH_POINTS)} pts per-match limit on this match.`
    );
  }
}

export async function placeBet(
  userId: number,
  matchId: number,
  market: MarketType,
  line: number | null,
  selection: string,
  stakePoints: number,
  expectedOdds?: number | null
): Promise<PlaceBetResult> {
  if (!Number.isInteger(stakePoints) || stakePoints < MIN_STAKE_POINTS) {
    return { error: `Minimum stake is ${fmtPts(MIN_STAKE_POINTS)} pts.` };
  }
  const match = db
    .prepare("SELECT * FROM matches WHERE id = ?")
    .get(matchId) as Match | undefined;
  if (!match) return { error: "Match not found." };
  if (match.status !== "scheduled") {
    return { error: "Betting is closed for this match." };
  }

  // In-play: a started match. Acquire a fresh live observation (async) BEFORE
  // the synchronous booking transaction, then re-check suspension inside it.
  if (Date.parse(match.kickoff) <= Date.now()) {
    if (!inPlayEnabled()) return { error: "Betting is closed for this match." };
    // force = true: pull the freshest Bet365 quote + score right now, so the
    // bet is priced on current data, not the (slower) display poll.
    const ctx = await getLiveContext(match, true);
    if (!ctx.available || ctx.suspended || ctx.minute === null) {
      return { error: ctx.reason || "In-play betting is paused for this match." };
    }
    return bookInPlay(userId, match, market, line, selection, stakePoints, expectedOdds);
  }

  // Pre-match: the counter is still open.
  try {
    const bet = db.transaction(() => {
      const fresh = db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId) as Match;
      if (fresh.status !== "scheduled" || Date.parse(fresh.kickoff) <= Date.now()) {
        throw new BetError("Betting is closed for this match.");
      }
      assertMatchCap(userId, matchId, stakePoints);
      // Always price from the server-side market model — never trust client odds.
      const offer = findSelection(match, market, line, selection);
      if (!offer) throw new BetError("That market is not available right now.");
      return recordBet(userId, match, market, line, selection, offer, stakePoints, false, "");
    })();
    return { bet };
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

// Book an in-play bet. The live row was just refreshed by getLiveContext; this
// reads it again synchronously inside the transaction so the suspension gate,
// the price, and the booked bet all share one snapshot.
function bookInPlay(
  userId: number,
  match: Match,
  market: MarketType,
  line: number | null,
  selection: string,
  stakePoints: number,
  expectedOdds: number | null | undefined
): PlaceBetResult {
  try {
    const bet = db.transaction(() => {
      const fresh = db.prepare("SELECT * FROM matches WHERE id = ?").get(match.id) as Match;
      if (fresh.status !== "scheduled") throw new BetError("Betting is closed for this match.");
      const ctx: LiveContext = getLiveContextSync(match);
      if (!ctx.available || ctx.suspended || ctx.minute === null) {
        throw new BetError(ctx.reason || "In-play betting is paused for this match.");
      }
      assertMatchCap(userId, match.id, stakePoints);
      // Tighter cap on live stakes — bounds the value of any single snipe.
      const liveOpen = (
        db
          .prepare(
            "SELECT COALESCE(SUM(stake_points), 0) AS total FROM bets WHERE user_id = ? AND match_id = ? AND status = 'pending' AND in_play = 1"
          )
          .get(userId, match.id) as { total: number }
      ).total;
      if (liveOpen + stakePoints > MAX_INPLAY_STAKE_PER_MATCH_POINTS) {
        const remaining = MAX_INPLAY_STAKE_PER_MATCH_POINTS - liveOpen;
        throw new BetError(
          remaining > 0
            ? `In-play stakes are capped at ${fmtPts(MAX_INPLAY_STAKE_PER_MATCH_POINTS)} pts per match. You have ${fmtPts(remaining)} pts left here.`
            : `You've reached the ${fmtPts(MAX_INPLAY_STAKE_PER_MATCH_POINTS)} pts in-play limit on this match.`
        );
      }
      // Fail closed if the placement force-fetch couldn't land a fresh live
      // quote (feed/quota failure, or the bookmaker isn't quoting) — never
      // price a live bet off a stale quote the display board still tolerates.
      if (!hasFreshLiveQuote(match.id)) {
        throw new BetError("In-play prices are updating — try again in a moment.");
      }
      const offer = findLiveSelection(match, market, line, selection);
      if (!offer) throw new BetError("That market isn't available at the live price right now.");
      // Re-quote only when the fresh price is materially WORSE for the bettor.
      if (
        expectedOdds != null &&
        Number.isFinite(expectedOdds) &&
        offer.odds < Math.floor(expectedOdds * (1 - INPLAY_ODDS_TOLERANCE))
      ) {
        throw new RequoteError("The live price moved — review the new price.", offer.odds);
      }
      const note = ` [LIVE ${ctx.minute}' · ${ctx.homeScore}-${ctx.awayScore}]`;
      return recordBet(userId, match, market, line, selection, offer, stakePoints, true, note);
    })();
    return { bet };
  } catch (e) {
    if (e instanceof RequoteError) return { error: e.message, newOdds: e.newOdds };
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

// ── Parlay placement ─────────────────────────────────────────────────────────

export interface ParlayLegInput {
  matchId: number;
  market: MarketType;
  line: number | null;
  selection: string;
}

export interface PlaceParlayResult {
  parlay?: ParlayWithLegs;
  error?: string;
}

// All legs of a parlay must kick off on the same day. Compared as the UTC date
// prefix so the rule is deterministic and identical on client and server.
export function utcDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// Place a cross-match accumulator. Every leg is re-priced server-side (never
// trust client odds) and the combined odds are the product of those real locked
// quotes — no model. Rules: 2..MAX_PARLAY_LEGS legs, one leg per match
// (correlation block), pre-match only, all on the same day, stake within limits.
export async function placeParlay(
  userId: number,
  legs: ParlayLegInput[],
  stakePoints: number
): Promise<PlaceParlayResult> {
  if (!Array.isArray(legs) || legs.length < MIN_PARLAY_LEGS) {
    return { error: `A parlay needs at least ${MIN_PARLAY_LEGS} legs.` };
  }
  if (legs.length > MAX_PARLAY_LEGS) {
    return { error: `A parlay can have at most ${MAX_PARLAY_LEGS} legs.` };
  }
  if (!Number.isInteger(stakePoints) || stakePoints < MIN_STAKE_POINTS) {
    return { error: `Minimum stake is ${fmtPts(MIN_STAKE_POINTS)} pts.` };
  }
  if (stakePoints > MAX_PARLAY_STAKE_POINTS) {
    return { error: `Maximum parlay stake is ${fmtPts(MAX_PARLAY_STAKE_POINTS)} pts.` };
  }
  // One leg per match — the load-bearing correlation block (same-match combos
  // can't be priced from single-market quotes without a model).
  const seen = new Set<number>();
  for (const leg of legs) {
    if (seen.has(leg.matchId)) {
      return { error: "A parlay can't combine two selections from the same match." };
    }
    seen.add(leg.matchId);
  }
  // Up-front validation: every match scheduled, not yet started, all same day.
  let day: string | null = null;
  for (const leg of legs) {
    const match = db
      .prepare("SELECT * FROM matches WHERE id = ?")
      .get(leg.matchId) as Match | undefined;
    if (!match) return { error: "One of the matches no longer exists." };
    if (match.status !== "scheduled" || Date.parse(match.kickoff) <= Date.now()) {
      return { error: `Betting is closed for ${match.home_team} vs ${match.away_team}.` };
    }
    const d = utcDay(match.kickoff);
    if (day === null) day = d;
    else if (d !== day) {
      return { error: "All legs of a parlay must kick off on the same day." };
    }
  }

  try {
    const parlay = db.transaction(() => {
      const priced: { leg: ParlayLegInput; odds: number; label: string }[] = [];
      for (const leg of legs) {
        const match = db
          .prepare("SELECT * FROM matches WHERE id = ?")
          .get(leg.matchId) as Match;
        if (match.status !== "scheduled" || Date.parse(match.kickoff) <= Date.now()) {
          throw new BetError(
            `Betting is closed for ${match.home_team} vs ${match.away_team}.`
          );
        }
        // The full parlay stake is at risk on each leg's match — count it
        // against the per-match cap, same as a single bet would.
        assertMatchCap(userId, leg.matchId, stakePoints);
        // Re-price from the server-side market model — never trust client odds.
        const offer = findSelection(match, leg.market, leg.line, leg.selection);
        if (!offer) {
          throw new BetError(
            `A selection isn't available right now (${match.home_team} vs ${match.away_team}). Remove it and try again.`
          );
        }
        priced.push({ leg, odds: offer.odds, label: offer.label });
      }
      const legOdds = priced.map((p) => p.odds);
      const combined = combineOddsX1000(legOdds);
      const potential = parlayPayoutPoints(
        stakePoints,
        legOdds,
        MAX_PARLAY_PAYOUT_POINTS
      );
      const info = db
        .prepare(
          `INSERT INTO parlays (user_id, stake_points, combined_odds, potential_payout_points, status, created_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`
        )
        .run(userId, stakePoints, combined, potential, nowIso());
      const parlayId = Number(info.lastInsertRowid);
      const insertLeg = db.prepare(
        `INSERT INTO parlay_legs (parlay_id, leg_seq, match_id, market, line, selection, label, odds, leg_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      );
      priced.forEach((p, i) => {
        insertLeg.run(
          parlayId,
          i + 1,
          p.leg.matchId,
          p.leg.market,
          p.leg.line,
          p.leg.selection,
          p.label,
          p.odds
        );
      });
      applyBalanceChange(
        userId,
        -stakePoints,
        "parlay_stake",
        null,
        `Parlay: ${priced.length} legs @ ${(combined / 1000).toFixed(2)}`,
        parlayId
      );
      return getUserParlay(userId, parlayId)!;
    })();
    return { parlay };
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

export function cancelBet(userId: number, betId: number): { error?: string } {
  try {
    db.transaction(() => {
      const bet = db
        .prepare("SELECT * FROM bets WHERE id = ? AND user_id = ?")
        .get(betId, userId) as Bet | undefined;
      if (!bet) throw new BetError("Bet not found.");
      if (bet.status !== "pending") {
        throw new BetError("Only open bets can be cancelled.");
      }
      const match = db
        .prepare("SELECT * FROM matches WHERE id = ?")
        .get(bet.match_id) as Match;
      if (match.status !== "scheduled" || Date.parse(match.kickoff) <= Date.now()) {
        throw new BetError("Too late to cancel — the match has started.");
      }
      if (Date.parse(bet.created_at) + CANCEL_WINDOW_MS <= Date.now()) {
        throw new BetError(
          "Too late to cancel — bets can only be cancelled within 30 minutes of placing them."
        );
      }
      db.prepare(
        "UPDATE bets SET status = 'cancelled', payout_points = ?, settled_at = ? WHERE id = ?"
      ).run(bet.stake_points, nowIso(), bet.id);
      applyBalanceChange(
        userId,
        bet.stake_points,
        "bet_refund",
        bet.id,
        `Cancelled: ${bet.label}`
      );
    })();
    return {};
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

// Resolve one pending bet against final result data. Caller must run inside a
// transaction. Returns true if the bet reached a final state.
function resolveBet(bet: Bet, d: ResultData, context: string): boolean {
  const outcome: SettleOutcome = settleSelection(
    bet.market,
    bet.line,
    bet.selection,
    d
  );
  if (outcome === "pending") return false;

  let payout = 0;
  let status: "won" | "lost" | "void";
  switch (outcome) {
    case "win":
      payout = bet.potential_payout_points;
      status = "won";
      break;
    case "half_win":
      payout = halfWinPayout(bet.stake_points, bet.odds);
      status = "won";
      break;
    case "push":
      payout = bet.stake_points;
      status = "void";
      break;
    case "half_lose":
      payout = halfLosePayout(bet.stake_points);
      status = "lost";
      break;
    default:
      payout = 0;
      status = "lost";
  }
  db.prepare(
    "UPDATE bets SET status = ?, payout_points = ?, settled_at = ? WHERE id = ?"
  ).run(status, payout, nowIso(), bet.id);
  if (payout > 0) {
    const type = outcome === "push" ? "bet_refund" : "bet_payout";
    applyBalanceChange(
      bet.user_id,
      payout,
      type,
      bet.id,
      `${outcome === "push" ? "Push" : outcome === "half_win" ? "Half win" : outcome === "half_lose" ? "Half loss" : "Won"}: ${bet.label} (${context})`
    );
  }
  return true;
}

// ── Parlay settlement ────────────────────────────────────────────────────────

// Per-leg contribution to the parlay payout, x1000 (mirrors the single-bet
// money math). `null` means the leg fully lost, so the whole parlay loses.
function legFactorX1000(status: LegStatus, oddsX1000: number): number | null {
  switch (status) {
    case "win":
      return oddsX1000;
    case "push":
      return 1000; // 1.000 — drops out, recompute on the rest
    case "half_win":
      return Math.floor((1000 + oddsX1000) / 2);
    case "half_lose":
      return 500; // 0.500
    case "lose":
      return null;
    default:
      return 1000; // 'pending' never reaches here
  }
}

// Re-evaluate one parlay after a leg changed. Lost the instant any leg loses
// (early locked loss); paid only once every leg is terminal and none lost.
// Caller must run inside a transaction. Guards on status so it never double-pays.
function reevaluateParlay(parlayId: number): void {
  const p = db.prepare("SELECT * FROM parlays WHERE id = ?").get(parlayId) as
    | Parlay
    | undefined;
  if (!p || p.status !== "pending") return;
  const legs = db
    .prepare("SELECT * FROM parlay_legs WHERE parlay_id = ?")
    .all(parlayId) as ParlayLeg[];
  if (legs.some((l) => l.leg_status === "lose")) {
    db.prepare(
      "UPDATE parlays SET status = 'lost', payout_points = 0, settled_at = ? WHERE id = ?"
    ).run(nowIso(), parlayId);
    return;
  }
  if (legs.some((l) => l.leg_status === "pending")) return; // wait for the rest
  // Every leg is terminal and none lost.
  const factors = legs.map((l) => legFactorX1000(l.leg_status, l.odds)!);
  const allPush = legs.every((l) => l.leg_status === "push");
  const payout = parlayPayoutPoints(
    p.stake_points,
    factors,
    MAX_PARLAY_PAYOUT_POINTS
  );
  const status: ParlayStatus = allPush ? "void" : "won";
  db.prepare(
    "UPDATE parlays SET status = ?, payout_points = ?, settled_at = ? WHERE id = ?"
  ).run(status, payout, nowIso(), parlayId);
  if (payout > 0) {
    applyBalanceChange(
      p.user_id,
      payout,
      status === "void" ? "parlay_refund" : "parlay_payout",
      null,
      `${status === "void" ? "Parlay void (all legs pushed)" : "Parlay won"}: ${legs.length} legs`,
      parlayId
    );
  }
}

// Settle every pending parlay leg on a just-resolved match, then re-evaluate
// each affected parlay. Caller must run inside a transaction. Legs that can't be
// graded yet (e.g. corners/cards unknown) stay pending until completeMatchData.
function settleParlayLegsForMatch(matchId: number, d: ResultData): void {
  const legs = db
    .prepare(
      "SELECT * FROM parlay_legs WHERE match_id = ? AND leg_status = 'pending'"
    )
    .all(matchId) as ParlayLeg[];
  const affected = new Set<number>();
  for (const leg of legs) {
    const outcome = settleSelection(leg.market, leg.line, leg.selection, d);
    if (outcome === "pending") continue;
    db.prepare(
      "UPDATE parlay_legs SET leg_status = ?, settled_at = ? WHERE id = ?"
    ).run(outcome, nowIso(), leg.id);
    affected.add(leg.parlay_id);
  }
  for (const pid of affected) reevaluateParlay(pid);
}

// A voided match (postponed) drops its parlay legs at odds 1.000 (push) and the
// parlay recomputes on the rest. Caller must run inside a transaction.
function voidParlayLegsForMatch(matchId: number): void {
  const legs = db
    .prepare(
      "SELECT * FROM parlay_legs WHERE match_id = ? AND leg_status = 'pending'"
    )
    .all(matchId) as ParlayLeg[];
  const affected = new Set<number>();
  for (const leg of legs) {
    db.prepare(
      "UPDATE parlay_legs SET leg_status = 'push', settled_at = ? WHERE id = ?"
    ).run(nowIso(), leg.id);
    affected.add(leg.parlay_id);
  }
  for (const pid of affected) reevaluateParlay(pid);
}

export interface MatchResultInput {
  homeScore: number;
  awayScore: number;
  cornersHome?: number | null;
  cornersAway?: number | null;
  cardsTotal?: number | null;
}

function validCount(n: number | null | undefined, max: number): boolean {
  return n === null || n === undefined || (Number.isInteger(n) && n >= 0 && n <= max);
}

// Record the final result and settle every bet the data covers. Bets on
// corners/cards stay pending when those counts are unknown; completeMatchData
// settles them later.
export function settleMatch(
  matchId: number,
  input: MatchResultInput
): { error?: string; settledBets?: number } {
  const { homeScore, awayScore } = input;
  if (
    !Number.isInteger(homeScore) ||
    !Number.isInteger(awayScore) ||
    homeScore < 0 ||
    awayScore < 0 ||
    homeScore > 99 ||
    awayScore > 99
  ) {
    return { error: "Scores must be whole numbers between 0 and 99." };
  }
  if (
    !validCount(input.cornersHome, 99) ||
    !validCount(input.cornersAway, 99) ||
    !validCount(input.cardsTotal, 99)
  ) {
    return { error: "Corners/cards must be whole numbers between 0 and 99." };
  }
  const result: Pick3 =
    homeScore > awayScore ? "home" : homeScore < awayScore ? "away" : "draw";
  try {
    const settledBets = db.transaction(() => {
      const match = db
        .prepare("SELECT * FROM matches WHERE id = ?")
        .get(matchId) as Match | undefined;
      if (!match) throw new BetError("Match not found.");
      if (match.status !== "scheduled") {
        throw new BetError("Match is already settled.");
      }
      const d: ResultData = {
        homeScore,
        awayScore,
        cornersHome: input.cornersHome ?? null,
        cornersAway: input.cornersAway ?? null,
        cardsTotal: input.cardsTotal ?? null,
      };
      db.prepare(
        `UPDATE matches SET status = 'finished', home_score = ?, away_score = ?,
           corners_home = ?, corners_away = ?, cards_total = ?, result = ?
         WHERE id = ?`
      ).run(
        homeScore,
        awayScore,
        d.cornersHome,
        d.cornersAway,
        d.cardsTotal,
        result,
        matchId
      );
      const pending = db
        .prepare("SELECT * FROM bets WHERE match_id = ? AND status = 'pending'")
        .all(matchId) as Bet[];
      const context = `${match.home_team} ${homeScore}-${awayScore} ${match.away_team}`;
      let settled = 0;
      for (const bet of pending) {
        if (resolveBet(bet, d, context)) settled++;
      }
      settleParlayLegsForMatch(matchId, d);
      return settled;
    })();
    return { settledBets };
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

// Add corners/cards counts to an already-finished match and settle the bets
// that were waiting on them.
export function completeMatchData(
  matchId: number,
  cornersHome: number | null,
  cornersAway: number | null,
  cardsTotal: number | null
): { error?: string; settledBets?: number } {
  if (
    !validCount(cornersHome, 99) ||
    !validCount(cornersAway, 99) ||
    !validCount(cardsTotal, 99)
  ) {
    return { error: "Corners/cards must be whole numbers between 0 and 99." };
  }
  try {
    const settledBets = db.transaction(() => {
      const match = db
        .prepare("SELECT * FROM matches WHERE id = ?")
        .get(matchId) as Match | undefined;
      if (!match) throw new BetError("Match not found.");
      if (match.status !== "finished" || match.home_score === null || match.away_score === null) {
        throw new BetError("Enter the final score first (settle the match).");
      }
      const d: ResultData = {
        homeScore: match.home_score,
        awayScore: match.away_score,
        cornersHome: cornersHome ?? match.corners_home,
        cornersAway: cornersAway ?? match.corners_away,
        cardsTotal: cardsTotal ?? match.cards_total,
      };
      db.prepare(
        "UPDATE matches SET corners_home = ?, corners_away = ?, cards_total = ? WHERE id = ?"
      ).run(d.cornersHome, d.cornersAway, d.cardsTotal, matchId);
      const pending = db
        .prepare("SELECT * FROM bets WHERE match_id = ? AND status = 'pending'")
        .all(matchId) as Bet[];
      const context = `${match.home_team} ${match.home_score}-${match.away_score} ${match.away_team}`;
      let settled = 0;
      for (const bet of pending) {
        if (resolveBet(bet, d, context)) settled++;
      }
      settleParlayLegsForMatch(matchId, d);
      return settled;
    })();
    return { settledBets };
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

// Markets whose outcome can become mathematically locked before full time
// (monotonic in a tally that only rises: goals, corners, cards).
const EARLY_RESOLVE_MARKETS = [
  "ou_goals",
  "ou_corners",
  "ou_cards",
  "correct_score",
  "btts",
] as const;

// Settle bets already decided by the live tallies (sure win / sure loss)
// without waiting for full time — an Over once its total clears the line, a
// correct score once it's overtaken, BTTS once both teams have scored. Acts
// only on a VAR-safe confirmed-stable observation (getConfirmedLiveScore);
// corner/card totals come from ESPN (corners live in the scoreboard, cards via
// the box-score summary). The match stays 'scheduled' and settleMatch later
// settles whatever is still pending, so a bet is never settled twice. Async
// (refreshes ESPN + may fetch cards) — runs from the sync loop.
export async function maybeEarlyResolve(): Promise<{ resolved: number }> {
  await refreshLiveObservations(); // keep live_state fresh even with no page traffic
  const live = db
    .prepare(
      "SELECT id, api_id, home_team, away_team FROM matches WHERE status = 'scheduled' AND kickoff <= ?"
    )
    .all(nowIso()) as Pick<Match, "id" | "api_id" | "home_team" | "away_team">[];
  const placeholders = EARLY_RESOLVE_MARKETS.map(() => "?").join(",");
  let resolved = 0;
  for (const m of live) {
    const score = getConfirmedLiveScore(m.id);
    if (!score) continue;
    const pending = db
      .prepare(
        `SELECT * FROM bets WHERE match_id = ? AND status = 'pending' AND market IN (${placeholders})`
      )
      .all(m.id, ...EARLY_RESOLVE_MARKETS) as Bet[];
    const pendingLegs = db
      .prepare(
        `SELECT * FROM parlay_legs WHERE match_id = ? AND leg_status = 'pending' AND market IN (${placeholders})`
      )
      .all(m.id, ...EARLY_RESOLVE_MARKETS) as ParlayLeg[];
    if (pending.length === 0 && pendingLegs.length === 0) continue;
    // Live card total only when a card market is open and we have an ESPN id.
    let cardsTotal: number | null = null;
    const needCards =
      pending.some((b) => b.market === "ou_cards") ||
      pendingLegs.some((l) => l.market === "ou_cards");
    if (needCards && m.api_id?.startsWith("espn:")) {
      cardsTotal = await fetchEspnCards(m.api_id.slice(5)).catch(() => null);
    }
    const tallies = {
      homeScore: score.home,
      awayScore: score.away,
      cornersTotal: score.cornersTotal,
      cardsTotal,
    };
    for (const bet of pending) {
      const outcome = lockedOutcome(bet.market, bet.line, bet.selection, tallies);
      if (!outcome) continue;
      const didResolve = db.transaction(() => {
        const fresh = getBet(bet.id);
        if (!fresh || fresh.status !== "pending") return false; // raced with another settle
        const context = `live ${m.home_team} ${score.home}-${score.away} ${m.away_team}`;
        if (outcome === "won") {
          const payout = fresh.potential_payout_points;
          db.prepare(
            "UPDATE bets SET status = 'won', payout_points = ?, settled_at = ? WHERE id = ?"
          ).run(payout, nowIso(), fresh.id);
          applyBalanceChange(fresh.user_id, payout, "bet_payout", fresh.id, `Early win: ${fresh.label} (${context})`);
        } else {
          db.prepare(
            "UPDATE bets SET status = 'lost', payout_points = 0, settled_at = ? WHERE id = ?"
          ).run(nowIso(), fresh.id);
        }
        return true;
      })();
      if (didResolve) resolved++;
    }
    // Parlay legs: a locked win marks just that leg won (the parlay waits on its
    // other legs); a locked loss settles the whole parlay as lost immediately.
    for (const leg of pendingLegs) {
      const outcome = lockedOutcome(leg.market, leg.line, leg.selection, tallies);
      if (!outcome) continue;
      const didResolve = db.transaction(() => {
        const fresh = db
          .prepare("SELECT leg_status FROM parlay_legs WHERE id = ?")
          .get(leg.id) as { leg_status: LegStatus } | undefined;
        if (!fresh || fresh.leg_status !== "pending") return false; // raced
        db.prepare(
          "UPDATE parlay_legs SET leg_status = ?, settled_at = ? WHERE id = ?"
        ).run(outcome === "won" ? "win" : "lose", nowIso(), leg.id);
        reevaluateParlay(leg.parlay_id);
        return true;
      })();
      if (didResolve) resolved++;
    }
  }
  return { resolved };
}

// Void a match (e.g. postponed): refund every pending stake.
export function voidMatch(matchId: number): { error?: string; refunded?: number } {
  try {
    const refunded = db.transaction(() => {
      const match = db
        .prepare("SELECT * FROM matches WHERE id = ?")
        .get(matchId) as Match | undefined;
      if (!match) throw new BetError("Match not found.");
      if (match.status !== "scheduled") {
        throw new BetError("Match is already settled.");
      }
      db.prepare("UPDATE matches SET status = 'void' WHERE id = ?").run(matchId);
      const pending = db
        .prepare("SELECT * FROM bets WHERE match_id = ? AND status = 'pending'")
        .all(matchId) as Bet[];
      for (const bet of pending) {
        db.prepare(
          "UPDATE bets SET status = 'void', payout_points = ?, settled_at = ? WHERE id = ?"
        ).run(bet.stake_points, nowIso(), bet.id);
        applyBalanceChange(
          bet.user_id,
          bet.stake_points,
          "bet_refund",
          bet.id,
          `Voided: ${match.home_team} vs ${match.away_team}`
        );
      }
      voidParlayLegsForMatch(matchId);
      return pending.length;
    })();
    return { refunded };
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

const BET_WITH_MATCH = `
  SELECT b.*, m.home_team, m.away_team, m.kickoff,
         m.status AS match_status, m.home_score, m.away_score
  FROM bets b JOIN matches m ON m.id = b.match_id
`;

// Every player's unsettled bets, for the public in-play board.
export function listOpenBets(): OpenBetRow[] {
  return db
    .prepare(
      `SELECT b.*, m.home_team, m.away_team, m.kickoff,
              m.status AS match_status, m.home_score, m.away_score,
              u.username, u.is_bot
       FROM bets b
       JOIN matches m ON m.id = b.match_id
       JOIN users u ON u.id = b.user_id
       WHERE b.status = 'pending'
       ORDER BY b.created_at DESC, b.id DESC`
    )
    .all() as OpenBetRow[];
}

export function listUserBets(userId: number): BetWithMatch[] {
  return db
    .prepare(`${BET_WITH_MATCH} WHERE b.user_id = ? ORDER BY b.created_at DESC, b.id DESC`)
    .all(userId) as BetWithMatch[];
}

export function listUserBetsForMatch(
  userId: number,
  matchId: number
): BetWithMatch[] {
  return db
    .prepare(
      `${BET_WITH_MATCH} WHERE b.user_id = ? AND b.match_id = ? ORDER BY b.created_at DESC, b.id DESC`
    )
    .all(userId, matchId) as BetWithMatch[];
}

export function getUserBet(userId: number, betId: number): Bet | undefined {
  return db
    .prepare("SELECT * FROM bets WHERE id = ? AND user_id = ?")
    .get(betId, userId) as Bet | undefined;
}

export function countPendingBets(matchId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM bets WHERE match_id = ? AND status = 'pending'"
      )
      .get(matchId) as { n: number }
  ).n;
}

// ── Parlay cancel & listing ──────────────────────────────────────────────────

export function cancelParlay(userId: number, parlayId: number): { error?: string } {
  try {
    db.transaction(() => {
      const p = db
        .prepare("SELECT * FROM parlays WHERE id = ? AND user_id = ?")
        .get(parlayId, userId) as Parlay | undefined;
      if (!p) throw new BetError("Parlay not found.");
      if (p.status !== "pending") {
        throw new BetError("Only open parlays can be cancelled.");
      }
      const legs = db
        .prepare(
          `SELECT m.status AS match_status, m.kickoff
           FROM parlay_legs l JOIN matches m ON m.id = l.match_id
           WHERE l.parlay_id = ?`
        )
        .all(parlayId) as { match_status: string; kickoff: string }[];
      for (const leg of legs) {
        if (leg.match_status !== "scheduled" || Date.parse(leg.kickoff) <= Date.now()) {
          throw new BetError("Too late to cancel — one of the matches has started.");
        }
      }
      if (Date.parse(p.created_at) + CANCEL_WINDOW_MS <= Date.now()) {
        throw new BetError(
          "Too late to cancel — parlays can only be cancelled within 30 minutes of placing them."
        );
      }
      db.prepare(
        "UPDATE parlays SET status = 'cancelled', payout_points = ?, settled_at = ? WHERE id = ?"
      ).run(p.stake_points, nowIso(), p.id);
      applyBalanceChange(
        userId,
        p.stake_points,
        "parlay_refund",
        null,
        `Cancelled parlay (${legs.length} legs)`,
        p.id
      );
    })();
    return {};
  } catch (e) {
    if (e instanceof BetError) return { error: e.message };
    throw e;
  }
}

const PARLAY_LEGS_WITH_MATCH = `
  SELECT l.*, m.home_team, m.away_team, m.kickoff,
         m.status AS match_status, m.home_score, m.away_score
  FROM parlay_legs l JOIN matches m ON m.id = l.match_id
`;

export function listUserParlays(userId: number): ParlayWithLegs[] {
  const parlays = db
    .prepare("SELECT * FROM parlays WHERE user_id = ? ORDER BY created_at DESC, id DESC")
    .all(userId) as Parlay[];
  if (parlays.length === 0) return [];
  const ph = parlays.map(() => "?").join(",");
  const legs = db
    .prepare(
      `${PARLAY_LEGS_WITH_MATCH} WHERE l.parlay_id IN (${ph}) ORDER BY l.parlay_id, l.leg_seq`
    )
    .all(...parlays.map((p) => p.id)) as ParlayLegWithMatch[];
  const byParlay = new Map<number, ParlayLegWithMatch[]>();
  for (const l of legs) {
    const arr = byParlay.get(l.parlay_id);
    if (arr) arr.push(l);
    else byParlay.set(l.parlay_id, [l]);
  }
  return parlays.map((p) => ({ ...p, legs: byParlay.get(p.id) ?? [] }));
}

export function getUserParlay(
  userId: number,
  parlayId: number
): ParlayWithLegs | undefined {
  const p = db
    .prepare("SELECT * FROM parlays WHERE id = ? AND user_id = ?")
    .get(parlayId, userId) as Parlay | undefined;
  if (!p) return undefined;
  const legs = db
    .prepare(`${PARLAY_LEGS_WITH_MATCH} WHERE l.parlay_id = ? ORDER BY l.leg_seq`)
    .all(parlayId) as ParlayLegWithMatch[];
  return { ...p, legs };
}
