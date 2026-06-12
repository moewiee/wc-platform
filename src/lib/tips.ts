import { db, getMeta, nowIso, setMeta } from "./db";
import { findSelection, marketsForMatch, modelForMatch } from "./markets";
import { fmtOdds } from "./money";
import type { MarketType, Match, Tip } from "./types";

// "Expert opinion" tips. Two sources:
//  - 'model':  instant statistical personas derived from the Poisson model
//  - 'openai': AI agents that read recent news via OpenAI web search
//              (set OPENAI_API_KEY in .env.local; OPENAI_MODEL overrides model)

export function getTips(matchId: number): Tip[] {
  return db
    .prepare("SELECT * FROM tips WHERE match_id = ? ORDER BY id")
    .all(matchId) as Tip[];
}

function insertTip(
  matchId: number,
  expert: string,
  avatar: string,
  market: MarketType,
  line: number | null,
  selection: string,
  label: string,
  confidence: number,
  rationale: string,
  source: "openai" | "model"
): void {
  db.prepare(
    `INSERT INTO tips (match_id, expert, avatar, market, line, selection, label,
       confidence, rationale, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    matchId,
    expert,
    avatar,
    market,
    line,
    selection,
    label,
    confidence,
    rationale,
    source,
    nowIso()
  );
}

// ── Statistical personas (no API key needed) ────────────────────────────────

export function ensureModelTips(match: Match): void {
  if (match.status !== "scheduled") return;
  const existing = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM tips WHERE match_id = ? AND source = 'model'"
      )
      .get(match.id) as { n: number }
  ).n;
  if (existing > 0) return;

  const model = modelForMatch(match);
  if (!model) return;
  const { lh, la, ph, pd, pa } = model;
  const markets = marketsForMatch(match);
  const pct = (p: number) => `${Math.round(p * 100)}%`;
  const xg = `${lh.toFixed(1)}–${la.toFixed(1)}`;

  db.transaction(() => {
    // The Quant: most likely 1X2 outcome.
    const h2h = markets.find((m) => m.market === "h2h");
    if (h2h) {
      const probs: [string, number][] = [
        ["home", ph],
        ["draw", pd],
        ["away", pa],
      ];
      probs.sort((a, b) => b[1] - a[1]);
      const [sel, p] = probs[0];
      const offer = h2h.selections.find((s) => s.selection === sel)!;
      insertTip(
        match.id,
        "The Quant",
        "🤖",
        "h2h",
        null,
        sel,
        `${h2h.name} · ${offer.label}`,
        p > 0.55 ? 5 : p > 0.45 ? 4 : 3,
        `My Poisson model projects expected goals at ${xg} and prices ${offer.label} at ${pct(p)}. At odds of ${fmtOdds(offer.odds)} this is the percentage play.`,
        "model"
      );
    }

    // Goals Guru: totals lean.
    const total = lh + la;
    const ou = markets.filter((m) => m.market === "ou_goals");
    const mid = ou.find((m) => m.line !== null && Math.abs(m.line - 2.5) < 0.01) ?? ou[Math.floor(ou.length / 2)];
    if (mid && mid.line !== null) {
      const lean = total > mid.line ? "over" : "under";
      const offer = mid.selections.find((s) => s.selection === lean)!;
      insertTip(
        match.id,
        "Goals Guru",
        "⚽",
        "ou_goals",
        mid.line,
        lean,
        `${mid.name} · ${offer.label}`,
        Math.abs(total - mid.line) > 0.5 ? 4 : 3,
        `Expected total goals come out at ${total.toFixed(2)} for this one. ${offer.label} at ${fmtOdds(offer.odds)} is where the value sits.`,
        "model"
      );
    }

    // Upset Radar or Captain Chalk depending on how lopsided the match is.
    const ah = markets.find((m) => m.market === "ah_goals");
    if (ah && ah.line !== null) {
      const dogIsHome = pa > ph;
      const dogOdds = dogIsHome ? match.odds_home : match.odds_away;
      if (dogOdds && dogOdds >= 3500) {
        const sel = dogIsHome ? "home" : "away";
        const offer = ah.selections.find((s) => s.selection === sel)!;
        insertTip(
          match.id,
          "Upset Radar",
          "📡",
          "ah_goals",
          ah.line,
          sel,
          `${ah.name} · ${offer.label}`,
          3,
          `Everyone is on the favourite, which inflates the other side. Taking ${offer.label} at ${fmtOdds(offer.odds)} gives a real cushion if this stays tight.`,
          "model"
        );
      } else {
        const favSel = ph >= pa ? "home" : "away";
        const offer = ah.selections.find((s) => s.selection === favSel)!;
        insertTip(
          match.id,
          "Captain Chalk",
          "🏆",
          "ah_goals",
          ah.line,
          favSel,
          `${ah.name} · ${offer.label}`,
          4,
          `Class difference shows up over 90 minutes. ${offer.label} at ${fmtOdds(offer.odds)} beats the short 1X2 price on the favourite.`,
          "model"
        );
      }
    }
  })();
}

// ── OpenAI news-reading agents ──────────────────────────────────────────────

export function openAiConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY?.trim();
}

interface OpenAiOutputItem {
  type: string;
  content?: { type: string; text?: string }[];
}

async function callOpenAi(prompt: string, useWebSearch: boolean): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL?.trim() || "gpt-5-mini",
      ...(useWebSearch ? { tools: [{ type: "web_search" }] } : {}),
      input: prompt,
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = (await res.json()) as { output?: OpenAiOutputItem[]; output_text?: string };
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  let text = "";
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) {
      if (c.type === "output_text" && c.text) text += c.text;
    }
  }
  return text;
}

// Three agents with deliberately different characters: Eddie chases dressing-
// room news, Anna reads form and tactics, Vic only cares whether the price is
// wrong. Each gets at most one tip per match.
const AI_EXPERTS = [
  {
    name: "Eddie Insider",
    avatar: "🕵️",
    angle:
      "team news, injuries, suspensions, rotation and likely line-ups reported in the last few days",
    style:
      "You trust dressing-room whispers over statistics. If the news gives you no edge, pick the market the missing/returning players affect most.",
  },
  {
    name: "Anna Analyst",
    avatar: "📊",
    angle:
      "recent form, tactical match-ups, set-piece threat and what statistical previews and pundits are saying",
    style:
      "You are methodical and slightly contrarian to hype. You prefer handicaps and totals (goals or corners) where the tactical picture is clear.",
  },
  {
    name: "Vic Value",
    avatar: "💰",
    angle:
      "the betting market itself: where the quoted odds look wrong versus realistic probabilities, overreactions to news, and public-money bias on big names",
    style:
      "You never bet the obvious favourite at a short price. Compare the quoted odds with what you think the true chances are and take the biggest gap, even on an unfashionable selection.",
  },
];

interface AiTipJson {
  market?: string;
  line?: number | null;
  selection?: string;
  confidence?: number;
  rationale?: string;
}

function marketMenu(match: Match): string {
  return marketsForMatch(match)
    .map(
      (m) =>
        `- market="${m.market}"${m.line !== null ? ` line=${m.line}` : ""}: ${m.selections
          .map((s) => `selection="${s.selection}" (${s.label} @ ${fmtOdds(s.odds)})`)
          .join(", ")}`
    )
    .join("\n");
}

export async function generateAiTipsForMatch(
  match: Match
): Promise<{ created: number; error?: string }> {
  if (!openAiConfigured()) return { created: 0, error: "OPENAI_API_KEY not set." };
  if (match.status !== "scheduled") return { created: 0 };
  let created = 0;
  for (const expert of AI_EXPERTS) {
    const already = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tips WHERE match_id = ? AND expert = ?"
      )
      .get(match.id, expert.name) as { n: number };
    if (already.n > 0) continue;

    const prompt = `You are "${expert.name}", a football betting expert focused on ${expert.angle}.
${expert.style}
Match: ${match.home_team} vs ${match.away_team}, FIFA World Cup 2026${match.group_name ? `, Group ${match.group_name}` : ""}, kickoff ${match.kickoff}${match.venue ? `, in ${match.venue}` : ""}.
Search the web for the latest news about both teams, weigh it from your angle, then pick exactly ONE bet from this menu of available markets:
${marketMenu(match)}

Respond with ONLY a JSON object, no other text:
{"market": "<market>", "line": <line number or null>, "selection": "<selection>", "confidence": <1-5>, "rationale": "<2-3 sentences in your persona's voice citing the concrete news/facts behind the pick>"}`;

    try {
      let text: string;
      try {
        text = await callOpenAi(prompt, true);
      } catch {
        text = await callOpenAi(prompt, false); // model may not support web_search
      }
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const tip = JSON.parse(jsonMatch[0]) as AiTipJson;
      if (!tip.market || !tip.selection) continue;
      const line = tip.line === undefined || tip.line === null ? null : Number(tip.line);
      const offer = findSelection(
        match,
        tip.market as MarketType,
        Number.isFinite(line as number) ? line : null,
        tip.selection
      );
      if (!offer) continue;
      const confidence = Math.min(5, Math.max(1, Math.round(tip.confidence ?? 3)));
      insertTip(
        match.id,
        expert.name,
        expert.avatar,
        tip.market as MarketType,
        Number.isFinite(line as number) ? line : null,
        tip.selection,
        offer.label,
        confidence,
        (tip.rationale ?? "").slice(0, 600) || "Pick based on the latest team news.",
        "openai"
      );
      created++;
    } catch (e) {
      return {
        created,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }
  return { created };
}

// Generate AI tips for every match kicking off within the window that any of
// the agents hasn't covered yet. Keeps going past per-match errors so one bad
// response doesn't starve the rest; the last error is reported.
export async function generateAiTipsForUpcoming(
  windowHours = 24
): Promise<{ created: number; matches: number; error?: string }> {
  if (!openAiConfigured()) {
    return { created: 0, matches: 0, error: "OPENAI_API_KEY not set in .env." };
  }
  const until = new Date(Date.now() + windowHours * 3600 * 1000).toISOString();
  const upcoming = db
    .prepare(
      `SELECT m.* FROM matches m
       WHERE m.status = 'scheduled' AND m.kickoff > ? AND m.kickoff <= ?
         AND (SELECT COUNT(DISTINCT t.expert) FROM tips t
              WHERE t.match_id = m.id AND t.source = 'openai') < ?
       ORDER BY m.kickoff`
    )
    .all(nowIso(), until, AI_EXPERTS.length) as Match[];
  let created = 0;
  let error: string | undefined;
  for (const match of upcoming) {
    const res = await generateAiTipsForMatch(match);
    created += res.created;
    if (res.error) error = res.error;
  }
  return { created, matches: upcoming.length, error };
}

// 12-hourly scheduler entry point (called from the background sync loop):
// gather news on everything kicking off in the next 24 h and publish tips.
const AI_TIPS_INTERVAL_MS = 12 * 60 * 60 * 1000;

export async function maybeGenerateAiTips(
  force = false
): Promise<{ skipped: string } | { created: number; matches: number; error?: string }> {
  if (!openAiConfigured()) return { skipped: "No OPENAI_API_KEY configured." };
  const last = getMeta("last_ai_tips_run");
  if (!force && last && Date.now() - Date.parse(last) < AI_TIPS_INTERVAL_MS) {
    return { skipped: "AI tips ran within the last 12 hours." };
  }
  setMeta("last_ai_tips_run", nowIso());
  return generateAiTipsForUpcoming(24);
}
