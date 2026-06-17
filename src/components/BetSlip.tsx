"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useActionState } from "react";
import {
  placeBetAction,
  placeParlayAction,
  type FormState,
} from "@/lib/actions";
import {
  combineOddsX1000,
  effectiveParlayStake,
  fmtOdds,
  fmtPts,
  MAX_INPLAY_STAKE_PER_MATCH_POINTS,
  MAX_PARLAY_LEGS,
  MAX_PARLAY_PAYOUT_POINTS,
  MAX_PARLAY_STAKE_POINTS,
  MAX_STAKE_PER_MATCH_POINTS,
  MIN_PARLAY_LEGS,
  MIN_STAKE_POINTS,
  parlayDayKey,
  parlayPayoutPoints,
  parseStakeToPoints,
  payoutPoints,
} from "@/lib/money";

export interface SlipSelection {
  matchId: number;
  matchLabel: string;
  kickoff: string;
  market: string;
  marketName: string;
  line: number | null;
  selection: string;
  selectionLabel: string;
  odds: number; // x1000
  // Points the player already has staked (open) on this match, across all
  // markets — used to mirror the per-match stake cap. Undefined on surfaces
  // that don't track it (server enforcement still applies).
  matchCommittedPoints?: number;
  // Of that, the points already staked in-play — mirrors the lower live
  // sub-cap. Only meaningful when inPlay is true.
  matchInPlayCommittedPoints?: number;
  // True when this selection is a live (in-play) price: the slip sends the
  // seen odds for the server's staleness check and shows in-play copy.
  inPlay?: boolean;
}

type SlipMode = "single" | "parlay";

function selKey(s: SlipSelection): string {
  return `${s.matchId}:${s.market}:${s.line ?? ""}:${s.selection}`;
}

interface SlipContext {
  selections: SlipSelection[];
  mode: SlipMode;
  error: string | null;
  setMode: (m: SlipMode) => void;
  toggle: (s: SlipSelection) => void;
  remove: (key: string) => void;
  replace: (key: string, next: SlipSelection) => void;
  clear: () => void;
  isSelected: (s: SlipSelection) => boolean;
}

const Ctx = createContext<SlipContext | null>(null);

export function useBetSlip(): SlipContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBetSlip outside BetSlipProvider");
  return ctx;
}

const QUICK_STAKES = ["100", "500", "1000", "5000"];
const PARLAY_QUICK_STAKES = ["50", "100", "250", "500"];

