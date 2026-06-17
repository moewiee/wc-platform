import { NextResponse } from "next/server";
import { apiError, parlayPayload } from "@/lib/api";
import { getUserFromRequest } from "@/lib/auth";
import { listUserParlays, placeParlay, type ParlayLegInput } from "@/lib/bets";
import { MARKET_TYPES, type MarketType } from "@/lib/types";

export const dynamic = "force-dynamic";

const MARKETS: ReadonlySet<string> = new Set(MARKET_TYPES);

// GET /api/parlays — the authenticated user's parlays (with legs).
export async function GET(req: Request) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  return NextResponse.json({
    balance_points: user.balance_points,
    parlays: listUserParlays(user.id).map(parlayPayload),
  });
}

// POST /api/parlays — place a cross-match accumulator.
// Body: { legs: [{ match_id, market, line?, selection }], stake_points }
export async function POST(req: Request) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  let body: {
    legs?: {
      match_id?: number;
      market?: string;
      line?: number | null;
      selection?: string;
    }[];
    stake_points?: number;
  };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body.");
  }
  if (!Array.isArray(body.legs) || body.legs.length === 0) {
    return apiError(400, "legs must be a non-empty array.");
  }
  const legs: ParlayLegInput[] = [];
  for (const [i, raw] of body.legs.entries()) {
    const matchId = Number(raw.match_id);
    const market = String(raw.market ?? "");
    const line =
      raw.line === undefined || raw.line === null ? null : Number(raw.line);
    const selection = String(raw.selection ?? "");
    if (!Number.isInteger(matchId)) return apiError(400, `legs[${i}].match_id must be an integer.`);
    if (!MARKETS.has(market)) return apiError(400, `legs[${i}].market "${market}" is unknown.`);
    if (line !== null && !Number.isFinite(line)) return apiError(400, `legs[${i}].line must be a number or null.`);
    if (!selection) return apiError(400, `legs[${i}].selection is required.`);
    legs.push({ matchId, market: market as MarketType, line, selection });
  }
  const stake = Number(body.stake_points);
  if (!Number.isInteger(stake)) return apiError(400, "stake_points must be an integer.");
  const res = await placeParlay(user.id, legs, stake);
  if (!res.parlay) return apiError(400, res.error ?? "Could not place the parlay.");
  return NextResponse.json({ parlay: parlayPayload(res.parlay) }, { status: 201 });
}
