import { NextResponse } from "next/server";
import { matchPayload } from "@/lib/api";
import { listMatches, maybeRefreshOdds } from "@/lib/matches";

export const dynamic = "force-dynamic";

// GET /api/matches — every match with current odds for all markets.
export async function GET() {
  await maybeRefreshOdds().catch(() => {});
  return NextResponse.json({
    matches: listMatches().map((m) => matchPayload(m)),
  });
}
