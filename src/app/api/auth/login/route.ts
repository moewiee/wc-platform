import { NextResponse } from "next/server";
import { apiError, userPayload } from "@/lib/api";
import { issueSession, verifyLogin } from "@/lib/auth";

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body.");
  }
  const user = verifyLogin(String(body.username ?? "").trim(), String(body.password ?? ""));
  if (!user) return apiError(401, "Invalid username or password.");
  const { token, expires } = issueSession(user.id);
  return NextResponse.json({
    token,
    expires: expires.toISOString(),
    user: userPayload(user),
  });
}
