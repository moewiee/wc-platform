import { maybeRefreshOdds, maybeSyncScores } from "./matches";
import { maybeGenerateAiTips } from "./tips";

// Background sync so odds refresh and settlement don't depend on page
// traffic. The tick is cheap: maybeRefreshOdds/maybeSyncScores carry their
// own throttles (30 min / 10 min) and skip when nothing is due.
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
    await maybeSyncScores();
  } catch (e) {
    console.error("[sync] score sync failed:", e instanceof Error ? e.message : e);
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
}

export function startSyncLoop(): void {
  if (global.__wcSyncTimer) return; // already running (dev HMR re-imports)
  global.__wcSyncTimer = setInterval(() => void tick(), TICK_MS);
  global.__wcSyncTimer.unref?.();
  void tick(); // immediately, so a restart settles overdue matches right away
}
