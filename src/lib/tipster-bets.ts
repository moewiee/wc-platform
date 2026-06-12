import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { db, getMeta, nowIso, setMeta } from "./db";
import { placeBet } from "./bets";
import { ensureModelTips } from "./tips";
import { marketsForMatch } from "./markets";
import { MIN_STAKE_POINTS, STARTING_BALANCE_POINTS } from "./money";
import type { Match, Tip, User } from "./types";

// Tipsters put their points where their mouth is: every published tip gets a
// real bet from that persona's bot account (bankroll rules identical to
// players), so the leaderboard shows whether the experts actually beat the
// crowd. Tips link to their bet via tips.bet_id.

// Expert name (as stored on tips) → bot account. Usernames carry spaces,
// which validateUsername rejects, so players can never register or log into
// these names; the accounts have a random password and no sessions.
export const TIPSTERS: Record<string, { username: string; avatar: string }> = {
  "The Quant": { username: "The Quant", avatar: "🤖" },
  "Goals Guru": { username: "Goals Guru", avatar: "⚽" },
  "Upset Radar": { username: "Upset Radar", avatar: "📡" },
  "Captain Chalk": { username: "Captain Chalk", avatar: "🏆" },
  "Eddie Insider": { username: "Eddie Insider", avatar: "🕵️" },
  "Anna Analyst": { username: "Anna Analyst", avatar: "📊" },
  "Vic Value": { username: "Vic Value", avatar: "💰" },
};

export function tipsterAvatar(username: string): string | null {
  for (const t of Object.values(TIPSTERS)) {
    if (t.username === username) return t.avatar;
  }
  return null;
}

// Stake sizing: confidence 1-5 → 100-500 pts, capped by what's left in the
// bot's bankroll. A cold tipster goes quiet instead of going negative.
function stakeFor(confidence: number, balance: number): number | null {
  const stake = Math.min(Math.max(confidence, 1), 5) * 100;
  const capped = Math.min(stake, balance);
  return capped >= MIN_STAKE_POINTS ? capped : null;
}

function getOrCreateTipsterUser(expert: string): User | null {
  const t = TIPSTERS[expert];
  if (!t) return null; // unknown persona: tip stays a tip, no bet
  const existing = db
    .prepare("SELECT id, username, balance_points, is_admin, is_bot, created_at FROM users WHERE username = ?")
    .get(t.username) as User | undefined;
  if (existing) return existing;
  const hash = bcrypt.hashSync(crypto.randomBytes(24).toString("hex"), 10);
  const id = db.transaction(() => {
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash, balance_points, is_admin, is_bot, created_at) VALUES (?, ?, ?, 0, 1, ?)"
      )
      .run(t.username, hash, STARTING_BALANCE_POINTS, nowIso());
    const userId = Number(info.lastInsertRowid);
    // Same welcome-bonus ledger row players get, so the balance invariant
    // (20,000 − Σstakes + Σpayouts) holds for bots too.
    db.prepare(
      "INSERT INTO transactions (user_id, amount_points, balance_after_points, type, note, created_at) VALUES (?, ?, ?, 'signup_bonus', 'Welcome bonus', ?)"
    ).run(userId, STARTING_BALANCE_POINTS, STARTING_BALANCE_POINTS, nowIso());
    return userId;
  })();
  return db
    .prepare("SELECT id, username, balance_points, is_admin, is_bot, created_at FROM users WHERE id = ?")
    .get(id) as User;
}

const TIPSTER_BETS_INTERVAL_MS = 15 * 60 * 1000;
const TIPSTER_WINDOW_MS = 24 * 60 * 60 * 1000;
// How far a tip may be re-lined when its exact line is no longer quoted
// (real bookmaker ladders shift; e.g. a model-era "O/U 2.5" tip when the
// book only quotes 2.25 and 3.5).
const MAX_RELINE_DISTANCE = 1.0;

