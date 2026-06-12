"use client";

import { useEffect, useState } from "react";

interface LiveRow {
  match_id: number;
  home_score: number;
  away_score: number;
  clock: string;
}

// Big in-play score for the match page hero. Renders nothing until the match
// has kicked off and the live feed has it (mounted client-side only, so no
// SSR/hydration mismatch).
export default function LiveScore({
  matchId,
  kickoff,
}: {
  matchId: number;
  kickoff: string;
}) {
  const [started, setStarted] = useState(false);
  useEffect(() => {
    const update = () => setStarted(Date.parse(kickoff) <= Date.now());
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [kickoff]);

  const [live, setLive] = useState<LiveRow | null>(null);
  useEffect(() => {
    if (!started) return;
    let stopped = false;
    const poll = async () => {
      try {
        const res = await fetch("/api/live", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { live?: LiveRow[] };
        const s = (data.live ?? []).find((x) => x.match_id === matchId);
        if (!stopped && s) setLive(s);
      } catch {
        // keep the previous score on network hiccups
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 60_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [started, matchId]);

  if (!started || !live) return null;

  return (
    <div className="mt-3">
      <span className="rounded bg-rose-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-rose-400">
        LIVE {live.clock}
      </span>
      <div className="mt-1 font-mono text-3xl font-bold text-rose-400">
        {live.home_score} – {live.away_score}
      </div>
    </div>
  );
}
