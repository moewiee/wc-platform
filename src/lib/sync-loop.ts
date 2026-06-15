import { maybeEarlyResolve } from "./bets";
import { maybeRefreshMarketOdds, maybeRefreshOdds, maybeSyncScores } from "./matches";
import { maybeGenerateAiTips } from "./tips";
import { maybePlaceTipsterBets } from "./tipster-bets";

// Background sync so odds refresh and settlement don't depend on page
// traffic. The tick is cheap: each maybe* step carries its own throttle
// and skips when nothing is due.
const TICK_MS = 5 * 60 * 1000;

declare global {
  // eslint-disable-next-line no-var
  var __wcSyncTimer: NodeJS.Timeout | undefined;
}

async function tick(): Promise<void> {
  try {
    await maybeRefreshOdds();
  } catch (e) {
    console.error("[sync] odds refresh failed:", e instanceof Error ? e.message : e);
  }
  try {
    await maybeRefreshMarketOdds();
  } catch (e) {
    console.error("[sync] market odds refresh failed:", e instanceof Error ? e.message : e);
  }
  try {
    await maybeSyncScores();
  } catch (e) {
    console.error("[sync] score sync failed:", e instanceof Error ? e.message : e);
  }
  try {
    const res = await maybeEarlyResolve();
    if (res.resolved > 0) console.log(`[sync] early-resolved ${res.resolved} locked bets`);
  } catch (e) {
    console.error("[sync] early resolve failed:", e instanceof Error ? e.message : e);
  }
  try {
    const res = await maybeGenerateAiTips();
    if ("created" in res) {
      console.log(
        `[sync] ai tips: ${res.created} tips across ${res.matches} matches` +
          (res.error ? ` (last error: ${res.error})` : "")
      );
    }
  } catch (e) {
    console.error("[sync] ai tips failed:", e instanceof Error ? e.message : e);
  }
  try {
    const res = await maybePlaceTipsterBets();
    if ("placed" in res && res.placed > 0) {
      console.log(`[sync] tipster bets: ${res.placed} placed (${res.tips} open tips)`);
    }
  } catch (e) {
    console.error("[sync] tipster bets failed:", e instanceof Error ? e.message : e);
  }
}

export function startSyncLoop(): void {
  if (global.__wcSyncTimer) return; // already running (dev HMR re-imports)
  global.__wcSyncTimer = setInterval(() => void tick(), TICK_MS);
  global.__wcSyncTimer.unref?.();
  void tick(); // immediately, so a restart settles overdue matches right away
}
