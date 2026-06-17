# CLAUDE.md

Play-money World Cup 2026 betting site (Next.js 15 App Router + TypeScript +
better-sqlite3 + Tailwind 4). Product requirements live in
`output-requirements.txt`. No real money.

## Commands

```bash
npm run dev      # development server
npm run build    # typecheck + production build (this is the lint/typecheck gate)
npm start        # production server; add `-- -H 0.0.0.0` for LAN access
```

- Host: Debian 12, Node 24 system-wide via NodeSource (`/usr/bin/node`).
- There are no unit tests; verify with `npm run build` plus hitting the REST
  API (`/api/auth/register`, `/api/matches`, `/api/bets`) against a running
  server.
- **Reset DB**: stop the server, delete `data/`. It re-creates and re-seeds on
  next start. Always reset before handing over (test accounts/bets persist).

## Production deployment

The site runs as systemd services and is published at
**https://wc26.ankai.uk** through a Cloudflare Tunnel (no inbound firewall
ports). The bare domain `ankai.uk` is intentionally not used.

- `wc26.service` — `next start` bound to `127.0.0.1:3000`
  (WorkingDirectory = this repo, so `data/` lives here).
- `cloudflared.service` — named tunnel `wc26`, ingress `wc26.ankai.uk` →
  `http://localhost:3000`; config in `/etc/cloudflared/config.yml`,
  credentials in `~/.cloudflared/`.

```bash
sudo systemctl restart wc26        # after npm run build to ship a change
sudo journalctl -u wc26 -n 50      # app logs
sudo journalctl -u cloudflared -n 50
```

Deploying a change = `npm run build && sudo systemctl restart wc26`. The dev
server (`npm run dev`, port 3000) conflicts with the service — stop the
service first or use another port.

## Architecture

All domain logic lives in `src/lib/`; pages and API routes are thin.

