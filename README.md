# ⚽ WC26BET

A bookmaker-style play-money betting site for the FIFA World Cup 2026 — for fun
between friends. No real money, just bragging rights.

## Quick start

```bash
npm install
npm run build
npm start                  # http://localhost:3000
# play with a friend on your LAN:
npm start -- -H 0.0.0.0    # friend opens http://<your-ip>:3000
```

- **Register first** — the first account created becomes **admin**.
- Every new account starts with **20,000 points**.
- If your friend can't connect and you run a host firewall, allow port 3000
  once: `sudo ufw allow 3000/tcp` (stock Debian has no firewall, so it
  usually just works; on a cloud VM check the provider's firewall rules).
- Development mode: `npm run dev`.

In production this site runs at **https://wc26.ankai.uk** — a systemd service
(`wc26.service`) bound to localhost, published through a Cloudflare Tunnel
(`cloudflared.service`). See CLAUDE.md → "Production deployment".

## Features

- **Accounts & points** — username/password sign-in, 20,000-point welcome
  bonus, whole-point stakes and payouts (rounded down), full transaction
  ledger.
- **Bookmaker UI** — dark odds board (Handicap / Goals O/U / 1X2 columns) with
  a click-to-bet slip, like the real Asian books.
- **Markets** (per match):
  - 1X2 full-time result
  - Asian handicap — goals (quarter lines with half-win/half-loss settlement)
    and corners
  - Over/Under — goals, corners and cards (3 lines each)
  - Correct score (0-0 … 4-4 grid + "any other" buckets)

  The 1X2 odds are the anchor (seeded house prices, or live bookmaker odds with
  an API key); everything else is derived from a Poisson goal model, so all
  markets move together when odds refresh.
- **Rates & counter** — odds refresh at most every **30 minutes**; the
  **counter closes at kickoff** — no bets or cancellations after that.
- **Expert tips** — statistical personas (The Quant, Goals Guru, …) appear
  instantly; with an OpenAI key, AI agents (**Eddie Insider**, **Anna
  Analyst**) read recent news via web search and post picks with rationale
  (Admin → "Generate AI tips").
- **Settlement** — final scores auto-settle goal markets (with The Odds API
  key) or the admin enters score + corners + cards; corner/card bets wait
  until that data exists. Postponed matches can be voided (full refunds).
- **My Bets / Leaderboard / Account** — open & settled bets with
  cancel-before-kickoff, ranking by total worth (balance + in play), ledger.
- **Admin page** — data-source status & API credits, force odds refresh /
  score sync, settle or void any match, complete missing corners/cards,
  generate AI tips.

## Data

All **72 group-stage fixtures** (June 11–27, 2026) are pre-seeded with
realistic house odds. With a free key from
[the-odds-api.com](https://the-odds-api.com) the site pulls live bookmaker 1X2
odds, discovers knockout fixtures automatically as they're scheduled, and
settles results from live scores.

## Configuration (`.env.local`)

| Variable | Purpose |
| --- | --- |
| `ODDS_API_KEY` | Free key from the-odds-api.com (500 credits/mo). Optional — without it the site runs fully offline on seeded odds with manual settlement. |
| `ODDS_API_SPORT_KEY` | Defaults to `soccer_fifa_world_cup`. |
| `ODDS_API_REGIONS` | Bookmaker regions, default `eu`. |
| `OPENAI_API_KEY` | Enables the news-reading AI tip agents. |
| `OPENAI_MODEL` | Defaults to `gpt-5-mini`. |

Restart the server after editing.

## REST API

Served at `http://localhost:3000` locally and `https://wc26.ankai.uk` in
production (same endpoints). Authenticate with `Authorization: Bearer <token>`
(or the browser session cookie). Get a token from register/login:

```bash
# register / login → token
tok=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret"}' | jq -r .token)

# check rates: all matches + every market's current odds
curl -s http://localhost:3000/api/matches | jq .

# one match incl. expert tips
curl -s http://localhost:3000/api/matches/3 | jq .

# place a bet (line is required for handicap/over-under markets)
curl -s -X POST http://localhost:3000/api/bets \
  -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
  -d '{"match_id":3,"market":"ah_goals","line":-0.75,"selection":"home","stake_points":500}' | jq .

# my bets + balance
curl -s http://localhost:3000/api/bets -H "Authorization: Bearer $tok" | jq .

# cancel an open bet before kickoff
curl -s -X DELETE http://localhost:3000/api/bets/7 -H "Authorization: Bearer $tok" | jq .
```

Markets: `h2h` (`home|draw|away`), `ah_goals`/`ah_corners` (`home|away` + line),
`ou_goals`/`ou_corners`/`ou_cards` (`over|under` + line), `correct_score`
(`"2-1"`, …, `other_home|other_draw|other_away`). Odds are decimal ×1000.
The server always prices from its own current odds — client odds are never
trusted.

## Tech

Next.js 15 (App Router, server actions) · TypeScript · Tailwind CSS 4 ·
SQLite (better-sqlite3, `data/worldcup.db`) · bcryptjs sessions.

All balance changes run inside SQLite transactions with a full ledger; odds are
integers ×1000 and points are integers, so settlement math is exact. Asian
handicap quarter lines settle as two half-stakes (half-win pays
`⌊stake·(1+odds)/2⌋`, half-loss refunds `⌊stake/2⌋`).

## Reset everything

Stop the server and delete the `data/` folder. Next start re-creates and
re-seeds the database (all 72 group-stage fixtures).
