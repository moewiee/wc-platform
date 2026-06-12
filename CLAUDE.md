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
| `markets.ts` | Non-1X2 markets are derived from the stored 1X2 odds via a Poisson model (memoized fit). When `ODDS_API_IO_KEY` is set, real Bet365 quotes from the `market_odds` table **overlay** the model in `marketsForMatch()`: line markets (AH/totals) adopt the bookmaker's lines wholesale, correct-score overlays per cell ("any other" buckets stay model-priced — different score set), quotes older than 6 h are ignored and anything unquoted falls back to the model. Settlement semantics never depend on the price source. `findSelection()` prices one selection, `settleSelection()` returns win/lose/push/half_win/half_lose/**pending** (pending = corners/cards data missing). |
| `odds-api-io.ts` | odds-api.io v3 client (per-market bookmaker odds; free tier 100 req/h, key in `ODDS_API_IO_KEY`). League slug `international-fifa-world-cup`, single bookmaker `Bet365`, `/odds/multi` batches 10 events per request. Feed market names map to our families (`Bookings Totals` → `ou_cards`, lines > 15 skipped as booking points; correct-score labels like `"2-1"` match our selection keys). Domain errors arrive as HTTP 200 `{error}` bodies. `maybeRefreshMarketOdds` (matches.ts, 10-min throttle, next-7-days window, ≤40 matches) maps matches by `teamPairKey` → `matches.oio_event_id`, then rewrites `market_odds` per match. |
| `bets.ts` | `placeBet` (re-prices server-side — never trust client odds), `cancelBet` (within `CANCEL_WINDOW_MS` = 30 min of placement, and before kickoff), `settleMatch` (score required; corners/cards optional — bets needing them stay pending), `completeMatchData`, `voidMatch`. Every balance change goes through `applyBalanceChange` inside a `db.transaction` and writes a ledger row. |
| `matches.ts` | Odds + score sync. Odds refresh throttled to 10 min on the keyless ESPN path (one GET per refresh) or 30 min when `ODDS_API_KEY` is set (free tier is 500 credits/mo); scores to 10 min (throttle stamps in `meta` table). Both odds and scores come from The Odds API when `ODDS_API_KEY` is set, otherwise from ESPN (keyless; odds are DraftKings moneylines, `api_id` prefixed `espn:`) — either way odds auto-refresh and finished matches auto-settle, then a best-effort completion pass fills corners/cards from ESPN box scores so those bets settle too. Upsert matches by `api_id`, falling back to normalized team-pair — only against `scheduled` rows; voided rows release their `api_id` so rescheduled fixtures reappear. |
| `odds-api.ts` | The Odds API v4 client. Sport key `soccer_fifa_world_cup`; soccer h2h outcomes are named home_team / away_team / `"Draw"`; scores come back as **numeric strings**. Free tier 500 credits/mo — keep calls throttled. |
| `espn.ts` | Keyless ESPN source: the public scoreboard JSON (`site.api.espn.com/.../soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD`) gives finals + corners (`wonCorners`), live in-play scores with clock, and 1X2 odds (DraftKings moneylines, American format → decimal ×1000); `fetchEspnCards` reads total cards (yellow = 1, red = 2) from the per-match `summary` box score. ESPN team names match the seeds via `normTeam` — verified for all 72 group fixtures. |
| `live.ts` | In-play scores for the lobby: maps ESPN live events (`fetchEspnLiveScores`, includes clock) to unsettled started matches, cached in-process for 60 s. Served by `/api/live`; `OddsBoard` polls it every minute and shows score + clock on LIVE rows. |
| `sync-loop.ts` + `instrumentation.ts` | Background sync: `register()` starts a 5-min `setInterval` (plus one immediate tick at boot) calling `maybeRefreshOdds`/`maybeSyncScores`, so settlement doesn't depend on page traffic. Guarded by a `global` so dev HMR doesn't stack timers. |
| `auth.ts` | bcrypt + session token (sha256-hashed in DB). The same raw token is the cookie value **and** the REST API bearer token. First registered user gets `is_admin=1`. |
| `tips.ts` | Expert tips: instant statistical personas (`ensureModelTips`, runs on match-page render) + three OpenAI news-reading agents with distinct characters (Eddie Insider/team news, Anna Analyst/form & tactics, Vic Value/price hunting; Responses API with `web_search` tool, falls back to no-tools, then skips). `maybeGenerateAiTips` runs them from the sync loop every 12 h over matches kicking off within 24 h (stamp `last_ai_tips_run`); the admin button forces the same pass. One tip per agent per match. |
| `tipster-bets.ts` | Tipsters bet their own tips: each persona has a bot user (`is_bot=1`, username **with a space** so players can't register/log into it, random password). `maybePlaceTipsterBets` (sync loop, 15-min throttle, next-24h window) ensures model tips exist, then places a bet per unbet tip via `placeBet` (stake = confidence × 100, capped by bankroll; broke tipsters go quiet) and links it through `tips.bet_id`. Unquotable selections (line moved) retry until kickoff. First-human-gets-admin counts `is_bot = 0` only (auth.ts). Leaderboard shows bots with a "tipster" badge. |
| `actions.ts` | All server actions (`"use server"`); every mutating action re-validates the session, admin actions check `is_admin`. |
| `api.ts` + `src/app/api/**` | REST API payload shapes and routes (auth, matches, bets). |

Client components (`src/components/`): `BetSlip.tsx` holds the slip context
(`useBetSlip`) and renders the docked slip; `OddsButton` cells feed it.
`OddsBoard` (home) and `MarketBoard` (match page) are presentation over
serialized market data computed in server components. Date grouping and
kickoff countdowns are mount-gated to avoid SSR/client timezone hydration
mismatches — keep that pattern.

## Rules that must hold

- Counter closes at kickoff: no bets or cancellations once
  `kickoff <= now` (checked server-side in `placeBet`/`cancelBet`; UI mirrors it).
- Cancellation window: a bet can only be cancelled within 30 minutes of
  placement (`CANCEL_WINDOW_MS` in `bets.ts`; checked server-side, UI mirrors
  it on My Bets). The web UI also asks for confirmation before placing a bet.
- Bets lock the odds at placement; later odds moves never change an open bet.
- Settlement is one-way: a `finished`/`void` match can't be re-settled
  (`settleMatch`/`voidMatch` guard on `status = 'scheduled'`).
- Ledger consistency: `users.balance_points` must always equal
  20,000 − Σstakes + Σpayouts; never update a balance outside
  `applyBalanceChange`.
- Team names from different sources differ ("USA"/"United States",
  "Türkiye"/"Turkey") — always compare via `normTeam`/`teamPairKey`
  (`teams.ts`), and add new aliases there.

## Environment (`.env`, git-ignored)

`ODDS_API_KEY` (The Odds API: bookmaker-median 1X2 + preferred score source,
optional), `ODDS_API_SPORT_KEY`, `ODDS_API_REGIONS`, `ODDS_API_IO_KEY`
(odds-api.io: real per-market Bet365 odds overlaying the Poisson model,
optional — a **different service** than The Odds API; never put its key in
`ODDS_API_KEY`), `OPENAI_API_KEY` (AI tips, optional), `OPENAI_MODEL`
(default `gpt-5-mini`). Everything degrades gracefully when keys are absent:
ESPN/DraftKings odds, ESPN-based auto-settlement and live scores, model-only
tips and market prices.
