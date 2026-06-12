export const MARKET_TYPES = [
  "h2h",
  "ah_goals",
  "ah_corners",
  "ou_goals",
  "ou_corners",
  "ou_cards",
  "btts",
  "correct_score",
] as const;
export type MarketType = (typeof MARKET_TYPES)[number];

export type MatchStatus = "scheduled" | "finished" | "void";
export type BetStatus = "pending" | "won" | "lost" | "void" | "cancelled";
export type Pick3 = "home" | "draw" | "away";

export interface User {
  id: number;
  username: string;
  balance_points: number;
  is_admin: number;
  is_bot: number; // 1 = tipster bot account betting its own tips
  created_at: string;
}

export interface Match {
  id: number;
  api_id: string | null;
  home_team: string;
  away_team: string;
  kickoff: string; // ISO 8601 UTC
  group_name: string | null;
  venue: string | null;
  status: MatchStatus;
  home_score: number | null;
  away_score: number | null;
  corners_home: number | null;
  corners_away: number | null;
  cards_total: number | null;
  result: Pick3 | null;
  odds_home: number | null; // decimal odds x1000 (1X2 anchor market)
  odds_draw: number | null;
  odds_away: number | null;
  odds_updated_at: string | null;
  odds_source: "seed" | "live";
  oio_event_id: string | null; // odds-api.io event id (per-market odds sync)
}

export interface Bet {
  id: number;
  user_id: number;
  match_id: number;
  market: MarketType;
  line: number | null; // e.g. -0.75 for AH, 2.5 for O/U
  selection: string; // 'home'|'draw'|'away'|'over'|'under'|'2-1'|'other_home'...
  label: string; // display, e.g. "Asian Handicap −0.75 · Mexico"
  stake_points: number;
  odds: number; // decimal odds x1000, locked at placement
  potential_payout_points: number;
  payout_points: number | null; // actual credit when settled
  status: BetStatus;
  created_at: string;
  settled_at: string | null;
}

export interface BetWithMatch extends Bet {
  home_team: string;
  away_team: string;
  kickoff: string;
  match_status: MatchStatus;
  home_score: number | null;
  away_score: number | null;
}

export interface OpenBetRow extends BetWithMatch {
  username: string;
  is_bot: number;
}

export interface Txn {
  id: number;
  user_id: number;
  amount_points: number;
  balance_after_points: number;
  type: string;
  bet_id: number | null;
  note: string | null;
  created_at: string;
}

export interface LeaderboardRow {
  id: number;
  username: string;
  is_bot: number;
  balance_points: number;
  in_play_points: number;
  wins: number;
  losses: number;
  pending: number;
}

export interface Tip {
  id: number;
  match_id: number;
  expert: string;
  avatar: string;
  market: MarketType;
  line: number | null;
  selection: string;
  label: string;
  confidence: number; // 1-5
  rationale: string;
  source: "openai" | "model";
  created_at: string;
  bet_id: number | null; // the bet the tipster's bot account placed on this tip
}
