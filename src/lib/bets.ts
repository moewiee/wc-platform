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
  fmtPts,
  halfLosePayout,
  halfWinPayout,
  MAX_INPLAY_STAKE_PER_MATCH_POINTS,
  MAX_STAKE_PER_MATCH_POINTS,
  MIN_STAKE_POINTS,
  payoutPoints,
} from "./money";
import type { Bet, BetWithMatch, MarketType, Match, OpenBetRow, Pick3 } from "./types";

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
// db.transaction so balance and ledger never diverge.
function applyBalanceChange(
  userId: number,
  amountPoints: number,
  type: string,
  betId: number | null,
  note: string
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
    "INSERT INTO transactions (user_id, amount_points, balance_after_points, type, bet_id, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, amountPoints, newBalance, type, betId, note, nowIso());
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

// Per-match open-stake cap across all markets (pre-match + in-play combined).
// Throws if the new stake would breach it. Must run inside the transaction.
function assertMatchCap(userId: number, matchId: number, stakePoints: number): void {
  const existing = (
    db
      .prepare(
        "SELECT COALESCE(SUM(stake_points), 0) AS total FROM bets WHERE user_id = ? AND match_id = ? AND status = 'pending'"
      )
      .get(userId, matchId) as { total: number }
  ).total;
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
    if (pending.length === 0) continue;
    // Live card total only when a card bet is open and we have an ESPN id.
    let cardsTotal: number | null = null;
    if (pending.some((b) => b.market === "ou_cards") && m.api_id?.startsWith("espn:")) {
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
