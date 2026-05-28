import { NextRequest, NextResponse } from "next/server";
import {
  OPENCLAW_AUTH_COOKIE,
  OPENCLAW_DEVICE_COOKIE,
  authenticateOpenClawUser,
  createOpenClawAuthCookie,
  readOpenClawDeviceId,
  readOpenClawAuthSession,
  readRouteJson,
} from "../shared";
import {
  createOpenClawDeviceId,
  type OpenClawDeviceMetadata,
  logoutOpenClawPresence,
  touchOpenClawPresence,
} from "../presence-store";

export async function GET(req: NextRequest) {
  const session = readOpenClawAuthSession(req);
  return NextResponse.json({
    authenticated: Boolean(session),
    username: session?.username,
    agents: session?.agents ?? [],
  });
}

export async function POST(req: NextRequest) {
  const body = await readRouteJson<{
    username?: string;
    password?: string;
    device?: OpenClawDeviceMetadata;
  }>(req);
  const session = authenticateOpenClawUser(
    body.username?.trim() ?? "",
    body.password ?? "",
  );

  if (!session) {
    return NextResponse.json(
      {
        authenticated: false,
        message: "Invalid OpenClaw username or password",
      },
      { status: 401 },
    );
  }

  const response = NextResponse.json({
    authenticated: true,
    username: session.username,
    agents: session.agents,
  });
  const deviceId = readOpenClawDeviceId(req) ?? createOpenClawDeviceId();
  await touchOpenClawPresence({
    req,
    session,
    deviceId,
    device: body.device,
  }).catch((error) => {
    console.warn("[OpenClaw Presence] failed to record login", error);
  });
  response.cookies.set(
    OPENCLAW_AUTH_COOKIE,
    createOpenClawAuthCookie(session),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    },
  );
  response.cookies.set(OPENCLAW_DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}

export async function DELETE(req: NextRequest) {
  await logoutOpenClawPresence(readOpenClawDeviceId(req)).catch((error) => {
    console.warn("[OpenClaw Presence] failed to record logout", error);
  });
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
