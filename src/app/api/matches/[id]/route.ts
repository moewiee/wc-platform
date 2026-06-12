import { NextResponse } from "next/server";
import { apiError, matchPayload } from "@/lib/api";
import { getMatch, maybeRefreshOdds } from "@/lib/matches";
import { getTips } from "@/lib/tips";

export const dynamic = "force-dynamic";

// GET /api/matches/:id — one match with markets and expert tips.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isInteger(matchId)) return apiError(400, "Invalid match id.");
  await maybeRefreshOdds().catch(() => {});
  const match = getMatch(matchId);
  if (!match) return apiError(404, "Match not found.");
  return NextResponse.json({
    match: matchPayload(match),
    tips: getTips(match.id).map((t) => ({
      expert: t.expert,
      market: t.market,
      line: t.line,
      selection: t.selection,
      label: t.label,
      confidence: t.confidence,
      rationale: t.rationale,
      source: t.source,
    })),
  });
}
