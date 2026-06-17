import { db } from "./db";
import type { LeaderboardRow, Txn } from "./types";

export function getLeaderboard(): LeaderboardRow[] {
  // Aggregate single bets and parlays separately (a join across both would
  // fan out and inflate the sums), then add them per user. "In play" is the
  // open stake at risk across both; wins/losses/pending count tickets of either
  // kind. Ranking is net worth = balance + open stake.
  return db
    .prepare(
      `SELECT u.id, u.username, u.is_bot, u.balance_points,
              COALESCE(b.in_play_points, 0) + COALESCE(p.in_play_points, 0) AS in_play_points,
              COALESCE(b.wins, 0) + COALESCE(p.wins, 0) AS wins,
              COALESCE(b.losses, 0) + COALESCE(p.losses, 0) AS losses,
              COALESCE(b.pending, 0) + COALESCE(p.pending, 0) AS pending
       FROM users u
       LEFT JOIN (
         SELECT user_id,
                SUM(CASE WHEN status = 'pending' THEN stake_points ELSE 0 END) AS in_play_points,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM bets GROUP BY user_id
       ) b ON b.user_id = u.id
       LEFT JOIN (
         SELECT user_id,
                SUM(CASE WHEN status = 'pending' THEN stake_points ELSE 0 END) AS in_play_points,
                SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN status = 'lost' THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM parlays GROUP BY user_id
       ) p ON p.user_id = u.id
       ORDER BY (u.balance_points + COALESCE(b.in_play_points, 0) + COALESCE(p.in_play_points, 0)) DESC,
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
