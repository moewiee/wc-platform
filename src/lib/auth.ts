import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { db, nowIso } from "./db";
import { STARTING_BALANCE_POINTS } from "./money";
import type { User } from "./types";

const SESSION_COOKIE = "wc_session";
const SESSION_DAYS = 30;

const USER_COLUMNS = "id, username, balance_points, is_admin, created_at";

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
      const isFirst =
        (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number })
          .n === 0;
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

export async function getCurrentUser(): Promise<User | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserByToken(token);
}

// REST API auth: Authorization: Bearer <token> or the session cookie.
export function getUserFromRequest(req: Request): User | null {
  const authHeader = req.headers.get("authorization");
  if (authHeader?.toLowerCase().startsWith("bearer ")) {
    return getUserByToken(authHeader.slice(7).trim());
  }
  const cookieHeader = req.headers.get("cookie") ?? "";
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (m) return getUserByToken(decodeURIComponent(m[1]));
  return null;
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
