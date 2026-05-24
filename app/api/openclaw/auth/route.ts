import { NextRequest, NextResponse } from "next/server";
import {
  OPENCLAW_AUTH_COOKIE,
  authenticateOpenClawUser,
  createOpenClawAuthCookie,
  readOpenClawAuthSession,
  readRouteJson,
} from "../shared";

export async function GET(req: NextRequest) {
  const session = readOpenClawAuthSession(req);
  return NextResponse.json({
    authenticated: Boolean(session),
    username: session?.username,
    agents: session?.agents ?? [],
  });
}

export async function POST(req: NextRequest) {
  const body = await readRouteJson<{ username?: string; password?: string }>(req);
  const session = authenticateOpenClawUser(
    body.username?.trim() ?? "",
    body.password ?? "",
  );

  if (!session) {
    return NextResponse.json(
      { authenticated: false, message: "Invalid OpenClaw username or password" },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    authenticated: true,
    username: session.username,
    agents: session.agents,
  });
  response.cookies.set(OPENCLAW_AUTH_COOKIE, createOpenClawAuthCookie(session), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ authenticated: false });
  response.cookies.set(OPENCLAW_AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
