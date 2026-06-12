"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import OddsButton from "./OddsButton";
import type { SlipSelection } from "./BetSlip";

export interface BoardRow {
  id: number;
  home: string;
  away: string;
  kickoff: string;
  group: string | null;
  venue: string | null;
  status: string;
  homeScore: number | null;
  awayScore: number | null;
  h2h: { home: number; draw: number; away: number } | null;
  ah: { line: number; home: number; away: number } | null;
  ou: { line: number; over: number; under: number } | null;
  marketCount: number;
}

function fmtLine(line: number): string {
  if (line === 0) return "0";
  return line > 0 ? `+${line}` : `${line}`;
}

function sel(
  row: BoardRow,
  market: string,
  marketName: string,
  line: number | null,
  selection: string,
  selectionLabel: string,
  odds: number
): SlipSelection {
  return {
    matchId: row.id,
    matchLabel: `${row.home} vs ${row.away}`,
    kickoff: row.kickoff,
    market,
    marketName,
    line,
    selection,
    selectionLabel,
    odds,
  };
}

function MatchRow({ row, now }: { row: BoardRow; now: number }) {
  const started = Date.parse(row.kickoff) <= now;
  const open = row.status === "scheduled" && !started;
  const time = new Date(row.kickoff).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="grid grid-cols-[3.2rem_minmax(0,1fr)_auto] items-center gap-2 border-b border-[#13233f] bg-[#0e1c33] px-3 py-2 hover:bg-[#102140] sm:grid-cols-[3.5rem_minmax(0,1fr)_10rem_10rem_15rem_3rem]">
      <div className="text-center">
        <div className="font-mono text-xs text-slate-300">{time}</div>
        {row.group && (
          <div className="text-[10px] uppercase text-slate-500">Grp {row.group}</div>
        )}
        {row.status === "scheduled" && started && (
          <div className="mt-0.5 rounded bg-rose-950 px-1 text-[9px] font-bold text-rose-400">
            LIVE
          </div>
        )}
      </div>

      <Link href={`/matches/${row.id}`} className="min-w-0">
        <div className="truncate text-sm font-semibold text-slate-100 hover:text-[#ffd166]">
          {row.home}
          {row.status === "finished" && (
            <span className="ml-2 font-mono text-[#f0b429]">{row.homeScore}</span>
          )}
        </div>
        <div className="truncate text-sm font-semibold text-slate-100 hover:text-[#ffd166]">
          {row.away}
          {row.status === "finished" && (
            <span className="ml-2 font-mono text-[#f0b429]">{row.awayScore}</span>
          )}
        </div>
        {row.venue && (
          <div className="truncate text-[10px] text-slate-500">{row.venue}</div>
        )}
      </Link>

      {open && row.h2h ? (
        <>
          {/* Asian Handicap */}
          <div className="hidden flex-col items-center gap-1 sm:flex">
            {row.ah ? (
              <>
                <OddsButton
                  sub={fmtLine(row.ah.line)}
                  sel={sel(row, "ah_goals", `Asian Handicap ${fmtLine(row.ah.line)}`, row.ah.line, "home", `${row.home} ${fmtLine(row.ah.line)}`, row.ah.home)}
                />
                <OddsButton
                  sub={fmtLine(-row.ah.line)}
                  sel={sel(row, "ah_goals", `Asian Handicap ${fmtLine(row.ah.line)}`, row.ah.line, "away", `${row.away} ${fmtLine(-row.ah.line)}`, row.ah.away)}
                />
              </>
            ) : (
              <span className="text-xs text-slate-600">—</span>
            )}
          </div>
          {/* Goals O/U */}
          <div className="hidden flex-col items-center gap-1 sm:flex">
            {row.ou ? (
              <>
                <OddsButton
                  sub={`O ${row.ou.line}`}
                  sel={sel(row, "ou_goals", `Goals Over/Under ${row.ou.line}`, row.ou.line, "over", `Over ${row.ou.line}`, row.ou.over)}
                />
                <OddsButton
                  sub={`U ${row.ou.line}`}
                  sel={sel(row, "ou_goals", `Goals Over/Under ${row.ou.line}`, row.ou.line, "under", `Under ${row.ou.line}`, row.ou.under)}
                />
              </>
            ) : (
              <span className="text-xs text-slate-600">—</span>
            )}
          </div>
          {/* 1X2 */}
          <div className="flex items-center justify-end gap-1 sm:justify-center">
            <OddsButton sub="1" sel={sel(row, "h2h", "Full Time Result (1X2)", null, "home", row.home, row.h2h.home)} />
            <OddsButton sub="X" sel={sel(row, "h2h", "Full Time Result (1X2)", null, "draw", "Draw", row.h2h.draw)} />
            <OddsButton sub="2" sel={sel(row, "h2h", "Full Time Result (1X2)", null, "away", row.away, row.h2h.away)} />
          </div>
          <Link
            href={`/matches/${row.id}`}
            className="hidden text-center font-mono text-xs text-[#f0b429] hover:text-[#ffd166] sm:block"
          >
            +{row.marketCount}
          </Link>
        </>
      ) : (
        <div className="col-span-1 text-right text-xs text-slate-500 sm:col-span-4 sm:text-center">
          {row.status === "void"
            ? "VOID — stakes refunded"
            : row.status === "finished"
              ? row.homeScore !== null && row.homeScore !== row.awayScore
                ? `FT · ${row.homeScore! > row.awayScore! ? row.home : row.away} won`
                : "FT · Draw"
              : started
                ? "In play — counter closed"
                : "Odds unavailable"}
        </div>
      )}
    </div>
  );
}

// Bookmaker-style odds board grouped by the viewer's local date. Rendered
// after mount so date grouping uses the browser timezone.
export default function OddsBoard({ rows }: { rows: BoardRow[] }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
  }, []);

  if (now === null) {
    return (
      <div className="space-y-2">
        {rows.slice(0, 8).map((r) => (
          <div key={r.id} className="h-14 animate-pulse rounded bg-[#0e1c33]" />
        ))}
      </div>
    );
  }

  const groups = new Map<string, BoardRow[]>();
  for (const r of rows) {
    const key = new Date(r.kickoff).toLocaleDateString([], {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  return (
    <div className="space-y-5">
      {[...groups.entries()].map(([day, dayRows]) => (
        <section key={day} className="overflow-hidden rounded-lg border border-[#1b2c4a]">
          <div className="flex items-center justify-between bg-[#13243f] px-3 py-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-[#f0b429]">
              {day}
            </h3>
            <div className="hidden gap-2 text-[10px] uppercase tracking-wide text-slate-500 sm:grid sm:grid-cols-[10rem_10rem_15rem_3rem]">
              <span className="text-center">Handicap</span>
              <span className="text-center">Goals O/U</span>
              <span className="text-center">1 X 2</span>
              <span className="text-center">More</span>
            </div>
          </div>
          {dayRows.map((r) => (
            <MatchRow key={r.id} row={r} now={now} />
          ))}
        </section>
      ))}
    </div>
  );
}
