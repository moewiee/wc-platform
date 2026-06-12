import { notFound } from "next/navigation";
import LiveScore from "@/components/LiveScore";
import LocalTime from "@/components/LocalTime";
import MarketBoard from "@/components/MarketBoard";
import TipsPanel from "@/components/TipsPanel";
import { getCurrentUser } from "@/lib/auth";
import { listUserBetsForMatch } from "@/lib/bets";
import { marketsForMatch } from "@/lib/markets";
import { getMatch, maybeRefreshOdds, oddsRefreshMinutes } from "@/lib/matches";
import { fmtOdds, fmtPts } from "@/lib/money";
import { ensureModelTips, getTips } from "@/lib/tips";
import type { BetStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<BetStatus, string> = {
  pending: "bg-amber-950 text-amber-400 border-amber-900",
  won: "bg-emerald-950 text-emerald-400 border-emerald-900",
  lost: "bg-rose-950 text-rose-400 border-rose-900",
  void: "bg-slate-800 text-slate-400 border-slate-700",
  cancelled: "bg-slate-800 text-slate-400 border-slate-700",
};

export default async function MatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const matchId = Number(id);
  if (!Number.isInteger(matchId)) notFound();

  await maybeRefreshOdds().catch(() => {});
  const match = getMatch(matchId);
  if (!match) notFound();

  ensureModelTips(match);
  const tips = getTips(match.id);
  const user = await getCurrentUser();
  const myBets = user ? listUserBetsForMatch(user.id, match.id) : [];
  const markets = match.status === "scheduled" ? marketsForMatch(match) : [];

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="rounded-xl border border-[#1b2c4a] bg-gradient-to-b from-[#13243f] to-[#0e1c33] p-6 text-center">
        <div className="text-xs uppercase tracking-wide text-slate-400">
          FIFA World Cup 2026
          {match.group_name ? ` · Group ${match.group_name}` : ""}
          {match.venue ? ` · ${match.venue}` : ""} · <LocalTime iso={match.kickoff} />
        </div>
        <h1 className="mt-2 text-2xl font-black">
          {match.home_team} <span className="text-[#f0b429]">vs</span>{" "}
          {match.away_team}
        </h1>
        {match.status === "scheduled" && (
          <LiveScore matchId={match.id} kickoff={match.kickoff} />
        )}
        {match.status === "finished" && (
          <div className="mt-3">
            <div className="font-mono text-3xl font-bold text-[#f0b429]">
              {match.home_score} – {match.away_score}
            </div>
            <div className="mt-1 text-sm text-slate-400">
              {match.result === "draw"
                ? "Match drawn"
                : `${match.result === "home" ? match.home_team : match.away_team} won`}
              {match.corners_home !== null && match.corners_away !== null
                ? ` · Corners ${match.corners_home}-${match.corners_away}`
                : ""}
              {match.cards_total !== null ? ` · ${match.cards_total} cards` : ""}
            </div>
          </div>
        )}
        {match.status === "void" && (
          <div className="mt-3 text-sm text-slate-400">
            Match voided — all stakes refunded.
          </div>
        )}
        {match.odds_updated_at && match.status === "scheduled" && (
          <div className="mt-3 text-xs text-slate-500">
            Odds {match.odds_source === "live" ? "from live bookmakers" : "house prices"} ·
            updated <LocalTime iso={match.odds_updated_at} /> · refreshed every{" "}
            {oddsRefreshMinutes()} min · counter closes at kickoff
          </div>
        )}
      </div>

      <TipsPanel tips={tips} />

      {match.status === "scheduled" && (
        <MarketBoard
          matchId={match.id}
          matchLabel={`${match.home_team} vs ${match.away_team}`}
          kickoff={match.kickoff}
          markets={markets}
        />
      )}

      {myBets.length > 0 && (
        <section className="overflow-hidden rounded-lg border border-[#1b2c4a]">
          <h2 className="bg-[#13243f] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#f0b429]">
            Your bets on this match
          </h2>
          <ul className="divide-y divide-[#13233f] bg-[#0e1c33]">
            {myBets.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm"
              >
                <span>
                  <span className="font-semibold">{b.label}</span>{" "}
                  <span className="text-slate-400">
                    — {fmtPts(b.stake_points)} pts @ {fmtOdds(b.odds)}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono text-slate-300">
                    {b.status === "pending"
                      ? `→ ${fmtPts(b.potential_payout_points)} pts`
                      : `${fmtPts(b.payout_points ?? 0)} pts paid`}
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLES[b.status]}`}
                  >
                    {b.status}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
