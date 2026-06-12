import { db } from "./db";
import type { LeaderboardRow, Txn } from "./types";

export function getLeaderboard(): LeaderboardRow[] {
  return db
    .prepare(
      `SELECT u.id, u.username, u.balance_points,
              COALESCE(SUM(CASE WHEN b.status = 'pending' THEN b.stake_points ELSE 0 END), 0) AS in_play_points,
              COALESCE(SUM(CASE WHEN b.status = 'won' THEN 1 ELSE 0 END), 0) AS wins,
              COALESCE(SUM(CASE WHEN b.status = 'lost' THEN 1 ELSE 0 END), 0) AS losses,
              COALESCE(SUM(CASE WHEN b.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending
       FROM users u
       LEFT JOIN bets b ON b.user_id = u.id
       GROUP BY u.id
       ORDER BY (u.balance_points + COALESCE(SUM(CASE WHEN b.status = 'pending' THEN b.stake_points ELSE 0 END), 0)) DESC,
                u.username ASC`
    )
    .all() as LeaderboardRow[];
}

export function listTransactions(userId: number, limit = 100): Txn[] {
  return db
    .prepare(
      "SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?"
    )
    .all(userId, limit) as Txn[];
}
