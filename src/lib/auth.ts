import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, nowIso } from "./db";
import { STARTING_BALANCE_POINTS } from "./money";
import type { User } from "./types";

const SESSION_COOKIE = "wc_session";
const SESSION_DAYS = 30;

const USER_COLUMNS = "id, username, balance_points, is_admin, is_bot, created_at";

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function getUserById(id: number): User | null {
  const row = db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .get(id) as User | undefined;
  return row ?? null;
}

export function validateUsername(username: string): string | null {
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return "Username must be 3-20 characters: letters, numbers, underscore.";
  }
  return null;
}

export function createUser(
  username: string,
  password: string
): { user?: User; error?: string } {
  const usernameError = validateUsername(username);
  if (usernameError) return { error: usernameError };
  if (password.length < 6) {
    return { error: "Password must be at least 6 characters." };
  }
  const hash = bcrypt.hashSync(password, 10);
  try {
    const user = db.transaction(() => {
      // First *human* gets admin — tipster bot accounts don't count.
      const isFirst =
        (db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_bot = 0").get() as {
          n: number;
        }).n === 0;
      const info = db
        .prepare(
          "INSERT INTO users (username, password_hash, balance_points, is_admin, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(username, hash, STARTING_BALANCE_POINTS, isFirst ? 1 : 0, nowIso());
      const id = Number(info.lastInsertRowid);
      db.prepare(
        "INSERT INTO transactions (user_id, amount_points, balance_after_points, type, note, created_at) VALUES (?, ?, ?, 'signup_bonus', 'Welcome bonus', ?)"
      ).run(id, STARTING_BALANCE_POINTS, STARTING_BALANCE_POINTS, nowIso());
      return getUserById(id)!;
    })();
    return { user };
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint/i.test(e.message)) {
      return { error: "That username is already taken." };
    }
    throw e;
  }
}

export function verifyLogin(username: string, password: string): User | null {
  const row = db
    .prepare(
      `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE username = ?`
    )
    .get(username) as (User & { password_hash: string }) | undefined;
  if (!row) return null;
  if (!bcrypt.compareSync(password, row.password_hash)) return null;
  const { password_hash: _ph, ...user } = row;
  return user;
}

export function changePassword(
  userId: number,
  currentPassword: string,
  newPassword: string
): { error?: string } {
  if (newPassword.length < 6) {
    return { error: "New password must be at least 6 characters." };
  }
  const row = db
    .prepare("SELECT password_hash FROM users WHERE id = ?")
    .get(userId) as { password_hash: string } | undefined;
  if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
    return { error: "Current password is incorrect." };
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
    bcrypt.hashSync(newPassword, 10),
    userId
  );
  return {};
}

// Create a session row; the raw token doubles as the REST API bearer token.
export function issueSession(userId: number): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).run(sha256(token), userId, nowIso(), expires.toISOString());
  return { token, expires };
}

export async function createSession(userId: number): Promise<void> {
  const { token, expires } = issueSession(userId);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    expires,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
  }
  store.delete(SESSION_COOKIE);
}

export function getUserByToken(token: string): User | null {
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.balance_points, u.is_admin, u.created_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(sha256(token), nowIso()) as User | undefined;
  return row ?? null;
}

// --- Request fingerprinting (abuse triage) ------------------------------
// We store no PII at registration, so the only handle on "who is this account"
// is the network it connects from. Behind the Cloudflare Tunnel the real client
// IP arrives in `cf-connecting-ip` (the app socket only ever sees 127.0.0.1).
// We dedupe on (user, ip, user-agent) so this is one row per distinct device,
// not a per-request firehose. Best-effort: never let it break auth.

type HeaderLike = { get(name: string): string | null };

function clientIpFrom(h: HeaderLike): string {
  const cf = h.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const fwd = h.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  const real = h.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

const upsertRequestLog = db.prepare(
  `INSERT INTO request_log (user_id, ip, user_agent, path, first_seen, last_seen, hits)
   VALUES (@user_id, @ip, @ua, @path, @now, @now, 1)
   ON CONFLICT(user_id, ip, user_agent)
   DO UPDATE SET last_seen = @now, hits = hits + 1,
                 path = COALESCE(excluded.path, request_log.path)`
);

function recordRequest(userId: number, h: HeaderLike, path: string | null): void {
  try {
    const now = nowIso();
    upsertRequestLog.run({
      user_id: userId,
      ip: clientIpFrom(h),
      ua: (h.get("user-agent") ?? "unknown").slice(0, 400),
      path,
      now,
    });
  } catch {
    // Logging must never interfere with authentication.
  }
}

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const user = getUserByToken(token);
  if (user) {
    try {
      const h = await headers();
      recordRequest(user.id, h, h.get("x-pathname") ?? h.get("referer"));
    } catch {
      // headers() unavailable outside a request scope — skip silently.
    }
  }
  return user;
}

// REST API auth: Authorization: Bearer <token> or the session cookie.
export function getUserFromRequest(req: Request): User | null {
  let user: User | null = null;
  const authHeader = req.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    user = getUserByToken(authHeader.slice(7).trim());
  } else {
    const cookieHeader = req.headers.get("cookie") ?? "";
    const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    if (m) user = getUserByToken(decodeURIComponent(m[1]));
  }
  if (user) {
    let path: string | null = null;
    try {
      path = new URL(req.url).pathname;
    } catch {
      /* non-absolute URL — leave path null */
    }
    recordRequest(user.id, req.headers, path);
  }
  return user;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!user.is_admin) redirect("/");
  return user;
}
