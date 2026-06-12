import { NextResponse } from "next/server";
import { apiError, betPayload } from "@/lib/api";
import { getUserFromRequest } from "@/lib/auth";
import { cancelBet, getUserBet } from "@/lib/bets";

export const dynamic = "force-dynamic";

// GET /api/bets/:id
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  const { id } = await params;
  const bet = getUserBet(user.id, Number(id));
  if (!bet) return apiError(404, "Bet not found.");
  return NextResponse.json({ bet: betPayload(bet) });
}

// DELETE /api/bets/:id — cancel an open bet (stake refunded). Allowed only
// within 30 minutes of placement and before kickoff.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  const { id } = await params;
  const betId = Number(id);
  if (!Number.isInteger(betId)) return apiError(400, "Invalid bet id.");
  const res = cancelBet(user.id, betId);
  if (res.error) return apiError(400, res.error);
  const bet = getUserBet(user.id, betId);
  return NextResponse.json({ bet: bet ? betPayload(bet) : null, cancelled: true });
}
