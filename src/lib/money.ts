export const STARTING_BALANCE_POINTS = 20_000; // every new account starts with 20,000 pts
export const MIN_STAKE_POINTS = 10;

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

export function parseStakeToPoints(input: string): number | null {
  const t = input.trim().replace(/,/g, "");
  if (!/^\d+$/.test(t)) return null;
  const points = parseInt(t, 10);
  return Number.isSafeInteger(points) ? points : null;
}
