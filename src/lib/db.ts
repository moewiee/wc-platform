import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { SEED_MATCHES, SEED_VERSION } from "./seed";
import { teamPairKey } from "./teams";

const DATA_DIR = path.join(process.cwd(), "data");

export function nowIso(): string {
  return new Date().toISOString();
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      balance_points INTEGER NOT NULL DEFAULT 0,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_id TEXT UNIQUE,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      kickoff TEXT NOT NULL,
      group_name TEXT,
      venue TEXT,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','finished','void')),
      home_score INTEGER,
      away_score INTEGER,
      corners_home INTEGER,
      corners_away INTEGER,
      cards_total INTEGER,
      result TEXT CHECK (result IN ('home','draw','away')),
      odds_home INTEGER,
      odds_draw INTEGER,
      odds_away INTEGER,
      odds_updated_at TEXT,
      odds_source TEXT NOT NULL DEFAULT 'seed'
    );
    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      match_id INTEGER NOT NULL REFERENCES matches(id),
      market TEXT NOT NULL,
      line REAL,
      selection TEXT NOT NULL,
      label TEXT NOT NULL,
      stake_points INTEGER NOT NULL CHECK (stake_points > 0),
      odds INTEGER NOT NULL CHECK (odds > 1000),
      potential_payout_points INTEGER NOT NULL,
      payout_points INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','won','lost','void','cancelled')),
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      amount_points INTEGER NOT NULL,
      balance_after_points INTEGER NOT NULL,
      type TEXT NOT NULL,
      bet_id INTEGER,
      note TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tips (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      expert TEXT NOT NULL,
      avatar TEXT NOT NULL,
      market TEXT NOT NULL,
      line REAL,
      selection TEXT NOT NULL,
      label TEXT NOT NULL,
      confidence INTEGER NOT NULL,
      rationale TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS market_odds (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      market TEXT NOT NULL,
      line REAL,
      selection TEXT NOT NULL,
      odds INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      in_play INTEGER NOT NULL DEFAULT 0
    );
    -- Last-observed in-play state per match: drives live pricing and the
    -- goal-change suspension cool-off. Written from the live-feed sync, read
    -- (synchronously) inside placeBet so the priced snapshot matches the bet.
    CREATE TABLE IF NOT EXISTS live_state (
      match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
      home_score INTEGER NOT NULL,
      away_score INTEGER NOT NULL,
      minute INTEGER,
      state TEXT,
      detail TEXT,
      observed_at TEXT NOT NULL,
      minute_seen_at TEXT NOT NULL,
      last_change_at TEXT,
      suspend_until TEXT,
      corners_home INTEGER,
      corners_away INTEGER,
      period INTEGER,
      reg_home_score INTEGER,
      reg_away_score INTEGER
    );
    -- Cross-match accumulators (parlays). A parent row holds the combined stake
    -- and the locked combined odds (product of the legs' real quotes); the legs
    -- carry one real selection each. Same-game combos are blocked (correlation
    -- can't be priced from single-market quotes), enforced by the unique index
    -- on (parlay_id, match_id) plus a check in placeParlay.
    CREATE TABLE IF NOT EXISTS parlays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      stake_points INTEGER NOT NULL CHECK (stake_points > 0),
      combined_odds INTEGER NOT NULL CHECK (combined_odds > 1000),
      potential_payout_points INTEGER NOT NULL,
      payout_points INTEGER,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','won','lost','void','cancelled')),
      created_at TEXT NOT NULL,
      settled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS parlay_legs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parlay_id INTEGER NOT NULL REFERENCES parlays(id),
      leg_seq INTEGER NOT NULL,
      match_id INTEGER NOT NULL REFERENCES matches(id),
      market TEXT NOT NULL,
      line REAL,
      selection TEXT NOT NULL,
      label TEXT NOT NULL,
      odds INTEGER NOT NULL CHECK (odds > 1000),
      leg_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (leg_status IN ('pending','win','lose','push','half_win','half_lose')),
      settled_at TEXT
    );
    -- Per-(user, ip, user-agent) request fingerprint. One row per distinct
    -- device/network a session is used from (deduped on insert) — captures the
    -- real client IP from Cloudflare's cf-connecting-ip header for abuse triage.
    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      ip TEXT,
      user_agent TEXT,
      path TEXT,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_request_log_uniq
      ON request_log(user_id, ip, user_agent);
    CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id);
    CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id);
    CREATE INDEX IF NOT EXISTS idx_txns_user ON transactions(user_id);
    CREATE INDEX IF NOT EXISTS idx_matches_kickoff ON matches(kickoff);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tips_match ON tips(match_id);
    CREATE INDEX IF NOT EXISTS idx_market_odds_match ON market_odds(match_id);
    CREATE INDEX IF NOT EXISTS idx_parlays_user ON parlays(user_id);
    CREATE INDEX IF NOT EXISTS idx_parlay_legs_parlay ON parlay_legs(parlay_id);
    CREATE INDEX IF NOT EXISTS idx_parlay_legs_match ON parlay_legs(match_id, leg_status);
    -- One leg per match: the load-bearing correlation block at the DB level.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_parlay_legs_unique_match ON parlay_legs(parlay_id, match_id);
  `);
  // Added after launch: odds-api.io event id for the per-market odds sync.
  const matchCols = db.prepare("PRAGMA table_info(matches)").all() as { name: string }[];
  if (!matchCols.some((c) => c.name === "oio_event_id")) {
    db.exec("ALTER TABLE matches ADD COLUMN oio_event_id TEXT");
  }
  // Added after launch: tipster bot accounts that bet their own tips.
  const userCols = db.prepare("PRAGMA table_info(users)").all() as { name: string }[];
  if (!userCols.some((c) => c.name === "is_bot")) {
    db.exec("ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0");
  }
  const tipCols = db.prepare("PRAGMA table_info(tips)").all() as { name: string }[];
  if (!tipCols.some((c) => c.name === "bet_id")) {
    db.exec("ALTER TABLE tips ADD COLUMN bet_id INTEGER");
  }
  // Added after launch: marks bets struck after kickoff (in-play). Display and
  // audit only — settlement and payout logic never branch on it.
  const betCols = db.prepare("PRAGMA table_info(bets)").all() as { name: string }[];
  if (!betCols.some((c) => c.name === "in_play")) {
    db.exec("ALTER TABLE bets ADD COLUMN in_play INTEGER NOT NULL DEFAULT 0");
  }
  // Added after launch: the live score at the moment an in-play bet was struck.
  // In-play Asian Handicap settles on goals scored AFTER placement (the Bet365
  // live line is quoted relative to the current score), so settlement subtracts
  // this baseline. NULL for pre-match bets (baseline 0-0).
  if (!betCols.some((c) => c.name === "live_home_score")) {
    db.exec("ALTER TABLE bets ADD COLUMN live_home_score INTEGER");
    db.exec("ALTER TABLE bets ADD COLUMN live_away_score INTEGER");
  }
  // Added after launch: the live match period at placement (ESPN status.period —
  // 1-2 regulation, 3-4 extra time, 5 penalties; NULL for pre-match). Knockout
  // bets struck during extra time (>= 3) settle on the END-OF-ET goal score,
  // while regulation/pre-match bets settle on the 90' result — so settlement
  // branches on this. NULL = regulation/pre-match basis.
  if (!betCols.some((c) => c.name === "live_period")) {
    db.exec("ALTER TABLE bets ADD COLUMN live_period INTEGER");
  }
  // Added after launch: separates live (in_play=1) from pre-match (0) quotes so
  // the in-play sheet can never read a stale pre-match price.
  const moCols = db.prepare("PRAGMA table_info(market_odds)").all() as { name: string }[];
  if (!moCols.some((c) => c.name === "in_play")) {
    db.exec("ALTER TABLE market_odds ADD COLUMN in_play INTEGER NOT NULL DEFAULT 0");
  }
  // Added after launch: ties a ledger row to the parlay (vs single bet) it came from.
  const txnCols = db.prepare("PRAGMA table_info(transactions)").all() as { name: string }[];
  if (!txnCols.some((c) => c.name === "parlay_id")) {
    db.exec("ALTER TABLE transactions ADD COLUMN parlay_id INTEGER");
  }
  // Added after launch: live corner counts, for early-resolving corner O/U.
  const lsCols = db.prepare("PRAGMA table_info(live_state)").all() as { name: string }[];
  if (lsCols.length > 0 && !lsCols.some((c) => c.name === "corners_home")) {
    db.exec("ALTER TABLE live_state ADD COLUMN corners_home INTEGER");
    db.exec("ALTER TABLE live_state ADD COLUMN corners_away INTEGER");
  }
  // Added after launch: track the live period and freeze the regulation (90')
  // score, so a knockout that goes to extra time settles on its full-time
  // result (ET/penalties never count).
  if (lsCols.length > 0 && !lsCols.some((c) => c.name === "period")) {
    db.exec("ALTER TABLE live_state ADD COLUMN period INTEGER");
    db.exec("ALTER TABLE live_state ADD COLUMN reg_home_score INTEGER");
    db.exec("ALTER TABLE live_state ADD COLUMN reg_away_score INTEGER");
  }
}

// Insert seeded fixtures that aren't in the DB yet; refresh odds/details on
// rows that still carry seed odds. Runs as a single IMMEDIATE transaction —
// the version check and the existing-rows snapshot happen inside it, so
// concurrent process initialization (e.g. next build workers) cannot
// double-insert the fixtures.
function applySeed(db: Database.Database) {
  const tx = db.transaction(() => {
    const current = db
      .prepare("SELECT value FROM meta WHERE key = 'seed_version'")
      .get() as { value: string } | undefined;
    if (current?.value === SEED_VERSION) return;

    const existing = db
      .prepare("SELECT id, home_team, away_team FROM matches")
      .all() as { id: number; home_team: string; away_team: string }[];
    const byPair = new Map(
      existing.map((m) => [teamPairKey(m.home_team, m.away_team), m.id])
    );

    const insert = db.prepare(`
      INSERT INTO matches (home_team, away_team, kickoff, group_name, venue,
        odds_home, odds_draw, odds_away, odds_updated_at, odds_source)
      VALUES (@home, @away, @kickoff, @group, @venue, @oh, @od, @oa, @now, 'seed')
    `);
    const refresh = db.prepare(`
      UPDATE matches SET kickoff = @kickoff, group_name = @group, venue = @venue,
        odds_home = @oh, odds_draw = @od, odds_away = @oa, odds_updated_at = @now
      WHERE id = @id AND odds_source = 'seed' AND status = 'scheduled'
    `);

    const now = nowIso();
    for (const s of SEED_MATCHES) {
      const params = {
        home: s.home,
        away: s.away,
        kickoff: s.kickoff,
        group: s.group,
        venue: s.venue,
        oh: s.oddsHome,
        od: s.oddsDraw,
        oa: s.oddsAway,
        now,
      };
      const id = byPair.get(teamPairKey(s.home, s.away));
      if (id === undefined) insert.run(params);
      else refresh.run({ ...params, id });
    }
    db.prepare(
      "INSERT INTO meta (key, value) VALUES ('seed_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(SEED_VERSION);
  });
  tx.immediate();
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function createDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(path.join(DATA_DIR, "worldcup.db"));
  // Multiple processes (e.g. next build workers) may open the DB at once;
  // wait for locks instead of throwing SQLITE_BUSY.
  db.pragma("busy_timeout = 10000");
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Schema creation and seeding race across processes on a brand-new file;
  // some WAL lock paths fail busy without consulting the busy handler, so
  // retry with backoff until the winning process finishes initializing.
  let lastErr: unknown;
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      migrate(db);
      applySeed(db);
      return db;
    } catch (e) {
      const code = (e as { code?: string }).code ?? "";
      if (!/^SQLITE_BUSY/.test(code)) throw e;
      lastErr = e;
      sleepSync(250 + Math.floor(Math.random() * 250));
    }
  }
  throw lastErr;
}

// Single connection per process; survives Next.js dev-mode hot reloads.
declare global {
  // eslint-disable-next-line no-var
  var __wcdb: Database.Database | undefined;
}

export const db: Database.Database = global.__wcdb ?? (global.__wcdb = createDb());

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
