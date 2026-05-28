import { NextRequest, NextResponse } from "next/server";
import {
  OPENCLAW_DEVICE_COOKIE,
  readOpenClawAuthSession,
  readOpenClawDeviceId,
} from "../shared";
import {
  createOpenClawDeviceId,
  touchOpenClawPresence,
} from "../presence-store";

export async function POST(req: NextRequest) {
  const session = readOpenClawAuthSession(req);
  if (!session) {
    return NextResponse.json(
      { error: true, message: "OpenClaw login is required" },
      { status: 401 },
    );
  }

  const deviceId = readOpenClawDeviceId(req) ?? createOpenClawDeviceId();
  const recorded = await touchOpenClawPresence({
    req,
    session,
    deviceId,
  })
    .then(() => true)
    .catch((error) => {
      console.warn("[OpenClaw Presence] heartbeat failed", error);
      return false;
    });

  const response = NextResponse.json({ ok: true, recorded });
  response.cookies.set(OPENCLAW_DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
