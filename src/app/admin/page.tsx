import {
  AdminApiButtons,
  AdminCompleteDataRow,
  AdminSettleRow,
} from "@/components/AdminControls";
import LocalTime from "@/components/LocalTime";
import { requireAdmin } from "@/lib/auth";
import { countPendingBets } from "@/lib/bets";
import { getMeta } from "@/lib/db";
import { listMatches } from "@/lib/matches";
import { apiConfigured, apiSportKey } from "@/lib/odds-api";
import { openAiConfigured } from "@/lib/tips";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await requireAdmin();
  const matches = listMatches();
  const open = matches.filter((m) => m.status === "scheduled");
  const finished = matches.filter((m) => m.status !== "scheduled");
  const needsData = finished
    .filter((m) => m.status === "finished" && countPendingBets(m.id) > 0)
    .sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff));
  const recentClosed = finished
    .sort((a, b) => Date.parse(b.kickoff) - Date.parse(a.kickoff))
    .slice(0, 15);

  const configured = apiConfigured();
  const remaining = getMeta("api_requests_remaining");
  const lastRefresh = getMeta("last_odds_refresh");
  const lastSync = getMeta("last_scores_sync");
  const lastError = getMeta("last_api_error");

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-bold">Admin</h1>

      <section className="rounded-xl border border-[#1b2c4a] bg-[#0e1c33] p-6">
        <h2 className="mb-3 font-bold">Data sources</h2>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">The Odds API key</dt>
            <dd className={configured ? "text-emerald-400" : "text-amber-400"}>
              {configured ? "configured" : "not set — using house odds"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">OpenAI key (AI tips)</dt>
            <dd className={openAiConfigured() ? "text-emerald-400" : "text-amber-400"}>
              {openAiConfigured() ? "configured" : "not set — model tips only"}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">Sport key</dt>
            <dd className="font-mono">{apiSportKey()}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">Odds credits remaining</dt>
            <dd className="font-mono">{remaining ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">Last odds refresh</dt>
            <dd>{lastRefresh ? <LocalTime iso={lastRefresh} /> : "never"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-slate-400">Last score sync</dt>
            <dd>{lastSync ? <LocalTime iso={lastSync} /> : "never"}</dd>
          </div>
        </dl>
        {lastError ? (
          <p className="mt-3 rounded-lg bg-rose-950/60 px-3 py-2 text-xs text-rose-400">
            Last API error: {lastError}
          </p>
        ) : null}
        <div className="mt-4">
          <AdminApiButtons />
        </div>
      </section>

      {needsData.length > 0 && (
        <section>
          <h2 className="mb-3 font-bold text-amber-400">
            ⚠ Finished matches with bets waiting on corners/cards data
          </h2>
          <div className="space-y-3">
            {needsData.map((m) => (
              <div
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-amber-900/60 bg-[#0e1c33] p-4"
              >
                <div>
                  <div className="font-semibold">
                    {m.home_team} {m.home_score}–{m.away_score} {m.away_team}
                  </div>
                  <div className="text-xs text-slate-400">
                    {countPendingBets(m.id)} bets waiting
                  </div>
                </div>
                <AdminCompleteDataRow matchId={m.id} />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-3 font-bold">
          Open matches ({open.length}) — settle manually
        </h2>
        <p className="mb-3 text-xs text-slate-500">
          Enter the final score (corners/cards optional — bets on them wait
          until the data is added). Void refunds every stake.
        </p>
        <div className="space-y-3">
          {open.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-[#1b2c4a] bg-[#0e1c33] p-4"
            >
              <div className="min-w-0">
                <div className="text-xs text-slate-400">
                  {m.group_name ? `Group ${m.group_name} · ` : ""}
                  <LocalTime iso={m.kickoff} /> · {countPendingBets(m.id)} open bets ·{" "}
                  {m.odds_source}
                </div>
                <div className="mt-1 font-semibold">
                  {m.home_team} vs {m.away_team}
                </div>
              </div>
              <AdminSettleRow matchId={m.id} />
            </div>
          ))}
          {open.length === 0 && (
            <p className="text-sm text-slate-500">No open matches.</p>
          )}
        </div>
      </section>

      {recentClosed.length > 0 && (
        <section>
          <h2 className="mb-3 font-bold">Recently settled</h2>
          <ul className="space-y-2 text-sm">
            {recentClosed.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between rounded-lg border border-[#1b2c4a] bg-[#0e1c33] px-4 py-2.5"
              >
                <span>
                  {m.home_team} vs {m.away_team}
                </span>
                <span className="font-mono text-slate-300">
                  {m.status === "void" ? "VOID" : `${m.home_score}–${m.away_score}`}
                  {m.corners_home !== null ? ` · C ${m.corners_home}-${m.corners_away}` : ""}
                  {m.cards_total !== null ? ` · ${m.cards_total} cards` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
