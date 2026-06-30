"use client";

import { useMemo, useState } from "react";
import { fmtPts, STARTING_BALANCE_POINTS } from "@/lib/money";

const MEDALS = ["🥇", "🥈", "🥉"];

// One serialized leaderboard row (avatar precomputed server-side, since the
// tipster registry is server-only).
export interface LeaderRow {
  id: number;
  username: string;
  isBot: boolean;
  isAdmin: boolean;
  avatar: string | null;
  balance_points: number;
  in_play_points: number;
  volume_points: number;
  wins: number;
  losses: number;
}

export default function LeaderboardTable({
  rows,
  meId,
}: {
  rows: LeaderRow[];
  meId: number | null;
}) {
  // Exclude non-players (tipster bots + admin) to rank only real players.
  const [playersOnly, setPlayersOnly] = useState(false);
  const visible = useMemo(
    () => (playersOnly ? rows.filter((r) => !r.isBot && !r.isAdmin) : rows),
    [rows, playersOnly]
  );

  return (
    <div>
      <div className="mb-4 flex items-center">
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
      </div>
      <div className="overflow-x-auto rounded-lg border border-[#1b2c4a]">
        <table className="w-full text-sm">
          <thead className="bg-[#13243f] text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3 text-right">Balance</th>
              <th className="px-4 py-3 text-right">In play</th>
              <th className="px-4 py-3 text-right">W–L</th>
              <th className="px-4 py-3 text-right">Volume</th>
              <th className="px-4 py-3 text-right">Profit</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r, i) => {
              const worth = r.balance_points + r.in_play_points;
              const profit = worth - STARTING_BALANCE_POINTS;
              const isMe = meId === r.id;
              return (
                <tr
                  key={r.id}
                  className={`border-t border-[#13233f] ${
                    isMe ? "bg-[#f0b429]/10" : "odd:bg-[#0a1628] even:bg-[#0e1c33]"
                  }`}
                >
                  <td className="px-4 py-3 font-mono">{MEDALS[i] ?? i + 1}</td>
                  <td className="px-4 py-3 font-semibold">
                    {r.isBot ? `${r.avatar ?? "🎙️"} ` : ""}
                    {r.username}
                    {r.isBot ? (
                      <span className="ml-2 rounded bg-[#13243f] px-1.5 py-0.5 text-xs font-normal text-slate-400">
                        tipster
                      </span>
                    ) : null}
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
                  <td className="px-4 py-3 text-right font-mono text-slate-400">
                    {fmtPts(r.volume_points)}
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
      {visible.length === 0 && (
        <p className="mt-6 text-center text-slate-500">
          {rows.length === 0
            ? "No players yet — be the first to join."
            : "No players to show."}
        </p>
      )}
    </div>
  );
}
