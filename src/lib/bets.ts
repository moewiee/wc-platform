import { db, nowIso } from "./db";
import {
  findSelection,
  settleSelection,
  type ResultData,
  type SettleOutcome,
} from "./markets";
import {
  fmtPts,
  halfLosePayout,
  halfWinPayout,
  MIN_STAKE_POINTS,
  payoutPoints,
} from "./money";
import type { Bet, BetWithMatch, MarketType, Match, Pick3 } from "./types";

class BetError extends Error {}

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

export function placeBet(
  userId: number,
  matchId: number,
  market: MarketType,
  line: number | null,
  selection: string,
  stakePoints: number
): { bet?: Bet; error?: string } {
  if (!Number.isInteger(stakePoints) || stakePoints < MIN_STAKE_POINTS) {
    return { error: `Minimum stake is ${fmtPts(MIN_STAKE_POINTS)} pts.` };
  }
  try {
    const bet = db.transaction(() => {
      const match = db
        .prepare("SELECT * FROM matches WHERE id = ?")
        .get(matchId) as Match | undefined;
      if (!match) throw new BetError("Match not found.");
      if (match.status !== "scheduled" || Date.parse(match.kickoff) <= Date.now()) {
        throw new BetError("Betting is closed for this match.");
      }
      // Always price from the server-side market model — never trust client odds.
      const offer = findSelection(match, market, line, selection);
      if (!offer) throw new BetError("That market is not available right now.");
      const payout = payoutPoints(stakePoints, offer.odds);
      const info = db
        .prepare(
          `INSERT INTO bets (user_id, match_id, market, line, selection, label,
             stake_points, odds, potential_payout_points, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        )
        .run(
          userId,
          matchId,
          market,
          line,
          selection,
          offer.label,
          stakePoints,
          offer.odds,
          payout,
          nowIso()
        );
      const betId = Number(info.lastInsertRowid);
      applyBalanceChange(
        userId,
        -stakePoints,
        "bet_stake",
        betId,
        `${offer.label} (${match.home_team} vs ${match.away_team})`
      );
      return getBet(betId)!;
    })();
    return { bet };
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