| File | Role |
| --- | --- |
| `db.ts` | Schema + singleton connection (global, survives HMR). Seeding is versioned: bump `SEED_VERSION` in `seed.ts` after editing seed data. Init retries on `SQLITE_BUSY` because parallel `next build` workers all open the DB. |
| `money.ts` | **Invariants**: balances/stakes/payouts are integer points; odds are decimal ×1000 integers; payout = `floor(stake·odds/1000)`. AH half-win = `floor(stake·(1000+odds)/2000)`, half-loss refund = `floor(stake/2)`. |
| `markets.ts` | **All offered prices are REAL bookmaker quotes — no model pricing.** `marketsForMatch()` (pre-match) and `liveMarketsForMatch()` (in-play) build the whole sheet from fresh `market_odds` rows (odds-api.io / Bet365): 1X2 from the bookmaker moneyline, AH/totals one market per quoted line, BTTS, and the quoted correct-score cells. A market is offered **only when the bookmaker quotes it** — nothing is derived. Pre-match 1X2 falls back to the stored real anchor (`match.odds_*`, DraftKings via ESPN) when the bookmaker hasn't posted its moneyline yet; in-play uses the live moneyline only (never the stale pre-match 1X2). Pre-match tolerates 6 h-old quotes, **in-play 3 min** (stale ⇒ no markets ⇒ suspended). `findSelection`/`findLiveSelection` re-price one selection server-side (never trust client odds). `settleSelection()` (win/lose/push/half_win/half_lose/**pending**) is a pure function of the final result, so an in-play bet settles identically to the same pre-match selection. `modelForMatch` (Poisson fit of the de-margined 1X2) remains ONLY to power the statistical expert-tips personas — it never prices an offered market. |
| `odds-api-io.ts` | odds-api.io v3 client (per-market bookmaker odds; free tier **100 req/h _per key_** — `ODDS_API_IO_KEY` accepts a comma-separated list rotated round-robin with 429 failover, so N free accounts = N×100/h). League slug `international-fifa-world-cup`, single bookmaker `Bet365`, `/odds/multi` batches 10 events per request and returns the full per-market book (the **same shape pre-match and in-play**). Feed market names map to our families: `ML` → `h2h` (`{home,draw,away}`), `Spread`/`Alternative Asian Handicap` → `ah_goals`, `Totals` → `ou_goals`, `Bookings Totals` → `ou_cards` (lines > 15 skipped as booking points), `Both Teams To Score`, correct-score labels (`"2-1"`). Domain errors arrive as HTTP 200 `{error}` bodies. `fetchOioEvents` (pending) / `fetchOioLiveEvents` (`status=live`) map matches by `teamPairKey` → `matches.oio_event_id`. `maybeRefreshMarketOdds` (matches.ts, pre-match overlay, 10-min throttle, **nearest 10 matches = one `/odds/multi` call**). |
| `bets.ts` | `placeBet` (**async**; re-prices server-side — never trust client odds) routes pre-match bets through the normal counter and **in-play** bets through `bookInPlay`: it awaits a fresh live observation (`getLiveContext`) *before* the synchronous booking transaction, then re-reads suspension (`getLiveContextSync`) *inside* it so the priced snapshot matches the bet. In-play adds a tighter `MAX_INPLAY_STAKE_PER_MATCH_POINTS` (500) sub-cap, sets `bets.in_play=1`, writes the live score/minute into the ledger note, and supports a one-directional re-quote (`expectedOdds` → `newOdds` when the price moved materially against the bettor). `cancelBet` (within `CANCEL_WINDOW_MS` = 30 min of placement, and before kickoff — so in-play bets are non-cancellable for free), `settleMatch`, `completeMatchData`, `voidMatch`. `maybeEarlyResolve` (sync loop) settles bets already **mathematically locked** by the live tallies before full time — O/U once its total clears the line (only on a *full* win/lose, so quarter lines wait until both sub-lines clear), a correct-score cell once overtaken, BTTS once both teams score (goals + corners + cards, all monotonic); acts only on a VAR-safe confirmed-stable score (`getConfirmedLiveScore`, ≥5 min steady) and the match stays `scheduled`, so `settleMatch` (which skips non-pending) never double-settles. **Mixed parlays** (cross-match accumulators): `placeParlay` re-prices every leg server-side and locks `combined_odds` = the integer-×1000 **product** of the legs' real quotes — no model, because legs are from *different* matches and so independent (the only correlation-safe parlay without a joint model). Rules enforced server-side (UI mirrors): **one leg per match** (the correlation block, also a DB unique index), **pre-match legs only**, **all legs same day** (the group's local day, GMT+7, via `parlayDayKey` in `money.ts` — shared client/server so a late-UTC match groups with the next-UTC-day one as the same local matchday), 2–`MAX_PARLAY_LEGS` (6) legs, stake ≤ `MAX_PARLAY_STAKE_POINTS` (500), payout capped at `MAX_PARLAY_PAYOUT_POINTS` (5,000) — and when the all-win payout would exceed the cap the **stake is auto-reduced** (`effectiveParlayStake`) so the bettor only risks what earns the max payout and keeps the leftover, instead of the cap silently clipping their profit; the (effective) parlay stake counts toward each leg's `MAX_STAKE_PER_MATCH_POINTS`. Settlement reuses `settleSelection` per leg (a leg settles identically to the same single): all-or-nothing — `reevaluateParlay` marks the ticket **lost the instant any leg loses** (early locked loss via `maybeEarlyResolve`), pays only once **every** leg is terminal; a void/postponed leg (`voidMatch`) → factor 1.000 and the parlay recomputes on the rest (all-void → refund). `cancelParlay` mirrors `cancelBet` (30-min window, before any leg kicks off). Combined-odds/payout math (`combineOddsX1000`, `parlayPayoutPoints`, BigInt, floor once at the end) lives in `money.ts`. Every balance change goes through `applyBalanceChange` (now tagged with `parlay_id`) inside a `db.transaction` and writes a ledger row. |
| `matches.ts` | Odds + score sync. Odds refresh throttled to 10 min on the keyless ESPN path (one GET per refresh) or 30 min when `ODDS_API_KEY` is set (free tier is 500 credits/mo); scores to 10 min (throttle stamps in `meta` table). Both odds and scores come from The Odds API when `ODDS_API_KEY` is set, otherwise from ESPN (keyless; odds are DraftKings moneylines, `api_id` prefixed `espn:`) — either way odds auto-refresh and finished matches auto-settle, then a best-effort completion pass fills corners/cards from ESPN box scores so those bets settle too. `maybeSyncScores` won't auto-settle a started match until a **full-time floor** has passed (`GROUP_FULLTIME_FLOOR_MS` 110 min / `KO_FULLTIME_FLOOR_MS` 140 min from kickoff) so a feed that briefly reports a *live* game "completed" can't lock an interim score on open in-play bets (the admin's manual settle bypasses the floor). Upsert matches by `api_id`, falling back to normalized team-pair — only against `scheduled` rows; voided rows release their `api_id` so rescheduled fixtures reappear. |
| `odds-api.ts` | The Odds API v4 client. Sport key `soccer_fifa_world_cup`; soccer h2h outcomes are named home_team / away_team / `"Draw"`; scores come back as **numeric strings**. Free tier 500 credits/mo — keep calls throttled. |
| `espn.ts` | Keyless ESPN source: the public scoreboard JSON (`site.api.espn.com/.../soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD`) gives finals + corners (`wonCorners`), live in-play scores with clock, and 1X2 odds (DraftKings moneylines, American format → decimal ×1000); `fetchEspnCards` reads total cards (yellow = 1, red = 2) from the per-match `summary` box score. ESPN team names match the seeds via `normTeam` — verified for all 72 group fixtures. |
| `live.ts` | In-play state hub. Two cheap sources feed it: **ESPN** (keyless, free) for live score/clock + the goal tripwire, and **Bet365** (odds-api.io) for the actual in-play prices. `maybeRefreshLive(force)` refreshes ESPN scores → `live_state` and, throttled to `LIVE_ODDS_REFRESH_MS` (env, default 45 s; force = placement bypasses it but shares an 8 s burst window), pulls Bet365 in-play odds → `market_odds` (`refreshLiveOdds`, only while a live match is actually watched, not the slow sync loop — to conserve quota). **Suspension** is decided from ESPN in `live_state`: a score change (either direction) arms a `COOLOFF_MS` (150 s) pause; also suspended when the feed is stale (`STALE_MS` 150 s), the minute isn't advancing (`FROZEN_MS` 130 s — HT/VAR/stoppage), at HT/FT, or a knockout (`group_name` null) is past minute 80. Quote freshness is the *other* gate: stale/absent Bet365 quotes ⇒ `liveMarketsForMatch` is empty ⇒ suspended. `minute` comes from the running clock, never `shortDetail`; unparseable fails closed. `getLiveContext(match, force)` (async, fetches) for the markets poll/placement; `getLiveContextSync` (no fetch) for the placement transaction re-check. `getLiveScores` (lobby, `/api/live`) refreshes ESPN only. `live_state` also stores live `corners` (ESPN `wonCorners`); `getConfirmedLiveScore` returns the score + corner total only when steady ≥5 min (for early settlement). `inPlayEnabled()` gates the feature (env `INPLAY_BETTING`, default on). |
| `sync-loop.ts` + `instrumentation.ts` | Background sync: `register()` starts a 5-min `setInterval` (plus one immediate tick at boot) calling `maybeRefreshOdds`/`maybeSyncScores`, so settlement doesn't depend on page traffic. Guarded by a `global` so dev HMR doesn't stack timers. |
| `auth.ts` | bcrypt + session token (sha256-hashed in DB). The same raw token is the cookie value **and** the REST API bearer token. First registered user gets `is_admin=1`. |
| `tips.ts` | Expert tips: instant statistical personas (`ensureModelTips`, runs on match-page render) + three OpenAI news-reading agents with distinct characters (Eddie Insider/team news, Anna Analyst/form & tactics, Vic Value/price hunting; Responses API with `web_search` tool, falls back to no-tools, then skips). `maybeGenerateAiTips` runs them from the sync loop every 12 h over matches kicking off within 24 h (stamp `last_ai_tips_run`); the admin button forces the same pass. One tip per agent per match. |
| `tipster-bets.ts` | Tipsters bet their own tips: each persona has a bot user (`is_bot=1`, username **with a space** so players can't register/log into it, random password). `maybePlaceTipsterBets` (sync loop, 15-min throttle, next-24h window) ensures model tips exist, then places a bet per unbet tip via `placeBet` (stake = confidence × 100, capped by bankroll; broke tipsters go quiet) and links it through `tips.bet_id`. Unquotable selections (line moved) retry until kickoff. First-human-gets-admin counts `is_bot = 0` only (auth.ts). Leaderboard shows bots with a "tipster" badge. |
| `actions.ts` | All server actions (`"use server"`); every mutating action re-validates the session, admin actions check `is_admin`. |
| `api.ts` + `src/app/api/**` | REST API payload shapes and routes (auth, matches, bets). `GET /api/matches/[id]/markets` returns the live (or pre-match) market sheet plus the live score/clock and `suspended`/`reason` — polled by the match page and usable by API clients. `POST /api/bets` takes an optional `expected_odds` and answers an in-play re-quote with HTTP 409 + `new_odds`. `POST /api/parlays` places a cross-match accumulator (`{legs:[{match_id,market,line?,selection}], stake_points}`); `GET /api/parlays` lists them; `GET`/`DELETE /api/parlays/[id]` fetch/cancel one. |

Client components (`src/components/`): `BetSlip.tsx` holds the slip context
(`useBetSlip`, a list of selections with a **Single/Parlay** mode toggle) and
renders the docked slip; `OddsButton` cells feed it (`toggle`/`isSelected`). In
Single mode a new pick replaces the slip; in Parlay mode picks accumulate as
legs, with the one-leg-per-match / same-day / pre-match / max-legs blocks
enforced client-side too (server re-checks).
`OddsBoard` (home) and `MarketBoard` (match page) are presentation over
serialized market data computed in server components. **`LiveMarketBoard`**
polls `/api/matches/[id]/markets` every 15 s for a started match and renders
`MarketBoard` with a `live` prop (live banner + suspension-driven disabling);
the match page picks pre-match vs live by kickoff. Date grouping and
kickoff countdowns are mount-gated to avoid SSR/client timezone hydration
mismatches — keep that pattern.

## Rules that must hold

- Pre-match counter closes at kickoff; **in-play** takes over: once
  `kickoff <= now` the pre-match path in `placeBet` is closed, and bets are
  accepted only through the in-play path (live, unsuspended observation, feature
  enabled). No cancellations after kickoff either way. UI mirrors both.
- In-play prices are **real Bet365 in-play quotes — never derived**. A live
  market is offered only when the bookmaker quotes it; nothing is modelled. The
  display board polls every `LIVE_ODDS_REFRESH_MS` (so it can lag), but bet
  *safety* doesn't depend on that: every in-play bet is **re-priced against a
  freshly force-fetched Bet365 quote at placement** (8 s micro-cache) and
  rejected if the bookmaker has suspended/moved that market. Other guards
  (don't remove — they bound the residual feed-lag snipe): **suspend** on a
  score-change cool-off / stale or frozen feed / HT-FT / knockout-past-80' /
  no-fresh-quote; re-check suspension *inside* the booking transaction; lower
  `MAX_INPLAY_STAKE_PER_MATCH_POINTS` cap; one-directional re-quote. The
  residual (a viewer seeing a goal before our feed does) collapses to the feed's
  own sub-second latency at placement and is capped — bounded, not solved.
- Cancellation window: a bet can only be cancelled within 30 minutes of
  placement (`CANCEL_WINDOW_MS` in `bets.ts`; checked server-side, UI mirrors
  it on My Bets) — never after kickoff, so in-play bets can't be cancelled. The
  web UI also asks for confirmation before placing a bet.
- Bets lock the odds at placement; later odds moves never change an open bet.
  In-play bets settle on the full-time result exactly like pre-match ones
  (`settleSelection` is price-source- and timing-independent — no in-play
  settlement code).
- Settlement is one-way: a `finished`/`void` match can't be re-settled
  (`settleMatch`/`voidMatch` guard on `status = 'scheduled'`).
- Parlays multiply **only real quotes from different matches** — never
  same-match legs (those need a joint correlation model we refuse to build, and
  no feed publishes a bet-builder price). The one-leg-per-match block is the
  load-bearing correctness rule: drop it and the multiplied odds over-pay
  correlated outcomes. All-or-nothing settlement reuses `settleSelection` so a
  leg settles identically to the same single; a void/postponed leg drops at odds
  1.000 and the rest stand. Parlays are pre-match-only for now.
- Ledger consistency: `users.balance_points` must always equal
  20,000 − Σstakes + Σpayouts (across single bets **and** parlays); never update
  a balance outside `applyBalanceChange`.
- Team names from different sources differ ("USA"/"United States",
  "Türkiye"/"Turkey") — always compare via `normTeam`/`teamPairKey`
  (`teams.ts`), and add new aliases there.

## Environment (`.env`, git-ignored)

`ODDS_API_KEY` (The Odds API: bookmaker-median 1X2 + preferred score source,
optional), `ODDS_API_SPORT_KEY`, `ODDS_API_REGIONS`, `ODDS_API_IO_KEY`
(odds-api.io: **the source of all non-1X2 markets and all in-play odds** — real
per-market Bet365 quotes; a **different service** than The Odds API, never put
its key in `ODDS_API_KEY`; **accepts a comma-separated list of keys** rotated
round-robin with 429 failover, so multiple free accounts' 100 req/h quotas add
up), `OPENAI_API_KEY` (AI tips, optional), `OPENAI_MODEL` (default
`gpt-5-mini`), `INPLAY_BETTING` (`off` disables in-play; default on),
`LIVE_ODDS_REFRESH_MS` (in-play odds poll cadence; default 45 s).
**Markets are never modelled** — without `ODDS_API_IO_KEY` only 1X2 is offered
(from ESPN/DraftKings or The Odds API) and there is no in-play betting; the
Poisson model survives solely for expert-tip generation. Scores, settlement and
live state still work keyless via ESPN.
