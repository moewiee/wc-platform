"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  changePassword,
  createSession,
  createUser,
  destroySession,
  getCurrentUser,
  verifyLogin,
} from "./auth";
import {
  cancelBet,
  cancelParlay,
  completeMatchData,
  placeBet,
  placeParlay,
  settleMatch,
  voidMatch,
  type ParlayLegInput,
} from "./bets";
import { maybeRefreshMarketOdds, maybeRefreshOdds, maybeSyncScores } from "./matches";
import { fmtOdds, fmtPts, parseStakeToPoints } from "./money";
import { generateAiTipsForUpcoming } from "./tips";
import { maybePlaceTipsterBets } from "./tipster-bets";
import { MARKET_TYPES, type MarketType } from "./types";

export type FormState = { error?: string; success?: string; newOdds?: number };

const MARKETS: ReadonlySet<string> = new Set(MARKET_TYPES);

function optionalInt(formData: FormData, name: string): number | null {
  const raw = String(formData.get(name) ?? "").trim();
  return raw === "" ? null : Number(raw);
}

export async function registerAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) return { error: "Passwords do not match." };
  const res = createUser(username, password);
  if (!res.user) return { error: res.error ?? "Could not create the account." };
  await createSession(res.user.id);
  redirect("/");
}

export async function loginAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const user = verifyLogin(username, password);
  if (!user) return { error: "Invalid username or password." };
  await createSession(user.id);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await destroySession();
  redirect("/login");
}

export async function placeBetAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const matchId = Number(formData.get("matchId"));
  const market = String(formData.get("market") ?? "");
  const lineRaw = String(formData.get("line") ?? "").trim();
  const line = lineRaw === "" ? null : Number(lineRaw);
  const selection = String(formData.get("selection") ?? "");
  const stake = parseStakeToPoints(String(formData.get("stake") ?? ""));
  // The odds the bettor saw (×1000), used only as an in-play staleness check.
  const oddsRaw = String(formData.get("odds") ?? "").trim();
  const expectedOdds = oddsRaw === "" ? null : Number(oddsRaw);
  if (!Number.isInteger(matchId)) return { error: "Invalid match." };
  if (!MARKETS.has(market)) return { error: "Pick a market first." };
  if (line !== null && !Number.isFinite(line)) return { error: "Invalid line." };
  if (!selection) return { error: "Pick a selection first." };
  if (stake === null) return { error: "Enter a whole number of points, e.g. 100." };
  const res = await placeBet(
    user.id,
    matchId,
    market as MarketType,
    line,
    selection,
    stake,
    expectedOdds
  );
  if (!res.bet) {
    return res.newOdds !== undefined
      ? {
          error: `${res.error ?? "The live price moved."} New price ${fmtOdds(res.newOdds)} — review and place again.`,
          newOdds: res.newOdds,
        }
      : { error: res.error ?? "Could not place the bet." };
  }
  revalidatePath("/", "layout");
  return {
    success: `Bet placed: ${fmtPts(res.bet.stake_points)} pts at ${fmtOdds(res.bet.odds)} — potential payout ${fmtPts(res.bet.potential_payout_points)} pts.`,
  };
}

export async function cancelBetAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const betId = Number(formData.get("betId"));
  if (!Number.isInteger(betId)) return { error: "Invalid bet." };
  const res = cancelBet(user.id, betId);
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return { success: "Bet cancelled — stake refunded." };
}

export async function placeParlayAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const stake = parseStakeToPoints(String(formData.get("stake") ?? ""));
  if (stake === null) return { error: "Enter a whole number of points, e.g. 100." };
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(formData.get("legs") ?? "[]"));
  } catch {
    return { error: "Could not read the parlay selections." };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { error: "Add at least two selections to a parlay." };
  }
  const legs: ParlayLegInput[] = [];
  for (const raw of parsed as Array<Record<string, unknown>>) {
    const matchId = Number(raw.matchId);
    const market = String(raw.market ?? "");
    const lineRaw = raw.line;
    const line =
      lineRaw === null || lineRaw === undefined || lineRaw === ""
        ? null
        : Number(lineRaw);
    const selection = String(raw.selection ?? "");
    if (!Number.isInteger(matchId) || !MARKETS.has(market) || !selection) {
      return { error: "One of the parlay selections is invalid." };
    }
    if (line !== null && !Number.isFinite(line)) {
      return { error: "One of the parlay lines is invalid." };
    }
    legs.push({ matchId, market: market as MarketType, line, selection });
  }
  const res = await placeParlay(user.id, legs, stake);
  if (!res.parlay) return { error: res.error ?? "Could not place the parlay." };
  revalidatePath("/", "layout");
  const p = res.parlay;
  return {
    success: `Parlay placed: ${p.legs.length} legs at ${fmtOdds(p.combined_odds)} — ${fmtPts(p.stake_points)} pts to win ${fmtPts(p.potential_payout_points)} pts.`,
  };
}

