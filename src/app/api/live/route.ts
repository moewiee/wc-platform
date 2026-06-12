import { NextResponse } from "next/server";
import { getLiveScores } from "@/lib/live";

export const dynamic = "force-dynamic";

// Public: in-play scores for the lobby board, keyed by match id.
export async function GET() {
  return NextResponse.json({ live: await getLiveScores() });
}
