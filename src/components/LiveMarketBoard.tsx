"use client";

import { useEffect, useState } from "react";
import type { MatchMarket } from "@/lib/markets";
import MarketBoard, { type LiveBoardState } from "./MarketBoard";

interface MarketsResponse {
  inPlay: boolean;
  started: boolean;
  suspended: boolean;
  reason?: string;
  markets: MatchMarket[];
  live: { homeScore: number; awayScore: number; minute: number | null; clock: string } | null;
}

// Live prices move with the match, so the in-play sheet is fetched client-side
// and refreshed on an interval (mounted-only, so there's no SSR/client
// timezone or score mismatch). Presentation is delegated to MarketBoard.
const POLL_MS = 15_000;

export default function LiveMarketBoard({
  matchId,
  matchLabel,
  kickoff,
  committedPoints,
  inPlayCommittedPoints,
}: {
  matchId: number;
  matchLabel: string;
  kickoff: string;
  committedPoints: number;
  inPlayCommittedPoints: number;
}) {
  const [data, setData] = useState<MarketsResponse | null>(null);

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/matches/${matchId}/markets`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as MarketsResponse;
        if (!stopped) setData(json);
      } catch {
        // network hiccup — keep showing the last sheet
      }
    };
    void poll();
    const t = setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [matchId]);

  if (!data) {
    return (
      <div className="space-y-3">
        <div className="h-9 animate-pulse rounded-md bg-rose-950/30" />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="h-28 animate-pulse rounded-lg bg-[#0e1c33]" />
          <div className="h-28 animate-pulse rounded-lg bg-[#0e1c33]" />
        </div>
      </div>
    );
  }

  const live: LiveBoardState = {
    suspended: data.suspended,
    reason: data.reason,
    clock: data.live?.clock ?? "LIVE",
    homeScore: data.live?.homeScore ?? 0,
    awayScore: data.live?.awayScore ?? 0,
  };

  return (
    <MarketBoard
      matchId={matchId}
      matchLabel={matchLabel}
      kickoff={kickoff}
      markets={data.markets}
      committedPoints={committedPoints}
      inPlayCommittedPoints={inPlayCommittedPoints}
      live={live}
    />
  );
}