// ── Single-bet body (unchanged behaviour from the original slip) ──────────────
function SingleBetBody({
  slip,
  balancePoints,
  loggedIn,
}: {
  slip: SlipSelection;
  balancePoints: number;
  loggedIn: boolean;
}) {
  const { clear, replace } = useBetSlip();
  const [stake, setStake] = useState("100");
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    placeBetAction,
    {}
  );
  const [closedFor, setClosedFor] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    const update = () =>
      setClosedFor(!slip.inPlay && Date.parse(slip.kickoff) <= Date.now());
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [slip]);

  useEffect(() => setConfirming(false), [slip]);
  useEffect(() => {
    if (state.error || state.success) setConfirming(false);
  }, [state]);

  // In-play re-quote: adopt the server's fresh price.
  useEffect(() => {
    if (state.newOdds !== undefined && slip.odds !== state.newOdds) {
      replace(selKey(slip), { ...slip, odds: state.newOdds });
    }
  }, [state, slip, replace]);

  const stakePts = parseStakeToPoints(stake);
  const projected = stakePts !== null ? payoutPoints(stakePts, slip.odds) : null;
  const committed = slip.matchCommittedPoints;
  const capLabel = slip.inPlay
    ? MAX_INPLAY_STAKE_PER_MATCH_POINTS
    : MAX_STAKE_PER_MATCH_POINTS;
  const matchRemaining =
    committed === undefined
      ? null
      : slip.inPlay
        ? Math.max(
            0,
            Math.min(
              MAX_STAKE_PER_MATCH_POINTS - committed,
              MAX_INPLAY_STAKE_PER_MATCH_POINTS - (slip.matchInPlayCommittedPoints ?? 0)
            )
          )
        : Math.max(0, MAX_STAKE_PER_MATCH_POINTS - committed);
  const overMatchLimit =
    matchRemaining !== null && stakePts !== null && stakePts > matchRemaining;

  return (
    <form action={formAction} className="space-y-3 px-4 py-3">
      <input type="hidden" name="matchId" value={slip.matchId} />
      <input type="hidden" name="market" value={slip.market} />
      <input type="hidden" name="line" value={slip.line ?? ""} />
      <input type="hidden" name="selection" value={slip.selection} />
      {/* In-play only: the price the bettor saw, for the server's staleness check. */}
      <input type="hidden" name="odds" value={slip.inPlay ? slip.odds : ""} />
      <div>
        <div className="flex items-center gap-2 text-xs text-slate-400">
          {slip.inPlay && (
            <span className="rounded bg-rose-950 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-400">
              Live
            </span>
          )}
          {slip.matchLabel}
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-slate-100">
            {slip.marketName} · {slip.selectionLabel}
          </span>
          <span className="font-mono text-base font-bold text-[#f0b429]">
            {fmtOdds(slip.odds)}
          </span>
        </div>
      </div>

      {!loggedIn ? (
        <div className="space-y-2 pb-1 text-center">
          <p className="text-sm text-slate-300">Sign in to place this bet.</p>
          <div className="flex justify-center gap-2">
            <Link
              href="/login"
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm font-semibold hover:border-slate-400"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-[#f0b429] px-3 py-1.5 text-sm font-bold text-[#081120] hover:bg-[#ffd166]"
            >
              Join · 20,000 pts
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="slip-stake" className="mb-1 block text-xs text-slate-400">
              Stake (balance {fmtPts(balancePoints)} pts)
            </label>
            <div className="flex items-center gap-2">
              <input
                id="slip-stake"
                name="stake"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                inputMode="numeric"
                className="w-24 rounded-md border border-[#1b2c4a] bg-[#081120] px-2 py-1.5 font-mono text-sm focus:border-[#f0b429] focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                {QUICK_STAKES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setStake(q)}
                    className="rounded border border-[#1b2c4a] px-1.5 py-0.5 text-xs text-slate-300 hover:border-[#f0b429]/60"
                  >
                    {fmtPts(Number(q))}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setStake(String(balancePoints))}
                  className="rounded border border-amber-900 px-1.5 py-0.5 text-xs text-amber-400 hover:border-amber-600"
                >
                  Max
                </button>
              </div>
            </div>
          </div>
          {projected !== null && (
            <p className="text-xs text-slate-300">
              Potential payout:{" "}
              <span className="font-mono font-bold text-emerald-400">
                {fmtPts(projected)} pts
              </span>
            </p>
          )}
          {matchRemaining !== null && (
            <p className={`text-xs ${overMatchLimit ? "text-rose-400" : "text-slate-400"}`}>
              {matchRemaining > 0
                ? `${fmtPts(matchRemaining)} of ${fmtPts(capLabel)} pts ${slip.inPlay ? "in-play" : "per-match"} limit left on this match.`
                : `You've reached the ${fmtPts(capLabel)} pts ${slip.inPlay ? "in-play" : "per-match"} limit on this match.`}
            </p>
          )}
          {state.error && <p className="text-xs text-rose-400">{state.error}</p>}
          {state.success && (
            <p className="text-xs text-emerald-400">{state.success}</p>
          )}
          {closedFor && (
            <p className="text-xs text-amber-400">
              Betting closed — this match has kicked off.
            </p>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={pending || closedFor || stakePts === null || overMatchLimit}
            className="w-full rounded-md bg-[#f0b429] py-2 text-sm font-bold uppercase tracking-wide text-[#081120] transition hover:bg-[#ffd166] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {pending ? "Placing…" : "Place Bet"}
          </button>
          {confirming && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-sm rounded-xl border border-[#f0b429]/40 bg-[#0e1c33] p-5 shadow-2xl shadow-black/60">
                <h3 className="text-sm font-bold uppercase tracking-wide text-[#f0b429]">
                  Confirm your bet
                </h3>
                <div className="mt-3 space-y-1.5 text-sm">
                  <p className="text-slate-400">{slip.matchLabel}</p>
                  <p className="font-semibold text-slate-100">
                    {slip.marketName} · {slip.selectionLabel}{" "}
                    <span className="font-mono text-[#f0b429]">
                      @ {fmtOdds(slip.odds)}
                    </span>
                  </p>
                  <p className="text-slate-300">
                    Stake:{" "}
                    <span className="font-mono font-bold">
                      {fmtPts(stakePts ?? 0)} pts
                    </span>
                  </p>
                  {projected !== null && (
                    <p className="text-slate-300">
                      Potential payout:{" "}
                      <span className="font-mono font-bold text-emerald-400">
                        {fmtPts(projected)} pts
                      </span>
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs text-slate-400">
                  {slip.inPlay
                    ? "Are you sure? In-play bets are locked at this price the moment they're placed and can't be cancelled. The live price may move before this is accepted."
                    : "Are you sure you want to place this bet? You can only cancel it within 30 minutes of placing it, and never after kickoff."}
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={pending}
                    className="flex-1 rounded-md border border-slate-600 py-2 text-sm font-semibold text-slate-300 transition hover:border-slate-400 disabled:opacity-50"
                  >
                    Go back
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex-1 rounded-md bg-[#f0b429] py-2 text-sm font-bold uppercase tracking-wide text-[#081120] transition hover:bg-[#ffd166] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {pending ? "Placing…" : "Yes, place bet"}
                  </button>
                </div>
              </div>
            </div>
          )}
          {loggedIn && (
            <button
              type="button"
              onClick={clear}
              className="w-full text-center text-xs text-slate-500 hover:text-slate-300"
            >
              Clear slip
            </button>
          )}
        </>
      )}
    </form>
  );
}

// ── Parlay body: multiple legs, one combined stake, real-odds product ─────────
function ParlayBody({
  selections,
  balancePoints,
  loggedIn,
  slipError,
}: {
  selections: SlipSelection[];
  balancePoints: number;
  loggedIn: boolean;
  slipError: string | null;
}) {
  const { remove, clear } = useBetSlip();
  const [stake, setStake] = useState("100");
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    placeParlayAction,
    {}
  );
  const [confirming, setConfirming] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setConfirming(false), [selections.length]);
  useEffect(() => {
    if (state.error || state.success) setConfirming(false);
  }, [state]);

  const stakePts = parseStakeToPoints(stake);
  const legOdds = selections.map((s) => s.odds);
  const combinedOdds = useMemo(
    () => combineOddsX1000(legOdds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(legOdds)]
  );
  // If the all-win payout would exceed the cap, the stake is auto-reduced so the
  // bettor keeps the leftover rather than over-staking for a clipped payout.
  const effStake =
    stakePts !== null
      ? effectiveParlayStake(
          stakePts,
          combinedOdds,
          MAX_PARLAY_PAYOUT_POINTS,
          MIN_STAKE_POINTS
        )
      : null;
  const reduced = stakePts !== null && effStake !== null && effStake < stakePts;
  const projected =
    effStake !== null
      ? parlayPayoutPoints(effStake, legOdds, MAX_PARLAY_PAYOUT_POINTS)
      : null;

  const anyStarted = selections.some((s) => Date.parse(s.kickoff) <= now);
  const tooFew = selections.length < MIN_PARLAY_LEGS;
  const overStake = stakePts !== null && stakePts > MAX_PARLAY_STAKE_POINTS;
  const legsJson = JSON.stringify(
    selections.map((s) => ({
      matchId: s.matchId,
      market: s.market,
      line: s.line,
      selection: s.selection,
    }))
  );

  return (
    <form action={formAction} className="space-y-3 px-4 py-3">
      <input type="hidden" name="legs" value={legsJson} />

      <div className="space-y-2">
        {selections.map((s) => (
          <div
            key={selKey(s)}
            className="rounded-md border border-[#1b2c4a] bg-[#0a1628] px-2.5 py-1.5"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-[11px] text-slate-400">
                  {s.matchLabel}
                </div>
                <div className="truncate text-xs font-semibold text-slate-100">
                  {s.marketName} · {s.selectionLabel}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <span className="font-mono text-sm font-bold text-[#f0b429]">
                  {fmtOdds(s.odds)}
                </span>
                <button
                  type="button"
                  onClick={() => remove(selKey(s))}
                  className="text-slate-500 hover:text-rose-400"
                  aria-label="Remove leg"
                >
                  ✕
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-y border-[#1b2c4a] py-2 text-sm">
        <span className="text-slate-400">
          {selections.length} {selections.length === 1 ? "leg" : "legs"} · combined
        </span>
        <span className="font-mono text-base font-bold text-[#f0b429]">
          {fmtOdds(combinedOdds)}
        </span>
      </div>

      {slipError && <p className="text-xs text-rose-400">{slipError}</p>}

      {!loggedIn ? (
        <div className="space-y-2 pb-1 text-center">
          <p className="text-sm text-slate-300">Sign in to place this parlay.</p>
          <div className="flex justify-center gap-2">
            <Link
              href="/login"
              className="rounded-md border border-slate-600 px-3 py-1.5 text-sm font-semibold hover:border-slate-400"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="rounded-md bg-[#f0b429] px-3 py-1.5 text-sm font-bold text-[#081120] hover:bg-[#ffd166]"
            >
              Join · 20,000 pts
            </Link>
          </div>
        </div>
      ) : (
        <>
          <div>
            <label htmlFor="parlay-stake" className="mb-1 block text-xs text-slate-400">
              Stake (balance {fmtPts(balancePoints)} pts · max {fmtPts(MAX_PARLAY_STAKE_POINTS)})
            </label>
            <div className="flex items-center gap-2">
              <input
                id="parlay-stake"
                name="stake"
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                inputMode="numeric"
                className="w-24 rounded-md border border-[#1b2c4a] bg-[#081120] px-2 py-1.5 font-mono text-sm focus:border-[#f0b429] focus:outline-none"
              />
              <div className="flex flex-wrap gap-1">
                {PARLAY_QUICK_STAKES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setStake(q)}
                    className="rounded border border-[#1b2c4a] px-1.5 py-0.5 text-xs text-slate-300 hover:border-[#f0b429]/60"
                  >
                    {fmtPts(Number(q))}
                  </button>
                ))}
              </div>
            </div>
          </div>
          {projected !== null && (
            <p className="text-xs text-slate-300">
              Potential payout:{" "}
              <span className="font-mono font-bold text-emerald-400">
                {fmtPts(projected)} pts
              </span>
            </p>
          )}
          {reduced && effStake !== null && stakePts !== null && (
            <p className="text-xs text-amber-400">
              Max payout is {fmtPts(MAX_PARLAY_PAYOUT_POINTS)} pts — stake
              auto-reduced to {fmtPts(effStake)} pts; you keep the other{" "}
              {fmtPts(stakePts - effStake)} pts.
            </p>
          )}
          {tooFew && (
            <p className="text-xs text-slate-400">
              Add at least {MIN_PARLAY_LEGS} selections from different matches to
              build a parlay.
            </p>
          )}
          {overStake && (
            <p className="text-xs text-rose-400">
              Maximum parlay stake is {fmtPts(MAX_PARLAY_STAKE_POINTS)} pts.
            </p>
          )}
          {anyStarted && (
            <p className="text-xs text-amber-400">
              A leg has kicked off — parlays are pre-match only. Remove it to
              place.
            </p>
          )}
          {state.error && <p className="text-xs text-rose-400">{state.error}</p>}
          {state.success && (
            <p className="text-xs text-emerald-400">{state.success}</p>
          )}
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={
              pending ||
              tooFew ||
              overStake ||
              anyStarted ||
              stakePts === null
            }
            className="w-full rounded-md bg-[#f0b429] py-2 text-sm font-bold uppercase tracking-wide text-[#081120] transition hover:bg-[#ffd166] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {pending ? "Placing…" : `Place Parlay (${selections.length})`}
          </button>
          <button
            type="button"
            onClick={clear}
            className="w-full text-center text-xs text-slate-500 hover:text-slate-300"
          >
            Clear slip
          </button>
          {confirming && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
              <div className="w-full max-w-sm rounded-xl border border-[#f0b429]/40 bg-[#0e1c33] p-5 shadow-2xl shadow-black/60">
                <h3 className="text-sm font-bold uppercase tracking-wide text-[#f0b429]">
                  Confirm your parlay
                </h3>
                <div className="mt-3 max-h-48 space-y-1.5 overflow-y-auto text-sm">
                  {selections.map((s) => (
                    <p key={selKey(s)} className="text-slate-300">
                      <span className="text-slate-100">{s.selectionLabel}</span>{" "}
                      <span className="font-mono text-[#f0b429]">
                        @ {fmtOdds(s.odds)}
                      </span>
                      <span className="block text-[11px] text-slate-500">
                        {s.matchLabel} · {s.marketName}
                      </span>
                    </p>
                  ))}
                </div>
                <div className="mt-3 space-y-1 border-t border-[#1b2c4a] pt-2 text-sm">
                  <p className="text-slate-300">
                    {selections.length} legs @{" "}
                    <span className="font-mono font-bold text-[#f0b429]">
                      {fmtOdds(combinedOdds)}
                    </span>
                  </p>
                  <p className="text-slate-300">
                    Stake:{" "}
                    <span className="font-mono font-bold">
                      {fmtPts(effStake ?? stakePts ?? 0)} pts
                    </span>
                    {reduced && (
                      <span className="ml-1 text-xs text-amber-400">
                        (reduced from {fmtPts(stakePts ?? 0)} for the payout cap)
                      </span>
                    )}
                  </p>
                  {projected !== null && (
                    <p className="text-slate-300">
                      Potential payout:{" "}
                      <span className="font-mono font-bold text-emerald-400">
                        {fmtPts(projected)} pts
                      </span>
                    </p>
                  )}
                </div>
                <p className="mt-3 text-xs text-slate-400">
                  All-or-nothing: every leg must win. A voided/postponed leg drops
                  out and the rest stand. Cancellable within 30 minutes of placing
                  and never after a leg kicks off.
                </p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirming(false)}
                    disabled={pending}
                    className="flex-1 rounded-md border border-slate-600 py-2 text-sm font-semibold text-slate-300 transition hover:border-slate-400 disabled:opacity-50"
                  >
                    Go back
                  </button>
                  <button
                    type="submit"
                    disabled={pending}
                    className="flex-1 rounded-md bg-[#f0b429] py-2 text-sm font-bold uppercase tracking-wide text-[#081120] transition hover:bg-[#ffd166] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
                  >
                    {pending ? "Placing…" : "Yes, place parlay"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </form>
  );
}

function BetSlipPanel({
  balancePoints,
  loggedIn,
}: {
  balancePoints: number;
  loggedIn: boolean;
}) {
  const { selections, mode, setMode, error, clear } = useBetSlip();

  if (selections.length === 0) return null;

  return (
    <div className="fixed bottom-0 right-0 z-40 w-full sm:bottom-4 sm:right-4 sm:w-80">
      <div className="border border-[#f0b429]/40 bg-[#0e1c33] shadow-2xl shadow-black/60 sm:rounded-xl">
        <div className="flex items-center justify-between border-b border-[#1b2c4a] bg-[#13243f] px-4 py-2.5 sm:rounded-t-xl">
          <span className="text-sm font-bold uppercase tracking-wide text-[#f0b429]">
            Bet Slip
          </span>
          <button
            onClick={clear}
            className="text-slate-400 hover:text-white"
            aria-label="Close bet slip"
          >
            ✕
          </button>
        </div>
        {/* Single / Parlay tabs */}
        <div className="grid grid-cols-2 gap-1 border-b border-[#1b2c4a] bg-[#0e1c33] p-1">
          {(["single", "parlay"] as SlipMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-md px-2 py-1.5 text-xs font-bold uppercase tracking-wide transition ${
                mode === m
                  ? "bg-[#f0b429] text-[#081120]"
                  : "text-slate-400 hover:text-slate-200"
              }`}
            >
              {m === "single" ? "Single" : "Parlay"}
            </button>
          ))}
        </div>
        {mode === "single" ? (
          <SingleBetBody
            slip={selections[0]}
            balancePoints={balancePoints}
            loggedIn={loggedIn}
          />
        ) : (
          <ParlayBody
            selections={selections}
            balancePoints={balancePoints}
            loggedIn={loggedIn}
            slipError={error}
          />
        )}
      </div>
    </div>
  );
}

export default function BetSlipProvider({
  children,
  balancePoints,
  loggedIn,
}: {
  children: React.ReactNode;
  balancePoints: number;
  loggedIn: boolean;
}) {
  const [selections, setSelections] = useState<SlipSelection[]>([]);
  const [mode, setModeState] = useState<SlipMode>("single");
  const [error, setError] = useState<string | null>(null);

  const isSelected = (s: SlipSelection) =>
    selections.some((x) => selKey(x) === selKey(s));

  const setMode = (m: SlipMode) => {
    setError(null);
    setModeState(m);
    // Switching to Single keeps only the first leg (single = one selection).
    if (m === "single") setSelections((cur) => (cur.length > 1 ? [cur[0]] : cur));
  };

  const toggle = (s: SlipSelection) => {
    setError(null);
    const key = selKey(s);
    if (selections.some((x) => selKey(x) === key)) {
      setSelections((cur) => cur.filter((x) => selKey(x) !== key));
      return;
    }
    if (mode === "single") {
      setSelections([s]);
      return;
    }
    // Parlay mode: validate the new leg against the correlation / same-day /
    // count / pre-match rules (the server re-checks all of these).
    if (s.inPlay || Date.parse(s.kickoff) <= Date.now()) {
      setError("In-play selections can't be added to a parlay.");
      return;
    }
    if (selections.length >= MAX_PARLAY_LEGS) {
      setError(`A parlay can have at most ${MAX_PARLAY_LEGS} legs.`);
      return;
    }
    if (selections.some((x) => x.matchId === s.matchId)) {
      setError("Can't combine two legs from the same match.");
      return;
    }
    if (
      selections.length > 0 &&
      parlayDayKey(s.kickoff) !== parlayDayKey(selections[0].kickoff)
    ) {
      setError("All legs must kick off on the same day.");
      return;
    }
    setSelections((cur) => [...cur, s]);
  };

  const remove = (key: string) => {
    setError(null);
    setSelections((cur) => cur.filter((x) => selKey(x) !== key));
  };

  const replace = (key: string, next: SlipSelection) => {
    setSelections((cur) => cur.map((x) => (selKey(x) === key ? next : x)));
  };

  const clear = () => {
    setError(null);
    setSelections([]);
  };

  return (
    <Ctx.Provider
      value={{ selections, mode, error, setMode, toggle, remove, replace, clear, isSelected }}
    >
      {children}
      <BetSlipPanel balancePoints={balancePoints} loggedIn={loggedIn} />
    </Ctx.Provider>
  );
}
