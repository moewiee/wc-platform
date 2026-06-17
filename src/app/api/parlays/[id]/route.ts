import { NextResponse } from "next/server";
import { apiError, parlayPayload } from "@/lib/api";
import { getUserFromRequest } from "@/lib/auth";
import { cancelParlay, getUserParlay } from "@/lib/bets";

export const dynamic = "force-dynamic";

// GET /api/parlays/:id — one of the authenticated user's parlays.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return apiError(400, "Invalid parlay id.");
  const parlay = getUserParlay(user.id, id);
  if (!parlay) return apiError(404, "Parlay not found.");
  return NextResponse.json({ parlay: parlayPayload(parlay) });
}

// DELETE /api/parlays/:id — cancel an open parlay (within the cancel window,
// before any leg's match kicks off); refunds the stake.
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = getUserFromRequest(req);
  if (!user) return apiError(401, "Authenticate with a Bearer token or session cookie.");
  const id = Number((await params).id);
  if (!Number.isInteger(id)) return apiError(400, "Invalid parlay id.");
  const res = cancelParlay(user.id, id);
  if (res.error) return apiError(400, res.error);
  return NextResponse.json({ ok: true });
}
