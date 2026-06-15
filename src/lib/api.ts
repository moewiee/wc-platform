import { NextResponse } from "next/server";
import { marketsForMatch } from "./markets";
import type { Bet, Match, User } from "./types";

export function apiError(status: number, message: string): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function userPayload(user: User) {
  return {
    id: user.id,
    username: user.username,
    balance_points: user.balance_points,
    is_admin: !!user.is_admin,
    created_at: user.created_at,
  };
}

export function matchPayload(match: Match, includeMarkets = true) {
  const bettable =
    match.status === "scheduled" && Date.parse(match.kickoff) > Date.now();
  return {
    id: match.id,
    home_team: match.home_team,
    away_team: match.away_team,
    kickoff: match.kickoff,
    group: match.group_name,
    venue: match.venue,
    status: match.status,
    bettable,
    home_score: match.home_score,
    away_score: match.away_score,
    corners_home: match.corners_home,
    corners_away: match.corners_away,
    cards_total: match.cards_total,
    result: match.result,
    odds_updated_at: match.odds_updated_at,
    odds_source: match.odds_source,
    // markets/odds are only quoted while the counter is open
    markets: includeMarkets && bettable ? marketsForMatch(match) : [],
  };
}

export function betPayload(bet: Bet) {
  return {
    id: bet.id,
    match_id: bet.match_id,
    market: bet.market,
    line: bet.line,
    selection: bet.selection,
    label: bet.label,
    stake_points: bet.stake_points,
    odds: bet.odds,
    potential_payout_points: bet.potential_payout_points,
    payout_points: bet.payout_points,
    status: bet.status,
    in_play: !!bet.in_play,
    created_at: bet.created_at,
    settled_at: bet.settled_at,
  };
}
