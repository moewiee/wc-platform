import { NextResponse } from "next/server";
import { apiError, userPayload } from "@/lib/api";
import { createUser, issueSession } from "@/lib/auth";

export async function POST(req: Request) {
  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return apiError(400, "Invalid JSON body.");
  }
  const res = createUser(String(body.username ?? "").trim(), String(body.password ?? ""));
  if (!res.user) return apiError(400, res.error ?? "Could not create the account.");
  const { token, expires } = issueSession(res.user.id);
  return NextResponse.json(
    { token, expires: expires.toISOString(), user: userPayload(res.user) },
    { status: 201 }
  );
}
