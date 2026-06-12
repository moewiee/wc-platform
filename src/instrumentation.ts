// Runs once when the Next.js server boots (dev and production).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startSyncLoop } = await import("./lib/sync-loop");
  startSyncLoop();
}
