import Link from "next/link";
import CancelBetButton from "@/components/CancelBetButton";
import CancelParlayButton from "@/components/CancelParlayButton";
import LocalTime from "@/components/LocalTime";
import { requireUser } from "@/lib/auth";
import { CANCEL_WINDOW_MS, listUserBets, listUserParlays } from "@/lib/bets";
import { fmtOdds, fmtPts } from "@/lib/money";
import { maybeSyncScores } from "@/lib/matches";
import type {
  BetStatus,
  BetWithMatch,
  LegStatus,
  ParlayWithLegs,
} from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<BetStatus, string> = {
  pending: "bg-amber-950 text-amber-400 border-amber-900",
  won: "bg-emerald-950 text-emerald-400 border-emerald-900",
  lost: "bg-rose-950 text-rose-400 border-rose-900",
  void: "bg-slate-800 text-slate-400 border-slate-700",
  cancelled: "bg-slate-800 text-slate-400 border-slate-700",
};

const LEG_STATUS_STYLES: Record<LegStatus, string> = {
  pending: "text-amber-400",
  win: "text-emerald-400",
  lose: "text-rose-400",
  push: "text-slate-400",
  half_win: "text-emerald-400",
  half_lose: "text-rose-400",
};

const LEG_STATUS_LABEL: Record<LegStatus, string> = {
  pending: "open",
  win: "won",
  lose: "lost",
  push: "void",
  half_win: "½ won",
  half_lose: "½ lost",
};

function BetCard({ bet, now }: { bet: BetWithMatch; now: number }) {
  const cancellable =
    bet.status === "pending" &&
    bet.match_status === "scheduled" &&
    Date.parse(bet.kickoff) > now &&
    Date.parse(bet.created_at) + CANCEL_WINDOW_MS > now;
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
            {bet.in_play ? (
              <span className="mr-1.5 rounded bg-rose-950 px-1.5 py-0.5 align-middle text-[9px] font-bold uppercase tracking-wide text-rose-400">
                Live
              </span>
            ) : null}
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

function ParlayCard({ parlay, now }: { parlay: ParlayWithLegs; now: number }) {
  const cancellable =
    parlay.status === "pending" &&
    parlay.legs.every(
      (l) => l.match_status === "scheduled" && Date.parse(l.kickoff) > now
    ) &&
    Date.parse(parlay.created_at) + CANCEL_WINDOW_MS > now;
  const net =
    parlay.payout_points !== null
      ? parlay.payout_points - parlay.stake_points
      : null;
  return (
    <div className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded bg-[#1b2c4a] px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-[#f0b429]">
              Parlay
            </span>
            <span className="text-sm font-semibold text-slate-200">
              {parlay.legs.length} legs @ {fmtOdds(parlay.combined_odds)}
            </span>
          </div>
          <div className="text-xs text-slate-500">
            <LocalTime iso={parlay.created_at} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="font-mono font-semibold text-slate-200">
              {parlay.status === "pending"
                ? `${fmtPts(parlay.potential_payout_points)} pts`
                : parlay.status === "cancelled" || parlay.status === "void"
                  ? `${fmtPts(parlay.payout_points ?? parlay.stake_points)} pts`
                  : `${net !== null && net >= 0 ? "+" : ""}${fmtPts(net ?? 0)} pts`}
            </div>
            <div className="text-xs text-slate-500">
              {parlay.status === "pending"
                ? "potential payout"
                : parlay.status === "won" || parlay.status === "lost"
                  ? "net result"
                  : "refunded"}
            </div>
          </div>
          <span
            className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLES[parlay.status]}`}
          >
            {parlay.status}
          </span>
        </div>
      </div>

      <div className="mt-3 space-y-1.5 border-t border-[#1b2c4a] pt-3">
        {parlay.legs.map((leg) => (
          <div key={leg.leg_seq} className="flex items-center justify-between gap-2 text-sm">
            <div className="min-w-0">
              <Link
                href={`/matches/${leg.match_id}`}
                className="block truncate text-slate-200 hover:text-[#ffd166]"
              >
                {leg.label}
              </Link>
              <span className="truncate text-[11px] text-slate-500">
                {leg.home_team} vs {leg.away_team}
                {leg.match_status === "finished" &&
                  ` · ${leg.home_score}–${leg.away_score}`}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-mono text-xs text-slate-400">
                {fmtOdds(leg.odds)}
              </span>
              <span
                className={`text-[11px] font-semibold uppercase ${LEG_STATUS_STYLES[leg.leg_status]}`}
              >
                {LEG_STATUS_LABEL[leg.leg_status]}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-2 text-xs text-slate-500">
        Stake {fmtPts(parlay.stake_points)} pts
      </div>
      {cancellable && (
        <div className="mt-3">
          <CancelParlayButton parlayId={parlay.id} />
        </div>
      )}
    </div>
  );
}

type Entry =
  | { kind: "bet"; created_at: string; status: BetStatus; bet: BetWithMatch }
  | { kind: "parlay"; created_at: string; status: BetStatus; parlay: ParlayWithLegs };

export default async function MyBetsPage() {
  const user = await requireUser();
  await maybeSyncScores().catch(() => {});
  const bets = listUserBets(user.id);
  const parlays = listUserParlays(user.id);
  const now = Date.now();

  const entries: Entry[] = [
    ...bets.map(
      (b): Entry => ({ kind: "bet", created_at: b.created_at, status: b.status, bet: b })
    ),
    ...parlays.map(
      (p): Entry => ({
        kind: "parlay",
        created_at: p.created_at,
        status: p.status,
        parlay: p,
      })
    ),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const open = entries.filter((e) => e.status === "pending");
  const settled = entries.filter((e) => e.status !== "pending");

  const inPlay =
    bets.reduce((s, b) => s + (b.status === "pending" ? b.stake_points : 0), 0) +
    parlays.reduce((s, p) => s + (p.status === "pending" ? p.stake_points : 0), 0);
  const potential =
    bets.reduce(
      (s, b) => s + (b.status === "pending" ? b.potential_payout_points : 0),
      0
    ) +
    parlays.reduce(
      (s, p) => s + (p.status === "pending" ? p.potential_payout_points : 0),
      0
    );
  const wins =
    bets.filter((b) => b.status === "won").length +
    parlays.filter((p) => p.status === "won").length;
  const losses =
    bets.filter((b) => b.status === "lost").length +
    parlays.filter((p) => p.status === "lost").length;

  const renderEntry = (e: Entry) =>
    e.kind === "bet" ? (
      <BetCard key={`b${e.bet.id}`} bet={e.bet} now={now} />
    ) : (
      <ParlayCard key={`p${e.parlay.id}`} parlay={e.parlay} now={now} />
    );

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
          <div className="space-y-3">{open.map(renderEntry)}</div>
        )}
      </section>

      {settled.length > 0 && (
        <section>
          <h2 className="mb-3 font-bold text-slate-300">Settled</h2>
          <div className="space-y-3">{settled.map(renderEntry)}</div>
        </section>
      )}
    </div>
  );
}
