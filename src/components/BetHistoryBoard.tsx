"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import LocalTime from "./LocalTime";
import { fmtOdds, fmtPts } from "@/lib/money";

// Settlement outcome for a resolved ticket (cancelled is never shown here).
export type HistoryStatus = "won" | "lost" | "void";

// One leg of a settled parlay shown on the history board.
export interface HistoryBetLeg {
  matchId: number;
  matchLabel: string; // "Canada vs Bosnia and Herzegovina"
  label: string; // "Asian Handicap -0.5 · Canada -0.5"
  odds: number; // x1000
  legStatus: string; // win | lose | push | half_win | half_lose | pending
}

// One serialized settled ticket for the public history board (computed
// server-side). A single bet has one match; a parlay carries its legs.
export interface HistoryBetView {
  id: string; // "s<betId>" or "p<parlayId>" (unique across both kinds)
  kind: "single" | "parlay";
  player: string;
  isBot: boolean;
  avatar: string | null;
  matchId: number; // single: the match; parlay: 0 (legs carry the matches)
  matchLabel: string; // single: "Canada vs Bosnia"; parlay: "Parlay · 3 legs"
  label: string; // single: selection label; parlay: "" (legs rendered instead)
  odds: number; // x1000 (parlay: combined odds)
  stake: number;
  payout: number; // points credited on settlement (0 on a loss)
  status: HistoryStatus;
  inPlay: boolean; // true = struck after kickoff (live); parlays are pre-match only
  settledAt: string;
  legs?: HistoryBetLeg[]; // parlay only
}

type GroupBy = "none" | "match" | "player";
type SortBy = "settled" | "stake" | "payout" | "profit" | "odds";

const profit = (b: HistoryBetView) => b.payout - b.stake;

const SORTS: Record<SortBy, (a: HistoryBetView, b: HistoryBetView) => number> = {
  settled: (a, b) => b.settledAt.localeCompare(a.settledAt),
  stake: (a, b) => b.stake - a.stake,
  payout: (a, b) => b.payout - a.payout,
  profit: (a, b) => profit(b) - profit(a),
  odds: (a, b) => b.odds - a.odds,
};

const STATUS_STYLE: Record<HistoryStatus, string> = {
  won: "bg-emerald-500/20 text-emerald-400",
  lost: "bg-red-500/20 text-red-400",
  void: "bg-slate-500/20 text-slate-300",
};

const STATUS_LABEL: Record<HistoryStatus, string> = {
  won: "Won",
  lost: "Lost",
  void: "Void",
};

interface Group {
  key: string;
  title: string;
  href?: string;
  bets: HistoryBetView[];
}

function buildGroups(bets: HistoryBetView[], groupBy: GroupBy, sortBy: SortBy): Group[] {
  const sorted = [...bets].sort(SORTS[sortBy]);
  if (groupBy === "none") return [{ key: "all", title: "", bets: sorted }];
  const groups = new Map<string, Group>();
  for (const bet of sorted) {
    // Parlays span multiple matches, so under "group by match" they get their
    // own bucket rather than being forced under a single match.
    let key: string, title: string, href: string | undefined;
    if (groupBy === "match") {
      if (bet.kind === "parlay") {
        key = "parlays";
        title = "Parlays";
        href = undefined;
      } else {
        key = `m${bet.matchId}`;
        title = bet.matchLabel;
        href = `/matches/${bet.matchId}`;
      }
    } else {
      key = bet.player;
      title = `${bet.avatar ? `${bet.avatar} ` : ""}${bet.player}`;
      href = undefined;
    }
    let g = groups.get(key);
    if (!g) {
      g = { key, title, href, bets: [] };
      groups.set(key, g);
    }
    g.bets.push(bet);
  }
  // Order groups by their best bet under the active sort.
  return [...groups.values()].sort((a, b) => SORTS[sortBy](a.bets[0], b.bets[0]));
}

function Select<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-slate-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="rounded-md border border-[#1b2c4a] bg-[#13243f] px-2 py-1.5 text-sm font-semibold text-slate-200"
      >
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function TimingBadge({ inPlay }: { inPlay: boolean }) {
  return inPlay ? (
    <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-bold text-red-400">
      In-play
    </span>
  ) : (
    <span className="rounded bg-sky-500/20 px-1.5 py-0.5 text-xs font-bold text-sky-300">
      Pre-match
    </span>
  );
}

