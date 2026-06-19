import type { Metadata } from "next";
import BetHistoryBoard, { type HistoryBetView, type HistoryStatus } from "@/components/BetHistoryBoard";
import { listSettledBets, listSettledParlays } from "@/lib/bets";
import { tipsterAvatar } from "@/lib/tipster-bets";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Bet history — WC26BET" };

export default function BetHistoryPage() {
  const singles: HistoryBetView[] = listSettledBets().map((b) => ({
    id: `s${b.id}`,
    kind: "single" as const,
    player: b.username,
    isBot: b.is_bot === 1,
    avatar: b.is_bot === 1 ? tipsterAvatar(b.username) : null,
    matchId: b.match_id,
    matchLabel: `${b.home_team} vs ${b.away_team}`,
    label: b.label,
    odds: b.odds,
    stake: b.stake_points,
    payout: b.payout_points ?? 0,
    status: b.status as HistoryStatus,
    inPlay: b.in_play === 1,
    settledAt: b.settled_at ?? b.created_at,
  }));

  const parlays: HistoryBetView[] = listSettledParlays().map((p) => ({
    id: `p${p.id}`,
    kind: "parlay" as const,
    player: p.username,
    isBot: p.is_bot === 1,
    avatar: p.is_bot === 1 ? tipsterAvatar(p.username) : null,
    matchId: 0,
    matchLabel: `Parlay · ${p.legs.length} legs`,
    label: "",
    odds: p.combined_odds,
    stake: p.stake_points,
    payout: p.payout_points ?? 0,
    status: p.status as HistoryStatus,
    inPlay: false, // parlays are pre-match only (CLAUDE.md rule)
    settledAt: p.settled_at ?? p.created_at,
    legs: p.legs.map((l) => ({
      matchId: l.match_id,
      matchLabel: `${l.home_team} vs ${l.away_team}`,
      label: l.label,
      odds: l.odds,
      legStatus: l.leg_status,
    })),
  }));

  const bets: HistoryBetView[] = [...singles, ...parlays];
  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-2xl font-bold">Bet history</h1>
      <p className="mb-6 text-sm text-slate-400">
        Every settled bet on the book — players and tipsters alike. Cancelled bets are hidden.
      </p>
      <BetHistoryBoard bets={bets} />
    </div>
  );
}
