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
  await touchOpenClawPresence({ req, session, deviceId });

  const response = NextResponse.json({ ok: true });
  response.cookies.set(OPENCLAW_DEVICE_COOKIE, deviceId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
