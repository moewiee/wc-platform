import type { Metadata } from "next";
import OpenBetsBoard, { type OpenBetView } from "@/components/OpenBetsBoard";
import { listOpenBets, listOpenParlays } from "@/lib/bets";
import { tipsterAvatar } from "@/lib/tipster-bets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "In-play bets — WC26BET" };

export default function OpenBetsPage() {
  const singles: OpenBetView[] = listOpenBets().map((b) => ({
    id: `s${b.id}`,
    kind: "single" as const,
    player: b.username,
    isBot: b.is_bot === 1,
    isAdmin: b.is_admin === 1,
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

  const parlays: OpenBetView[] = listOpenParlays().map((p) => {
    const legs = p.legs.map((l) => ({
      matchId: l.match_id,
      matchLabel: `${l.home_team} vs ${l.away_team}`,
      kickoff: l.kickoff,
      label: l.label,
      odds: l.odds,
    }));
    // Earliest leg kickoff drives the LIVE badge and the "kickoff" sort.
    const earliest = legs.reduce(
      (min, l) => (l.kickoff < min ? l.kickoff : min),
      legs[0]?.kickoff ?? p.created_at
    );
    return {
      id: `p${p.id}`,
      kind: "parlay" as const,
      player: p.username,
      isBot: p.is_bot === 1,
      isAdmin: p.is_admin === 1,
      avatar: p.is_bot === 1 ? tipsterAvatar(p.username) : null,
      matchId: 0,
      matchLabel: `Parlay · ${legs.length} legs`,
      kickoff: earliest,
      label: "",
      odds: p.combined_odds,
      stake: p.stake_points,
      toWin: p.potential_payout_points,
      placedAt: p.created_at,
      legs,
    };
  });

  const bets: OpenBetView[] = [...singles, ...parlays];
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
