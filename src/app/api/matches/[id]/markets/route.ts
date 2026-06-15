import { NextResponse } from "next/server";
import { getLiveContext, inPlayEnabled } from "@/lib/live";
import { liveMarketsForMatch, marketsForMatch } from "@/lib/markets";
import { getMatch } from "@/lib/matches";

export const dynamic = "force-dynamic";

// Live (and pre-match) market sheet for one match, polled by the match page.
// For a started match it returns real Bet365 in-play prices (or none, when
// suspended) plus the live score/clock and the suspension state.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isInteger(matchId)) {
    return NextResponse.json({ error: "Invalid match id." }, { status: 400 });
  }
  const match = getMatch(matchId);
  if (!match) return NextResponse.json({ error: "Match not found." }, { status: 404 });

  if (match.status !== "scheduled") {
    return NextResponse.json({
      inPlay: false,
      started: true,
      suspended: true,
      reason: match.status === "void" ? "Match voided — stakes refunded." : "Match finished — settling.",
      markets: [],
      live: null,
    });
  }

  const started = Date.parse(match.kickoff) <= Date.now();
  if (!started) {
    // Pre-match: the regular counter is open.
    return NextResponse.json({
      inPlay: false,
      started: false,
      suspended: false,
      markets: marketsForMatch(match),
      live: null,
    });
  }

  // In-play.
  if (!inPlayEnabled()) {
    return NextResponse.json({
      inPlay: true,
      started: true,
      suspended: true,
      reason: "In-play betting is closed for this match.",
      markets: [],
      live: null,
    });
  }
  const ctx = await getLiveContext(match);
  const markets =
    ctx.available && !ctx.suspended && ctx.minute !== null
      ? liveMarketsForMatch(match)
      : [];
  return NextResponse.json({
    inPlay: true,
    started: true,
    suspended: ctx.suspended || markets.length === 0,
    reason: ctx.reason || (markets.length === 0 ? "No live prices available right now." : ""),
    live: ctx.available
      ? { homeScore: ctx.homeScore, awayScore: ctx.awayScore, minute: ctx.minute, clock: ctx.clock }
      : null,
    markets,
  });
}
