export const STARTING_BALANCE_POINTS = 20_000; // every new account starts with 20,000 pts
export const MIN_STAKE_POINTS = 10;
// A player's open stakes on a single match (across all markets) can't exceed this.
export const MAX_STAKE_PER_MATCH_POINTS = 2_000;
// Of that per-match allowance, only this much may be staked once a match is
// live. In-play prices ride a feed that lags real life, so a sharp viewer can
// briefly know more than our model; this sub-cap bounds how much any single
// in-play position (e.g. a goal snipe) can be worth. Counts in-play stakes
// only; pre-match stakes still count toward MAX_STAKE_PER_MATCH_POINTS.
export const MAX_INPLAY_STAKE_PER_MATCH_POINTS = 1_000;

// ── Parlay (cross-match accumulator) limits ──────────────────────────────────
// Legs must come from DIFFERENT matches (one leg per match): independent events
// whose real odds multiply exactly, so no correlation model is needed. Pre-match
// legs only; all legs must kick off on the same day.
export const MIN_PARLAY_LEGS = 2;
export const MAX_PARLAY_LEGS = 6;
export const MAX_PARLAY_STAKE_POINTS = 500;
export const MAX_PARLAY_PAYOUT_POINTS = 5_000;

// The friends' local matchday for the "all legs same day" parlay rule. The
// group is in GMT+7 (no DST), so shifting the instant +7h and taking the UTC
// date yields the local calendar day. Used identically on client and server so
// the two never disagree (kickoffs are stored as UTC, but a late-UTC match can
// be the same *local* matchday as an early-next-UTC-day one).
export const PARLAY_DAY_OFFSET_MINUTES = 7 * 60;
export function parlayDayKey(iso: string): string {
  return new Date(Date.parse(iso) + PARLAY_DAY_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

// All balances/stakes/payouts are integer points.
export function fmtPts(points: number): string {
  return points.toLocaleString("en-US");
}

export function fmtOdds(oddsX1000: number): string {
  return (oddsX1000 / 1000).toFixed(2);
}

// Decimal odds are stored as integers x1000; payouts round down to whole points.
export function payoutPoints(stakePoints: number, oddsX1000: number): number {
  return Math.floor((stakePoints * oddsX1000) / 1000);
}

// Asian-handicap partial outcomes (whole-point rounding, house keeps fractions).
export function halfWinPayout(stakePoints: number, oddsX1000: number): number {
  // half the stake wins at odds, half is refunded
  return Math.floor((stakePoints * 1000 + stakePoints * oddsX1000) / 2000);
}

export function halfLosePayout(stakePoints: number): number {
  // half the stake is refunded, half is lost
  return Math.floor(stakePoints / 2);
}

// ── Parlay odds & payout math ────────────────────────────────────────────────
// Combined decimal odds (x1000) of N legs, each odds x1000. Multiply in a wide
// BigInt accumulator and divide once at the very end so the result floors a
// single time (per-leg rounding would drift the last point).
export function combineOddsX1000(legOddsX1000: number[]): number {
  if (legOddsX1000.length === 0) return 1000;
  let num = 1n;
  for (const o of legOddsX1000) num *= BigInt(o);
  const den = 1000n ** BigInt(legOddsX1000.length - 1);
  return Number(num / den);
}

// When a parlay's all-win payout would exceed the cap, reduce the stake so the
// bettor pays only for the capped return (and keeps the leftover) instead of
// over-staking for a clipped payout. Returns the stake actually taken: the
// requested stake, or the largest stake whose payout still fits the cap, but
// never below the minimum (if the odds are so long even the min stake hits the
// cap, the cap then applies to that min-stake bet). Shared client + server.
export function effectiveParlayStake(
  requestedStake: number,
  combinedOddsX1000: number,
  capPoints: number,
  minStake: number
): number {
  const maxForCap = Math.floor((capPoints * 1000) / combinedOddsX1000);
  return Math.max(minStake, Math.min(requestedStake, maxForCap));
}

// Parlay payout = floor(stake · Π(factor_i / 1000)), capped. Each `factor` is a
// per-leg multiplier x1000: a winning leg contributes its odds; a void/push leg
// contributes 1000 (1.000, dropping out); a quarter-line half-win contributes
// (1000+odds)/2 and a half-loss 500 — mirroring halfWinPayout / halfLosePayout.
// A fully losing leg must be handled by the caller (the whole parlay loses).
// Used at placement too, with factors = the leg odds (the all-legs-win payout).
export function parlayPayoutPoints(
  stakePoints: number,
  factorsX1000: number[],
  capPoints: number
): number {
  let num = BigInt(stakePoints);
  for (const f of factorsX1000) num *= BigInt(f);
  const den = 1000n ** BigInt(factorsX1000.length);
  return Math.min(Number(num / den), capPoints);
}

export function parseStakeToPoints(input: string): number | null {
  const t = input.trim().replace(/,/g, "");
  if (!/^\d+$/.test(t)) return null;
  const points = parseInt(t, 10);
  return Number.isSafeInteger(points) ? points : null;
}
