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
| `markets.ts` | All non-1X2 markets are **derived on the fly** from the stored 1X2 odds via a Poisson model (memoized fit) — never stored. `marketsForMatch()` quotes, `findSelection()` prices one selection, `settleSelection()` returns win/lose/push/half_win/half_lose/**pending** (pending = corners/cards data missing). |
| `bets.ts` | `placeBet` (re-prices server-side — never trust client odds), `cancelBet` (before kickoff only), `settleMatch` (score required; corners/cards optional — bets needing them stay pending), `completeMatchData`, `voidMatch`. Every balance change goes through `applyBalanceChange` inside a `db.transaction` and writes a ledger row. |
| `matches.ts` | Odds + score sync. Odds refresh throttled to 30 min, scores to 10 min (throttle stamps in `meta` table). Scores come from The Odds API when `ODDS_API_KEY` is set, otherwise from ESPN (keyless) — either way finished matches auto-settle. Upsert matches by `api_id`, falling back to normalized team-pair — only against `scheduled` rows; voided rows release their `api_id` so rescheduled fixtures reappear. |
| `odds-api.ts` | The Odds API v4 client. Sport key `soccer_fifa_world_cup`; soccer h2h outcomes are named home_team / away_team / `"Draw"`; scores come back as **numeric strings**. Free tier 500 credits/mo — keep calls throttled. |
| `espn.ts` | Keyless fallback score source: ESPN public scoreboard JSON (`site.api.espn.com/.../soccer/fifa.world/scoreboard?dates=YYYYMMDD-YYYYMMDD`). Final scores only (no odds/corners/cards). ESPN team names match the seeds via `normTeam` — verified for all 72 group fixtures. |
| `sync-loop.ts` + `instrumentation.ts` | Background sync: `register()` starts a 5-min `setInterval` (plus one immediate tick at boot) calling `maybeRefreshOdds`/`maybeSyncScores`, so settlement doesn't depend on page traffic. Guarded by a `global` so dev HMR doesn't stack timers. |
| `auth.ts` | bcrypt + session token (sha256-hashed in DB). The same raw token is the cookie value **and** the REST API bearer token. First registered user gets `is_admin=1`. |
| `tips.ts` | Expert tips: instant statistical personas (`ensureModelTips`, runs on match-page render) + OpenAI news-reading agents (`generateAiTipsForUpcoming`, admin-triggered; Responses API with `web_search` tool, falls back to no-tools, then skips). |
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
- Bets lock the odds at placement; later odds moves never change an open bet.
- Settlement is one-way: a `finished`/`void` match can't be re-settled
  (`settleMatch`/`voidMatch` guard on `status = 'scheduled'`).
- Ledger consistency: `users.balance_points` must always equal
  20,000 − Σstakes + Σpayouts; never update a balance outside
  `applyBalanceChange`.
- Team names from different sources differ ("USA"/"United States",
  "Türkiye"/"Turkey") — always compare via `normTeam`/`teamPairKey`
  (`teams.ts`), and add new aliases there.

## Environment (`.env.local`)

`ODDS_API_KEY` (live odds; preferred score source, optional), `ODDS_API_SPORT_KEY`,
`ODDS_API_REGIONS`, `OPENAI_API_KEY` (AI tips, optional), `OPENAI_MODEL`
(default `gpt-5-mini`). Everything degrades gracefully when keys are absent:
seeded odds, ESPN-based auto-settlement, model-only tips.
