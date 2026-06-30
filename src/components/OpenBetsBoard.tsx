"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import LocalTime from "./LocalTime";
import { fmtOdds, fmtPts } from "@/lib/money";

// One leg of a parlay shown on the public board.
export interface OpenBetLeg {
  matchId: number;
  matchLabel: string; // "Canada vs Bosnia and Herzegovina"
  kickoff: string;
  label: string; // "Asian Handicap -0.5 · Canada -0.5"
  odds: number; // x1000
}

// One serialized in-play ticket for the public board (computed server-side).
// A single bet has one match; a parlay carries its legs and spans matches.
export interface OpenBetView {
  id: string; // "s<betId>" or "p<parlayId>" (unique across both kinds)
  kind: "single" | "parlay";
  player: string;
  isBot: boolean;
  isAdmin: boolean;
  avatar: string | null;
  matchId: number; // single: the match; parlay: 0 (legs carry the matches)
  matchLabel: string; // single: "Canada vs Bosnia"; parlay: "Parlay · 3 legs"
  kickoff: string; // single: kickoff; parlay: earliest leg kickoff
  label: string; // single: selection label; parlay: "" (legs rendered instead)
  odds: number; // x1000 (parlay: combined odds)
  stake: number;
  toWin: number;
  placedAt: string;
  legs?: OpenBetLeg[]; // parlay only
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
  // Exclude non-players (tipster bots + admin) to see only real players' bets.
  const [playersOnly, setPlayersOnly] = useState(false);
  // Live state depends on the clock; compute after mount so SSR and the
  // first client render agree (same pattern as LocalTime).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);

  const visible = useMemo(
    () => (playersOnly ? bets.filter((b) => !b.isBot && !b.isAdmin) : bets),
    [bets, playersOnly]
  );
  const groups = useMemo(() => buildGroups(visible, groupBy, sortBy), [visible, groupBy, sortBy]);
  const totalStaked = useMemo(() => visible.reduce((s, b) => s + b.stake, 0), [visible]);

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
        <button
          type="button"
          onClick={() => setPlayersOnly((v) => !v)}
          aria-pressed={playersOnly}
          className={`rounded-md border px-3 py-1.5 text-sm font-semibold ${
            playersOnly
              ? "border-[#f0b429] bg-[#f0b429]/15 text-[#f0b429]"
              : "border-[#1b2c4a] bg-[#13243f] text-slate-300"
          }`}
        >
          {playersOnly ? "✓ " : ""}Players only
        </button>
        <span className="ml-auto text-xs text-slate-400">
          {visible.length} bets · {fmtPts(totalStaked)} pts in play
        </span>
      </div>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-8 text-center text-slate-400">
          No players&apos; bets in play right now.
        </div>
      ) : (
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
                        <td className="px-4 py-2.5">
                          {b.kind === "parlay" && b.legs ? (
                            <div className="space-y-1">
                              <span className="rounded bg-[#13243f] px-1.5 py-0.5 text-xs font-bold text-[#ffd166]">
                                Parlay · {b.legs.length} legs
                              </span>
                              {b.legs.map((leg, i) => {
                                const legLive = now !== null && Date.parse(leg.kickoff) <= now;
                                return (
                                  <div key={i} className="text-xs text-slate-300">
                                    <Link
                                      href={`/matches/${leg.matchId}`}
                                      className="text-slate-400 hover:text-[#ffd166]"
                                    >
                                      {leg.matchLabel}
                                    </Link>
                                    {legLive && (
                                      <span className="ml-1 rounded bg-red-500/20 px-1 text-[10px] font-bold text-red-400">
                                        LIVE
                                      </span>
                                    )}
                                    <span className="text-slate-300"> · {leg.label} </span>
                                    <span className="font-mono text-slate-500">{fmtOdds(leg.odds)}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            b.label
                          )}
                        </td>
                        {groupBy !== "match" && (
                          <td className="px-4 py-2.5 whitespace-nowrap">
                            {b.kind === "parlay" ? (
                              <span className="text-slate-500">multiple</span>
                            ) : (
                              <>
                                <Link href={`/matches/${b.matchId}`} className="text-slate-300 hover:text-[#ffd166]">
                                  {b.matchLabel}
                                </Link>
                                {live && (
                                  <span className="ml-1.5 rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-bold text-red-400">
                                    LIVE
                                  </span>
                                )}
                              </>
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
      )}
    </div>
  );
}
