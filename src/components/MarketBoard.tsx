"use client";

import { useEffect, useState } from "react";
import type { MatchMarket } from "@/lib/markets";
import OddsButton from "./OddsButton";
import type { SlipSelection } from "./BetSlip";

export interface LiveBoardState {
  suspended: boolean;
  reason?: string;
  clock: string;
  homeScore: number;
  awayScore: number;
}

// Full market sheet for one match, bookmaker style. Clicking any price loads
// the bet slip. When `live` is supplied the board is in in-play mode: the
// kickoff timer no longer closes it (the match has already started); instead
// betting follows the live suspension state, and selections are tagged in-play.
export default function MarketBoard({
  matchId,
  matchLabel,
  kickoff,
  markets,
  committedPoints,
  inPlayCommittedPoints = 0,
  live = null,
}: {
  matchId: number;
  matchLabel: string;
  kickoff: string;
  markets: MatchMarket[];
  committedPoints: number;
  inPlayCommittedPoints?: number;
  live?: LiveBoardState | null;
}) {
  const [closedByKickoff, setClosedByKickoff] = useState(false);
  useEffect(() => {
    if (live) return; // in-play: kickoff timer is irrelevant
    const update = () => setClosedByKickoff(Date.parse(kickoff) <= Date.now());
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [kickoff, live]);

  const closed = live ? live.suspended : closedByKickoff;

  const toSel = (m: MatchMarket, s: MatchMarket["selections"][number]): SlipSelection => ({
    matchId,
    matchLabel,
    kickoff,
    market: m.market,
    marketName: m.name,
    line: m.line,
    selection: s.selection,
    selectionLabel: s.label,
    odds: s.odds,
    matchCommittedPoints: committedPoints,
    matchInPlayCommittedPoints: inPlayCommittedPoints,
    inPlay: !!live,
  });

  if (markets.length === 0) {
    return live ? (
      <div className="rounded-lg border border-rose-900/60 bg-rose-950/30 p-6 text-center text-sm text-rose-300">
        <span className="font-bold">⏸ In-play paused</span>
        <div className="mt-1 text-slate-300">
          {live.reason || "Prices are updating — hang tight."}
        </div>
      </div>
    ) : (
      <p className="rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-6 text-center text-sm text-slate-400">
        No odds quoted for this match yet.
      </p>
    );
  }

  const h2h = markets.find((m) => m.market === "h2h");
  const ahGoals = markets.filter((m) => m.market === "ah_goals");
  const ahCorners = markets.filter((m) => m.market === "ah_corners");
  const ouGoals = markets.filter((m) => m.market === "ou_goals");
  const ouCorners = markets.filter((m) => m.market === "ou_corners");
  const ouCards = markets.filter((m) => m.market === "ou_cards");
  const btts = markets.find((m) => m.market === "btts");
  const cs = markets.find((m) => m.market === "correct_score");

  const Panel = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="overflow-hidden rounded-lg border border-[#1b2c4a]">
      <h3 className="bg-[#13243f] px-3 py-2 text-xs font-bold uppercase tracking-wider text-[#f0b429]">
        {title}
      </h3>
      <div className="bg-[#0e1c33] p-3">{children}</div>
    </section>
  );

  const TotalsRows = ({ list }: { list: MatchMarket[] }) => (
    <div className="space-y-2">
      {list.map((m) => (
        <div key={`${m.market}-${m.line}`} className="grid grid-cols-[3rem_1fr_1fr] items-center gap-2">
          <span className="text-center font-mono text-sm text-slate-300">{m.line}</span>
          {m.selections.map((s) => (
            <OddsButton key={s.selection} wide sub={s.label} sel={toSel(m, s)} disabled={closed} />
          ))}
        </div>
      ))}
    </div>
  );

  // AH ladder: each line is a row of the two (home/away) prices. The button
  // labels already carry the signed handicap, so each row reads on its own.
  const AhRows = ({ list }: { list: MatchMarket[] }) => (
    <div className="space-y-2">
      {list.map((m) => (
        <div key={`${m.market}-${m.line}`} className="grid grid-cols-2 gap-2">
          {m.selections.map((s) => (
            <OddsButton key={s.selection} wide sub={s.label} sel={toSel(m, s)} disabled={closed} />
          ))}
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      {live ? (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            live.suspended
              ? "border-amber-900 bg-amber-950/40 text-amber-400"
              : "border-rose-900/60 bg-rose-950/30 text-rose-300"
          }`}
        >
          <span className="font-bold">🔴 LIVE {live.clock}</span> ·{" "}
          {live.homeScore}–{live.awayScore} ·{" "}
          {live.suspended
            ? live.reason || "betting paused"
            : "in-play prices update automatically"}
        </div>
      ) : (
        closed && (
          <p className="rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-sm text-amber-400">
            The counter is closed — this match has kicked off.
          </p>
        )
      )}

      {(h2h || btts) && (
        <div className="grid gap-4 sm:grid-cols-[3fr_2fr]">
          {h2h && (
            <Panel title={h2h.name}>
              <div className="grid grid-cols-3 gap-2">
                {h2h.selections.map((s) => (
                  <OddsButton key={s.selection} wide sub={s.label} sel={toSel(h2h, s)} disabled={closed} />
                ))}
              </div>
            </Panel>
          )}
          {btts && (
            <Panel title={btts.name}>
              <div className="grid grid-cols-2 gap-2">
                {btts.selections.map((s) => (
                  <OddsButton key={s.selection} wide sub={s.label} sel={toSel(btts, s)} disabled={closed} />
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}

      {(ahGoals.length > 0 || ahCorners.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {ahGoals.length > 0 && (
            <Panel title="Asian Handicap">
              <AhRows list={ahGoals} />
            </Panel>
          )}
          {ahCorners.length > 0 && (
            <Panel title="Corners Handicap">
              <AhRows list={ahCorners} />
            </Panel>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {ouGoals.length > 0 && (
          <Panel title="Goals Over/Under">
            <TotalsRows list={ouGoals} />
          </Panel>
        )}
        {ouCorners.length > 0 && (
          <Panel title="Corners Over/Under">
            <TotalsRows list={ouCorners} />
          </Panel>
        )}
        {ouCards.length > 0 && (
          <Panel title="Cards Over/Under">
            <TotalsRows list={ouCards} />
          </Panel>
        )}
      </div>

      {cs && (
        <Panel title="Correct Score">
          <div className="grid grid-cols-5 gap-1.5">
            {cs.selections
              .filter((s) => !s.selection.startsWith("other"))
              .map((s) => (
                <OddsButton key={s.selection} wide sub={s.label} sel={toSel(cs, s)} disabled={closed} />
              ))}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {cs.selections
              .filter((s) => s.selection.startsWith("other"))
              .map((s) => (
                <OddsButton key={s.selection} wide sub={s.label} sel={toSel(cs, s)} disabled={closed} />
              ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
