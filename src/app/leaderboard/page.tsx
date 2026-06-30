import { getCurrentUser } from "@/lib/auth";
import { fmtPts, STARTING_BALANCE_POINTS } from "@/lib/money";
import { tipsterAvatar } from "@/lib/tipster-bets";
import { getLeaderboard } from "@/lib/users";
import LeaderboardTable, { type LeaderRow } from "@/components/LeaderboardTable";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const user = await getCurrentUser();
  const rows: LeaderRow[] = getLeaderboard().map((r) => ({
    id: r.id,
    username: r.username,
    isBot: r.is_bot === 1,
    isAdmin: r.is_admin === 1,
    avatar: r.is_bot === 1 ? tipsterAvatar(r.username) : null,
    balance_points: r.balance_points,
    in_play_points: r.in_play_points,
    volume_points: r.volume_points,
    wins: r.wins,
    losses: r.losses,
  }));
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-2xl font-bold">Leaderboard</h1>
      <p className="mb-6 text-sm text-slate-400">
        Ranked by total worth (balance + stakes in play). Everyone started with{" "}
        {fmtPts(STARTING_BALANCE_POINTS)} pts.
      </p>
      <LeaderboardTable rows={rows} meId={user?.id ?? null} />
    </div>
  );
}