function StatusBadge({ status }: { status: HistoryStatus }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-xs font-bold ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

export default function BetHistoryBoard({ bets }: { bets: HistoryBetView[] }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("none");
  const [sortBy, setSortBy] = useState<SortBy>("settled");

  const groups = useMemo(() => buildGroups(bets, groupBy, sortBy), [bets, groupBy, sortBy]);
  const totals = useMemo(
    () =>
      bets.reduce(
        (t, b) => {
          t.staked += b.stake;
          t.returned += b.payout;
          return t;
        },
        { staked: 0, returned: 0 }
      ),
    [bets]
  );

  if (bets.length === 0) {
    return (
      <div className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-8 text-center text-slate-400">
        No settled bets yet.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Select
          label="Group by"
          value={groupBy}
          options={[
            ["none", "Nothing"],
            ["match", "Match"],
            ["player", "Player"],
          ]}
          onChange={setGroupBy}
        />
        <Select
          label="Sort by"
          value={sortBy}
          options={[
            ["settled", "Settled"],
            ["stake", "Stake"],
            ["payout", "Payout"],
            ["profit", "Profit"],
            ["odds", "Odds"],
          ]}
          onChange={setSortBy}
        />
        <span className="ml-auto text-xs text-slate-400">
          {bets.length} bets · {fmtPts(totals.staked)} staked · {fmtPts(totals.returned)} returned
        </span>
      </div>

      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.key} className="overflow-hidden rounded-lg border border-[#1b2c4a]">
            {g.title && (
              <div className="flex items-baseline justify-between bg-[#13243f] px-4 py-2.5">
                <span className="font-bold text-slate-100">
                  {g.href ? (
                    <Link href={g.href} className="hover:text-[#ffd166]">
                      {g.title}
                    </Link>
                  ) : (
                    g.title
                  )}
                </span>
                <span className="text-xs text-slate-400">
                  {g.bets.length} bet{g.bets.length === 1 ? "" : "s"} ·{" "}
                  {fmtPts(g.bets.reduce((s, b) => s + b.stake, 0))} pts
                </span>
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[#0e1c33] text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2">Player</th>
                    <th className="px-4 py-2">Bet</th>
                    {groupBy !== "match" && <th className="px-4 py-2">Match</th>}
                    <th className="px-4 py-2 text-right">Odds</th>
                    <th className="px-4 py-2 text-right">Stake</th>
                    <th className="px-4 py-2">Result</th>
                    <th className="px-4 py-2 text-right">Payout</th>
                    <th className="px-4 py-2 text-right">Settled</th>
                  </tr>
                </thead>
                <tbody>
                  {g.bets.map((b) => (
                    <tr key={b.id} className="border-t border-[#13233f] odd:bg-[#0a1628] even:bg-[#0e1c33]">
                      <td className="px-4 py-2.5 font-semibold whitespace-nowrap">
                        {b.avatar ? `${b.avatar} ` : ""}
                        {b.player}
                        {b.isBot && (
                          <span className="ml-1.5 rounded bg-[#13243f] px-1.5 py-0.5 text-xs font-normal text-slate-400">
                            tipster
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        {b.kind === "parlay" && b.legs ? (
                          <div className="space-y-1">
                            <span className="flex items-center gap-1.5">
                              <span className="rounded bg-[#13243f] px-1.5 py-0.5 text-xs font-bold text-[#ffd166]">
                                Parlay · {b.legs.length} legs
                              </span>
                              <TimingBadge inPlay={b.inPlay} />
                            </span>
                            {b.legs.map((leg, i) => (
                              <div key={i} className="text-xs text-slate-300">
                                <Link
                                  href={`/matches/${leg.matchId}`}
                                  className="text-slate-400 hover:text-[#ffd166]"
                                >
                                  {leg.matchLabel}
                                </Link>
                                <span className="text-slate-300"> · {leg.label} </span>
                                <span className="font-mono text-slate-500">{fmtOdds(leg.odds)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="flex flex-wrap items-center gap-1.5">
                            <span>{b.label}</span>
                            <TimingBadge inPlay={b.inPlay} />
                          </span>
                        )}
                      </td>
                      {groupBy !== "match" && (
                        <td className="px-4 py-2.5 whitespace-nowrap">
                          {b.kind === "parlay" ? (
                            <span className="text-slate-500">multiple</span>
                          ) : (
                            <Link href={`/matches/${b.matchId}`} className="text-slate-300 hover:text-[#ffd166]">
                              {b.matchLabel}
                            </Link>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-2.5 text-right font-mono">{fmtOdds(b.odds)}</td>
                      <td className="px-4 py-2.5 text-right font-mono">{fmtPts(b.stake)}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={b.status} />
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono">
                        {b.status === "won" ? (
                          <span className="text-[#f0b429]">{fmtPts(b.payout)}</span>
                        ) : b.status === "void" ? (
                          <span className="text-slate-400">{fmtPts(b.payout)}</span>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-right text-xs text-slate-400 whitespace-nowrap">
                        <LocalTime iso={b.settledAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
