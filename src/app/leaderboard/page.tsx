import { getCurrentUser } from "@/lib/auth";
import { fmtPts, STARTING_BALANCE_POINTS } from "@/lib/money";
import { getLeaderboard } from "@/lib/users";

export const dynamic = "force-dynamic";

const MEDALS = ["🥇", "🥈", "🥉"];

export default async function LeaderboardPage() {
  const user = await getCurrentUser();
  const rows = getLeaderboard();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-2xl font-bold">Leaderboard</h1>
      <p className="mb-6 text-sm text-slate-400">
        Ranked by total worth (balance + stakes in play). Everyone started with{" "}
        {fmtPts(STARTING_BALANCE_POINTS)} pts.
      </p>
      <div className="overflow-x-auto rounded-lg border border-[#1b2c4a]">
        <table className="w-full text-sm">
          <thead className="bg-[#13243f] text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3 text-right">Balance</th>
              <th className="px-4 py-3 text-right">In play</th>
              <th className="px-4 py-3 text-right">W–L</th>
              <th className="px-4 py-3 text-right">Profit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const worth = r.balance_points + r.in_play_points;
              const profit = worth - STARTING_BALANCE_POINTS;
              const isMe = user?.id === r.id;
              return (
                <tr
                  key={r.id}
                  className={`border-t border-[#13233f] ${
                    isMe ? "bg-[#f0b429]/10" : "odd:bg-[#0a1628] even:bg-[#0e1c33]"
                  }`}
                >
                  <td className="px-4 py-3 font-mono">{MEDALS[i] ?? i + 1}</td>
                  <td className="px-4 py-3 font-semibold">
                    {r.username}
                    {isMe && (
                      <span className="ml-2 text-xs font-normal text-[#f0b429]">
                        (you)
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono">
                    {fmtPts(r.balance_points)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-400">
                    {fmtPts(r.in_play_points)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-400">
                    {r.wins}–{r.losses}
                  </td>
                  <td
                    className={`px-4 py-3 text-right font-mono font-semibold ${
                      profit > 0
                        ? "text-emerald-400"
                        : profit < 0
                          ? "text-rose-400"
                          : "text-slate-400"
                    }`}
                  >
                    {profit > 0 ? "+" : ""}
                    {fmtPts(profit)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p className="mt-6 text-center text-slate-500">
          No players yet — be the first to join.
        </p>
      )}
    </div>
  );
}
