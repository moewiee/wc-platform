import type { Metadata } from "next";
import OpenBetsBoard, { type OpenBetView } from "@/components/OpenBetsBoard";
import { listOpenBets } from "@/lib/bets";
import { tipsterAvatar } from "@/lib/tipster-bets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "In-play bets — WC26BET" };

export default function OpenBetsPage() {
  const bets: OpenBetView[] = listOpenBets().map((b) => ({
    id: b.id,
    player: b.username,
    isBot: b.is_bot === 1,
    avatar: b.is_bot === 1 ? tipsterAvatar(b.username) : null,
    matchId: b.match_id,
    matchLabel: `${b.home_team} vs ${b.away_team}`,
    kickoff: b.kickoff,
    label: b.label,
    odds: b.odds,
    stake: b.stake_points,
    toWin: b.potential_payout_points,
    placedAt: b.created_at,
  }));
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold">In-play bets</h1>
      <p className="mb-6 text-sm text-slate-400">
        Every unsettled bet on the book — players and tipsters alike.
      </p>
      <OpenBetsBoard bets={bets} />
    </div>
  );
}
