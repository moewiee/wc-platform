"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import LocalTime from "./LocalTime";
import { fmtOdds, fmtPts } from "@/lib/money";

// One serialized in-play bet for the public board (computed server-side).
export interface OpenBetView {
  id: number;
  player: string;
  isBot: boolean;
  avatar: string | null;
  matchId: number;
  matchLabel: string; // "Canada vs Bosnia and Herzegovina"
  kickoff: string;
  label: string; // "Asian Handicap -0.5 · Canada -0.5"
  odds: number; // x1000
  stake: number;
  toWin: number;
  placedAt: string;
}

type GroupBy = "none" | "match" | "player";
type SortBy = "newest" | "stake" | "towin" | "odds" | "kickoff";

const SORTS: Record<SortBy, (a: OpenBetView, b: OpenBetView) => number> = {
  newest: (a, b) => b.placedAt.localeCompare(a.placedAt),
  stake: (a, b) => b.stake - a.stake,
  towin: (a, b) => b.toWin - a.toWin,
  odds: (a, b) => b.odds - a.odds,
  kickoff: (a, b) => a.kickoff.localeCompare(b.kickoff) || b.stake - a.stake,
};

interface Group {
  key: string;
  title: string;
  href?: string;
  bets: OpenBetView[];
}

function buildGroups(bets: OpenBetView[], groupBy: GroupBy, sortBy: SortBy): Group[] {
  const sorted = [...bets].sort(SORTS[sortBy]);
  if (groupBy === "none") return [{ key: "all", title: "", bets: sorted }];
  const groups = new Map<string, Group>();
  for (const bet of sorted) {
    const key = groupBy === "match" ? `m${bet.matchId}` : bet.player;
    let g = groups.get(key);
    if (!g) {
      g =
        groupBy === "match"
          ? { key, title: bet.matchLabel, href: `/matches/${bet.matchId}`, bets: [] }
          : { key, title: `${bet.avatar ? `${bet.avatar} ` : ""}${bet.player}`, bets: [] };
      groups.set(key, g);
    }
    g.bets.push(bet);
  }
  // Order groups by their best bet under the active sort, so e.g. sorting by
  // kickoff lists matches chronologically and by stake puts whales on top.
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

export default function OpenBetsBoard({ bets }: { bets: OpenBetView[] }) {
  const [groupBy, setGroupBy] = useState<GroupBy>("match");
  const [sortBy, setSortBy] = useState<SortBy>("kickoff");
  // Live state depends on the clock; compute after mount so SSR and the
  // first client render agree (same pattern as LocalTime).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const groups = useMemo(() => buildGroups(bets, groupBy, sortBy), [bets, groupBy, sortBy]);
  const totalStaked = useMemo(() => bets.reduce((s, b) => s + b.stake, 0), [bets]);

  if (bets.length === 0) {
    return (
      <div className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-8 text-center text-slate-400">
        No bets in play right now.
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
            ["match", "Match"],
            ["player", "Player"],
            ["none", "Nothing"],
          ]}
          onChange={setGroupBy}
        />
        <Select
          label="Sort by"
          value={sortBy}
          options={[
            ["kickoff", "Kickoff"],
            ["newest", "Newest"],
            ["stake", "Stake"],
            ["towin", "To win"],
            ["odds", "Odds"],
          ]}
          onChange={setSortBy}
        />
        <span className="ml-auto text-xs text-slate-400">
          {bets.length} bets · {fmtPts(totalStaked)} pts in play
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
                  {g.href && now !== null && Date.parse(g.bets[0].kickoff) <= now && (
                    <span className="ml-2 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-bold text-red-400">
                      LIVE
                    </span>
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
                    <th className="px-4 py-2 text-right">To win</th>
                    <th className="px-4 py-2 text-right">Placed</th>
                  </tr>
                </thead>
                <tbody>
                  {g.bets.map((b) => {
                    const live = now !== null && Date.parse(b.kickoff) <= now;
                    return (
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
                        <td className="px-4 py-2.5">{b.label}</td>
                        {groupBy !== "match" && (
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            <Link href={`/matches/${b.matchId}`} className="text-slate-300 hover:text-[#ffd166]">
                              {b.matchLabel}
                            </Link>
                            {live && (
                              <span className="ml-1.5 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-bold text-red-400">
                                LIVE
                              </span>
                            )}
                          </td>
                        )}
                        <td className="px-4 py-2.5 text-right font-mono">{fmtOdds(b.odds)}</td>
                        <td className="px-4 py-2.5 text-right font-mono">{fmtPts(b.stake)}</td>
                        <td className="px-4 py-2.5 text-right font-mono text-[#f0b429]">
                          {fmtPts(b.toWin)}
                        </td>
                        <td className="px-4 py-2.5 text-right text-xs text-slate-400 whitespace-nowrap">
                          <LocalTime iso={b.placedAt} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