// Nearest currently-quoted line in the tip's market that still offers the
// tip's selection, or null when nothing is acceptably close.
function nearestQuotedLine(match: Match, tip: Tip): number | null {
  if (tip.line === null) return null;
  let best: number | null = null;
  for (const mk of marketsForMatch(match)) {
    if (mk.market !== tip.market || mk.line === null) continue;
    if (!mk.selections.some((s) => s.selection === tip.selection)) continue;
    if (best === null || Math.abs(mk.line - tip.line) < Math.abs(best - tip.line)) {
      best = mk.line;
    }
  }
  if (best === null || Math.abs(best - tip.line) > MAX_RELINE_DISTANCE) return null;
  return Math.abs(best - tip.line) < 1e-9 ? null : best; // null = same line, nothing to do
}

// Place bets for unbet tips on matches kicking off within 24 h. Runs from
// the sync loop; also makes sure the statistical personas have tipped those
// matches (previously they only tipped when someone opened the match page).
// A tip whose market/line is no longer quoted is retried each pass — lines
// move and can come back — and naturally expires at kickoff.
export async function maybePlaceTipsterBets(
  force = false
): Promise<{ skipped: string } | { placed: number; tips: number }> {
  const last = getMeta("last_tipster_bets_run");
  if (!force && last && Date.now() - Date.parse(last) < TIPSTER_BETS_INTERVAL_MS) {
    return { skipped: "Tipster bets ran within the last 15 minutes." };
  }
  setMeta("last_tipster_bets_run", nowIso());

  const now = Date.now();
  const matches = (
    db
      .prepare("SELECT * FROM matches WHERE status = 'scheduled' ORDER BY kickoff")
      .all() as Match[]
  ).filter((m) => {
    const kickoff = Date.parse(m.kickoff);
    return kickoff > now && kickoff - now < TIPSTER_WINDOW_MS;
  });
  if (matches.length === 0) return { placed: 0, tips: 0 };

  for (const m of matches) ensureModelTips(m);

  const matchById = new Map(matches.map((m) => [m.id, m]));
  const matchIds = matches.map((m) => m.id).join(",");
  const openTips = db
    .prepare(
      `SELECT * FROM tips WHERE bet_id IS NULL AND match_id IN (${matchIds})`
    )
    .all() as Tip[];

  let placed = 0;
  const linkBet = db.prepare("UPDATE tips SET bet_id = ? WHERE id = ?");
  const balanceOf = db.prepare("SELECT balance_points FROM users WHERE id = ?");
  for (const tip of openTips) {
    const user = getOrCreateTipsterUser(tip.expert);
    if (!user) continue;
    // Re-read per tip: an earlier bet in this pass may have spent from the
    // same bot's bankroll.
    const balance = (balanceOf.get(user.id) as { balance_points: number }).balance_points;
    const stake = stakeFor(tip.confidence, balance);
    if (stake === null) continue; // bankroll exhausted
    const res = placeBet(user.id, tip.match_id, tip.market, tip.line, tip.selection, stake);
    if (res.bet) {
      linkBet.run(res.bet.id, tip.id);
      placed++;
      continue;
    }
    // The tip's exact line may have left the book (ladders move). Re-line to
    // the nearest quoted line, bet that, and update the published tip so the
    // tip and its bet always say the same thing.
    const match = matchById.get(tip.match_id);
    const newLine = match ? nearestQuotedLine(match, tip) : null;
    if (newLine === null) continue; // nothing close enough — retry next pass
    const retry = placeBet(user.id, tip.match_id, tip.market, newLine, tip.selection, stake);
    if (retry.bet) {
      db.prepare("UPDATE tips SET line = ?, label = ?, bet_id = ? WHERE id = ?").run(
        newLine,
        retry.bet.label,
        retry.bet.id,
        tip.id
      );
      placed++;
    }
  }
  return { placed, tips: openTips.length };
}
