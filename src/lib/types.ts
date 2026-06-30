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
export type ParlayStatus = BetStatus;
// Per-leg settlement state — mirrors SettleOutcome (markets.ts) exactly, so a
// leg can store the outcome verbatim.
export type LegStatus =
  | "pending"
  | "win"
  | "lose"
  | "push"
  | "half_win"
  | "half_lose";
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
  in_play: number; // 1 = struck after kickoff (live); display/audit only
  // Live score at placement (in-play bets only; NULL pre-match). In-play AH
  // settles on goals scored after this baseline — see settleSelection.
  live_home_score: number | null;
  live_away_score: number | null;
  // Live match period at placement (ESPN status.period: 1-2 regulation, 3-4
  // extra time, 5 penalties; NULL pre-match). A knockout bet struck in extra
  // time (>= 3) settles on the end-of-ET goal score; otherwise on the 90'
  // regulation result. See bets.ts isEtPhaseBet / settleMatch.
  live_period: number | null;
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
  is_admin: number;
}

// A pending parlay for the public in-play board (owner + legs joined).
export interface OpenParlayRow extends ParlayWithLegs {
  username: string;
  is_bot: number;
  is_admin: number;
}

export interface Txn {
  id: number;
  user_id: number;
  amount_points: number;
  balance_after_points: number;
  type: string;
  bet_id: number | null;
  parlay_id: number | null;
  note: string | null;
  created_at: string;
}

// Cross-match accumulator. Combined odds are the product of the legs' real
// locked quotes (never modelled). All-or-nothing: any losing leg loses the
// ticket; void/push legs collapse to odds 1.000 and the parlay recomputes on
// the rest.
export interface Parlay {
  id: number;
  user_id: number;
  stake_points: number;
  combined_odds: number; // decimal odds x1000, product of the legs, locked
  potential_payout_points: number;
  payout_points: number | null;
  status: ParlayStatus;
  created_at: string;
  settled_at: string | null;
}

export interface ParlayLeg {
  id: number;
  parlay_id: number;
  leg_seq: number;
  match_id: number;
  market: MarketType;
  line: number | null;
  selection: string;
  label: string;
  odds: number; // decimal odds x1000, locked at placement
  leg_status: LegStatus;
  settled_at: string | null;
}

export interface ParlayLegWithMatch extends ParlayLeg {
  home_team: string;
  away_team: string;
  kickoff: string;
  match_status: MatchStatus;
  home_score: number | null;
  away_score: number | null;
}

export interface ParlayWithLegs extends Parlay {
  legs: ParlayLegWithMatch[];
}

export interface LeaderboardRow {
  id: number;
  username: string;
  is_bot: number;
  is_admin: number;
  balance_points: number;
  in_play_points: number;
  volume_points: number; // total stake ever placed (excl. cancelled)
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
