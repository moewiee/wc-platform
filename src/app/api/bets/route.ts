import { NextResponse } from "next/server";
import { apiError, betPayload } from "@/lib/api";
import { getUserFromRequest } from "@/lib/auth";
import { listUserBets, placeBet } from "@/lib/bets";
import type { MarketType } from "@/lib/types";

export const dynamic = "force-dynamic";

const MARKETS: ReadonlySet<string> = new Set([
  "h2h",
  "ah_goals",
  "ah_corners",
  "ou_goals",
  "ou_corners",
  "ou_cards",
  "correct_score",
]);

// GET /api/bets — the authenticated user's bets.
export async function GET(req: Request) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  return NextResponse.json({
    balance_points: user.balance_points,
    bets: listUserBets(user.id).map(betPayload),
  });
}

// POST /api/bets — place a bet.
// Body: { match_id, market, line?, selection, stake_points }
export async function POST(req: Request) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  let body: {
    match_id?: number;
    market?: string;
    line?: number | null;
    selection?: string;
    stake_points?: number;
  };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body.");
  }
  const matchId = Number(body.match_id);
  const market = String(body.market ?? "");
  const line =
    body.line === undefined || body.line === null ? null : Number(body.line);
  const selection = String(body.selection ?? "");
  const stake = Number(body.stake_points);
  if (!Number.isInteger(matchId)) return apiError(400, "match_id must be an integer.");
  if (!MARKETS.has(market)) return apiError(400, `Unknown market "${market}".`);
  if (line !== null && !Number.isFinite(line)) return apiError(400, "line must be a number or null.");
  if (!selection) return apiError(400, "selection is required.");
  if (!Number.isInteger(stake)) return apiError(400, "stake_points must be an integer.");
  const res = placeBet(user.id, matchId, market as MarketType, line, selection, stake);
  if (!res.bet) return apiError(400, res.error ?? "Could not place the bet.");
  return NextResponse.json({ bet: betPayload(res.bet) }, { status: 201 });
}