export async function cancelParlayAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const parlayId = Number(formData.get("parlayId"));
  if (!Number.isInteger(parlayId)) return { error: "Invalid parlay." };
  const res = cancelParlay(user.id, parlayId);
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return { success: "Parlay cancelled — stake refunded." };
}

export async function changePasswordAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const current = String(formData.get("current") ?? "");
  const next = String(formData.get("next") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (next !== confirm) return { error: "New passwords do not match." };
  const res = changePassword(user.id, current, next);
  if (res.error) return { error: res.error };
  return { success: "Password updated." };
}

async function requireAdminForAction(): Promise<FormState | null> {
  const user = await getCurrentUser();
  if (!user?.is_admin) return { error: "Admins only." };
  return null;
}

export async function adminRefreshOddsAction(
  _prev: FormState,
  _formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  try {
    const res = await maybeRefreshOdds(true);
    // Per-market bookmaker odds ride along; a failure here shouldn't mask a
    // successful 1X2 refresh (its error lands in the last_oio_error meta).
    const marketRes = await maybeRefreshMarketOdds(true).catch(() => null);
    revalidatePath("/", "layout");
    if ("skipped" in res) return { error: res.skipped };
    const markets =
      marketRes && "updated" in marketRes
        ? `, market odds for ${marketRes.updated}`
        : "";
    return { success: `Odds refreshed — ${res.updated} matches updated from the API${markets}.` };
  } catch (e) {
    return { error: `Odds refresh failed: ${e instanceof Error ? e.message : e}` };
  }
}

export async function adminSyncScoresAction(
  _prev: FormState,
  _formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  try {
    const res = await maybeSyncScores(true);
    revalidatePath("/", "layout");
    return "skipped" in res
      ? { error: res.skipped }
      : { success: `Scores synced — ${res.updated} matches settled.` };
  } catch (e) {
    return { error: `Score sync failed: ${e instanceof Error ? e.message : e}` };
  }
}

export async function adminSettleAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  const matchId = Number(formData.get("matchId"));
  if (!Number.isInteger(matchId)) return { error: "Invalid match." };
  const res = settleMatch(matchId, {
    homeScore: Number(formData.get("homeScore")),
    awayScore: Number(formData.get("awayScore")),
    cornersHome: optionalInt(formData, "cornersHome"),
    cornersAway: optionalInt(formData, "cornersAway"),
    cardsTotal: optionalInt(formData, "cardsTotal"),
  });
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return { success: `Match settled — ${res.settledBets} bets resolved.` };
}

export async function adminCompleteDataAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  const matchId = Number(formData.get("matchId"));
  if (!Number.isInteger(matchId)) return { error: "Invalid match." };
  const res = completeMatchData(
    matchId,
    optionalInt(formData, "cornersHome"),
    optionalInt(formData, "cornersAway"),
    optionalInt(formData, "cardsTotal")
  );
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return { success: `Data added — ${res.settledBets} waiting bets resolved.` };
}

export async function adminVoidAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  const matchId = Number(formData.get("matchId"));
  if (!Number.isInteger(matchId)) return { error: "Invalid match." };
  const res = voidMatch(matchId);
  if (res.error) return { error: res.error };
  revalidatePath("/", "layout");
  return { success: `Match voided — ${res.refunded} stakes refunded.` };
}

export async function adminGenerateTipsAction(
  _prev: FormState,
  _formData: FormData
): Promise<FormState> {
  const denied = await requireAdminForAction();
  if (denied) return denied;
  const res = await generateAiTipsForUpcoming();
  // Fresh tips should hit the book straight away.
  const bets = await maybePlaceTipsterBets(true).catch(() => null);
  const placed = bets && "placed" in bets && bets.placed > 0 ? ` ${bets.placed} tipster bets placed.` : "";
  revalidatePath("/", "layout");
  if (res.error) {
    return {
      error: `AI tips: ${res.error}${res.created ? ` (${res.created} tips were created before the error)` : ""}`,
    };
  }
  if (res.matches === 0) {
    return { success: `All matches in the next 24 h already have AI tips.${placed}` };
  }
  return { success: `Generated ${res.created} AI tips across ${res.matches} matches.${placed}` };
}
