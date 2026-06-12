import Link from "next/link";
import CancelBetButton from "@/components/CancelBetButton";
import LocalTime from "@/components/LocalTime";
import { requireUser } from "@/lib/auth";
import { listUserBets } from "@/lib/bets";
import { fmtOdds, fmtPts } from "@/lib/money";
import { maybeSyncScores } from "@/lib/matches";
import type { BetStatus, BetWithMatch } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<BetStatus, string> = {
  pending: "bg-amber-950 text-amber-400 border-amber-900",
  won: "bg-emerald-950 text-emerald-400 border-emerald-900",
  lost: "bg-rose-950 text-rose-400 border-rose-900",
  void: "bg-slate-800 text-slate-400 border-slate-700",
  cancelled: "bg-slate-800 text-slate-400 border-slate-700",
};

function BetCard({ bet, now }: { bet: BetWithMatch; now: number }) {
  const cancellable =
    bet.status === "pending" &&
    bet.match_status === "scheduled" &&
    Date.parse(bet.kickoff) > now;
  // payout_points is the actual credit; net = payout - stake for settled bets.
  const net =
    bet.payout_points !== null ? bet.payout_points - bet.stake_points : null;
  return (
    <div className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <Link
            href={`/matches/${bet.match_id}`}
            className="block truncate text-sm text-slate-400 hover:text-slate-200"
          >
            {bet.home_team} vs {bet.away_team}
            {bet.match_status === "finished" &&
              ` · ${bet.home_score}–${bet.away_score}`}{" "}
            · <LocalTime iso={bet.kickoff} />
          </Link>
          <div className="mt-1 font-semibold">
            {bet.label}{" "}
            <span className="font-normal text-slate-400">
              — {fmtPts(bet.stake_points)} pts @ {fmtOdds(bet.odds)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono font-semibold text-slate-200">
              {bet.status === "pending"
                ? `${fmtPts(bet.potential_payout_points)} pts`
                : bet.status === "cancelled" || bet.status === "void"
                  ? `${fmtPts(bet.payout_points ?? bet.stake_points)} pts`
                  : `${net !== null && net >= 0 ? "+" : ""}${fmtPts(net ?? 0)} pts`}
            </div>
            <div className="text-xs text-slate-500">
              {bet.status === "pending"
                ? bet.match_status === "finished"
                  ? "awaiting data"
                  : "potential payout"
                : bet.status === "won" || bet.status === "lost"
                  ? "net result"
                  : "refunded"}
            </div>
          </div>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLES[bet.status]}`}
          >
            {bet.status}
          </span>
        </div>
      </div>
      {cancellable && (
        <div className="mt-3">
          <CancelBetButton betId={bet.id} />
        </div>
      )}
    </div>
  );
}

export default async function MyBetsPage() {
  const user = await requireUser();
  await maybeSyncScores().catch(() => {});
  const bets = listUserBets(user.id);
  const open = bets.filter((b) => b.status === "pending");
  const settled = bets.filter((b) => b.status !== "pending");
  const now = Date.now();

  const inPlay = open.reduce((s, b) => s + b.stake_points, 0);
  const potential = open.reduce((s, b) => s + b.potential_payout_points, 0);
  const wins = bets.filter((b) => b.status === "won").length;
  const losses = bets.filter((b) => b.status === "lost").length;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">My bets</h1>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Balance", `${fmtPts(user.balance_points)} pts`],
            ["In play", `${fmtPts(inPlay)} pts`],
            ["Potential payout", `${fmtPts(potential)} pts`],
            ["Record", `${wins}W – ${losses}L`],
          ].map(([label, value]) => (
            <div
              key={label}
              className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-4"
            >
              <div className="text-xs uppercase tracking-wide text-slate-500">
                {label}
              </div>
              <div className="mt-1 font-mono text-lg font-bold text-[#f0b429]">
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>

      <section>
        <h2 className="mb-3 font-bold text-slate-300">
          Open bets ({open.length})
        </h2>
        {open.length === 0 ? (
          <p className="text-sm text-slate-500">
            No open bets —{" "}
            <Link href="/" className="text-[#f0b429] hover:underline">
              browse the odds board
            </Link>
            .
          </p>
        ) : (
          <div className="space-y-3">
            {open.map((b) => (
              <BetCard key={b.id} bet={b} now={now} />
            ))}
          </div>
        )}
      </section>

      {settled.length > 0 && (
        <section>
          <h2 className="mb-3 font-bold text-slate-300">Settled</h2>
          <div className="space-y-3">
            {settled.map((b) => (
              <BetCard key={b.id} bet={b} now={now} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
