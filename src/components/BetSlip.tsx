"use client";

import Link from "next/link";
import {
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
import { useActionState } from "react";
import { placeBetAction, type FormState } from "@/lib/actions";
import { fmtOdds, fmtPts, parseStakeToPoints, payoutPoints } from "@/lib/money";

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
}

interface SlipContext {
  slip: SlipSelection | null;
  setSlip: (s: SlipSelection | null) => void;
}

const Ctx = createContext<SlipContext | null>(null);

export function useBetSlip(): SlipContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBetSlip outside BetSlipProvider");
  return ctx;
}

const QUICK_STAKES = ["100", "500", "1000", "5000"];

function BetSlipPanel({
  balancePoints,
  loggedIn,
}: {
  balancePoints: number;
  loggedIn: boolean;
}) {
  const { slip, setSlip } = useBetSlip();
  const [stake, setStake] = useState("100");
  const [state, formAction, pending] = useActionState<FormState, FormData>(
    placeBetAction,
    {}
  );
  const [closedFor, setClosedFor] = useState(false);

  useEffect(() => {
    if (!slip) return;
    const update = () => setClosedFor(Date.parse(slip.kickoff) <= Date.now());
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [slip]);

  if (!slip) return null;

  const stakePts = parseStakeToPoints(stake);
  const projected = stakePts !== null ? payoutPoints(stakePts, slip.odds) : null;

  return (
    <div className="fixed bottom-0 right-0 z-40 w-full sm:bottom-4 sm:right-4 sm:w-80">
      <div className="border border-[#f0b429]/40 bg-[#0e1c33] shadow-2xl shadow-black/60 sm:rounded-xl">
        <div className="flex items-center justify-between border-b border-[#1b2c4a] bg-[#13243f] px-4 py-2.5 sm:rounded-t-xl">
          <span className="text-sm font-bold uppercase tracking-wide text-[#f0b429]">
            Bet Slip
          </span>
          <button
            onClick={() => setSlip(null)}
            className="text-slate-400 hover:text-white"
            aria-label="Close bet slip"
          >
            ✕
          </button>
        </div>
        <form action={formAction} className="space-y-3 px-4 py-3">
          <input type="hidden" name="matchId" value={slip.matchId} />
          <input type="hidden" name="market" value={slip.market} />
          <input type="hidden" name="line" value={slip.line ?? ""} />
          <input type="hidden" name="selection" value={slip.selection} />
          <div>
            <div className="text-xs text-slate-400">{slip.matchLabel}</div>
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
                type="submit"
                disabled={pending || closedFor}
                className="w-full rounded-md bg-[#f0b429] py-2 text-sm font-bold uppercase tracking-wide text-[#081120] transition hover:bg-[#ffd166] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                {pending ? "Placing…" : "Place Bet"}
              </button>
            </>
          )}
        </form>
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
  const [slip, setSlip] = useState<SlipSelection | null>(null);
  return (
    <Ctx.Provider value={{ slip, setSlip }}>
      {children}
      <BetSlipPanel balancePoints={balancePoints} loggedIn={loggedIn} />
    </Ctx.Provider>
  );
}
