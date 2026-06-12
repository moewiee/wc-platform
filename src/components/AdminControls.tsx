"use client";

import { useActionState } from "react";
import {
  adminCompleteDataAction,
  adminGenerateTipsAction,
  adminRefreshOddsAction,
  adminSettleAction,
  adminSyncScoresAction,
  adminVoidAction,
  type FormState,
} from "@/lib/actions";

function Feedback({ state }: { state: FormState }) {
  if (state.error) return <p className="text-xs text-rose-400">{state.error}</p>;
  if (state.success)
    return <p className="text-xs text-emerald-400">{state.success}</p>;
  return null;
}

const inputCls =
  "w-12 rounded-md border border-[#1b2c4a] bg-[#081120] px-1 py-1 text-center font-mono text-sm";

export function AdminApiButtons() {
  const [refreshState, refreshAction, refreshing] = useActionState<
    FormState,
    FormData
  >(adminRefreshOddsAction, {});
  const [syncState, syncAction, syncing] = useActionState<FormState, FormData>(
    adminSyncScoresAction,
    {}
  );
  const [tipsState, tipsAction, tipping] = useActionState<FormState, FormData>(
    adminGenerateTipsAction,
    {}
  );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-3">
        <form action={refreshAction}>
          <button
            type="submit"
            disabled={refreshing}
            className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh odds now"}
          </button>
        </form>
        <form action={syncAction}>
          <button
            type="submit"
            disabled={syncing}
            className="rounded-lg bg-sky-700 px-4 py-2 text-sm font-semibold text-white hover:bg-sky-600 disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync scores & settle"}
          </button>
        </form>
        <form action={tipsAction}>
          <button
            type="submit"
            disabled={tipping}
            className="rounded-lg bg-violet-700 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-600 disabled:opacity-50"
          >
            {tipping ? "Agents reading the news…" : "Generate AI tips (next 3 matches)"}
          </button>
        </form>
      </div>
      <Feedback state={refreshState} />
      <Feedback state={syncState} />
      <Feedback state={tipsState} />
    </div>
  );
}

// Settle a scheduled match: final score required, corners/cards optional
// (corner/card bets wait until those counts are added).
export function AdminSettleRow({ matchId }: { matchId: number }) {
  const [settleState, settleAction, settling] = useActionState<
    FormState,
    FormData
  >(adminSettleAction, {});
  const [voidState, voidAction, voiding] = useActionState<FormState, FormData>(
    adminVoidAction,
    {}
  );
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <form action={settleAction} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="matchId" value={matchId} />
          <span className="text-xs text-slate-500">Score</span>
          <input name="homeScore" type="number" min={0} max={99} required placeholder="H" aria-label="Home goals" className={inputCls} />
          <input name="awayScore" type="number" min={0} max={99} required placeholder="A" aria-label="Away goals" className={inputCls} />
          <span className="text-xs text-slate-500">Corners</span>
          <input name="cornersHome" type="number" min={0} max={99} placeholder="H" aria-label="Home corners" className={inputCls} />
          <input name="cornersAway" type="number" min={0} max={99} placeholder="A" aria-label="Away corners" className={inputCls} />
          <span className="text-xs text-slate-500">Cards</span>
          <input name="cardsTotal" type="number" min={0} max={99} placeholder="Σ" aria-label="Total cards" className={inputCls} />
          <button
            type="submit"
            disabled={settling}
            className="rounded-md bg-emerald-800 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {settling ? "…" : "Settle"}
          </button>
        </form>
        <form action={voidAction}>
          <input type="hidden" name="matchId" value={matchId} />
          <button
            type="submit"
            disabled={voiding}
            className="rounded-md border border-slate-700 px-3 py-1 text-xs text-slate-400 hover:border-slate-500 disabled:opacity-50"
          >
            {voiding ? "…" : "Void"}
          </button>
        </form>
      </div>
      <Feedback state={settleState} />
      <Feedback state={voidState} />
    </div>
  );
}

// Add missing corners/cards to a finished match so waiting bets settle.
export function AdminCompleteDataRow({ matchId }: { matchId: number }) {
  const [state, action, pending] = useActionState<FormState, FormData>(
    adminCompleteDataAction,
    {}
  );
  return (
    <div className="space-y-1.5">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="matchId" value={matchId} />
        <span className="text-xs text-slate-500">Corners</span>
        <input name="cornersHome" type="number" min={0} max={99} placeholder="H" aria-label="Home corners" className={inputCls} />
        <input name="cornersAway" type="number" min={0} max={99} placeholder="A" aria-label="Away corners" className={inputCls} />
        <span className="text-xs text-slate-500">Cards</span>
        <input name="cardsTotal" type="number" min={0} max={99} placeholder="Σ" aria-label="Total cards" className={inputCls} />
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-sky-800 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-700 disabled:opacity-50"
        >
          {pending ? "…" : "Add data & settle"}
        </button>
      </form>
      <Feedback state={state} />
    </div>
  );
}
