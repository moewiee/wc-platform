import Link from "next/link";
import OddsBoard, { type BoardRow } from "@/components/OddsBoard";
import { getCurrentUser } from "@/lib/auth";
import { marketsForMatch } from "@/lib/markets";
import { listMatches, maybeRefreshOdds, maybeSyncScores } from "@/lib/matches";
import type { Match } from "@/lib/types";

export const dynamic = "force-dynamic";

function toRow(match: Match): BoardRow {
  const markets = match.status === "scheduled" ? marketsForMatch(match) : [];
  const h2h = markets.find((m) => m.market === "h2h");
  const ah = markets.find((m) => m.market === "ah_goals");
  const ous = markets.filter((m) => m.market === "ou_goals");
  const ou =
    ous.find((m) => m.line !== null && Math.abs(m.line - 2.5) < 0.01) ??
    ous[Math.floor(ous.length / 2)];
  const pick = (mkt: typeof h2h, s: string) =>
    mkt?.selections.find((x) => x.selection === s)?.odds ?? null;
  const h = pick(h2h, "home");
  const d = pick(h2h, "draw");
  const a = pick(h2h, "away");
  const ahH = pick(ah, "home");
  const ahA = pick(ah, "away");
  const over = pick(ou, "over");
  const under = pick(ou, "under");
  return {
    id: match.id,
    home: match.home_team,
    away: match.away_team,
    kickoff: match.kickoff,
    group: match.group_name,
    venue: match.venue,
    status: match.status,
    homeScore: match.home_score,
    awayScore: match.away_score,
    h2h: h && d && a ? { home: h, draw: d, away: a } : null,
    ah: ah && ah.line !== null && ahH && ahA ? { line: ah.line, home: ahH, away: ahA } : null,
    ou: ou && ou.line !== null && over && under ? { line: ou.line, over, under } : null,
    marketCount: markets.length,
  };
}

export default async function HomePage() {
  // Best-effort: refresh odds (30-min cadence) and pull results; never block
  // the page on API failures.
  await Promise.allSettled([maybeRefreshOdds(), maybeSyncScores()]);

  const user = await getCurrentUser();
  const matches = listMatches();
  const upcoming = matches.filter((m) => m.status === "scheduled").map(toRow);
  const finished = matches
    .filter((m) => m.status !== "scheduled")
    .sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff))
    .slice(0, 15)
    .map(toRow);

  return (
    <div className="space-y-8">
      <div className="overflow-hidden rounded-xl border border-[#f0b429]/30 bg-gradient-to-r from-[#13243f] via-[#0e1c33] to-[#1a1305] px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight">
              <span className="text-[#f0b429]">FIFA WORLD CUP 2026</span>{" "}
              <span className="text-slate-200">BETTING LOBBY</span>
            </h1>
            <p className="mt-1 text-sm text-slate-300">
              Asian handicap · Over/Under · 1X2 · Correct score · Corners & cards —
              counter closes at kickoff.
            </p>
          </div>
          {!user && (
            <Link
              href="/register"
              className="rounded-lg bg-[#f0b429] px-5 py-2.5 font-black text-[#081120] shadow-lg shadow-[#f0b429]/20 transition hover:bg-[#ffd166]"
            >
              JOIN NOW — 20,000 pts FREE
            </Link>
          )}
        </div>
      </div>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">
          ⚽ Today & Upcoming
        </h2>
        {upcoming.length === 0 ? (
          <p className="text-slate-400">No upcoming matches right now — check back soon.</p>
        ) : (
          <OddsBoard rows={upcoming} />
        )}
      </section>

      {finished.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-400">
            🏁 Results
          </h2>
          <OddsBoard rows={finished} />
        </section>
      )}
    </div>
  );
}
