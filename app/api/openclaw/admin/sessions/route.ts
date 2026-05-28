import { NextRequest, NextResponse } from "next/server";
import { readOpenClawAuthSession } from "../../shared";
import {
  getOpenClawAdminSessions,
  OPENCLAW_ADMIN_USERNAME,
} from "../../presence-store";

export async function GET(req: NextRequest) {
  const session = readOpenClawAuthSession(req);
  if (!session) {
    return NextResponse.json(
      { error: true, message: "OpenClaw login is required" },
      { status: 401 },
    );
  }

  if (session.username !== OPENCLAW_ADMIN_USERNAME) {
    return NextResponse.json(
      { error: true, message: "OpenClaw admin is required" },
      { status: 403 },
    );
  }

  return NextResponse.json(await getOpenClawAdminSessions());
}
