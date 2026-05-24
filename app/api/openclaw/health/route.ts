import { NextRequest, NextResponse } from "next/server";
import {
  buildPluginHeaders,
  buildPluginUrl,
  resolveAccountId,
  resolveAuthToken,
  resolveGatewayUrl,
  resolveSharedSecret,
  requireOpenClawAgent,
} from "../shared";

async function checkHealth(params: {
  gatewayUrl?: string;
  authToken?: string;
  sharedSecret?: string;
  accountId?: string;
}) {
  const gatewayUrl = resolveGatewayUrl(params.gatewayUrl);
  const authToken = resolveAuthToken(params.authToken);
  const sharedSecret = resolveSharedSecret(params.sharedSecret);
  const accountId = resolveAccountId(params.accountId);
  const startedAt = Date.now();

  try {
    const response = await fetch(
      buildPluginUrl(gatewayUrl, "health", {
        accountId,
      }),
      {
        method: "GET",
        headers: buildPluginHeaders({
          authToken,
          sharedSecret,
          accountId,
        }),
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      latencyMs: Date.now() - startedAt,
      gatewayUrl,
      accountId,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      status: 503,
      latencyMs: Date.now() - startedAt,
      gatewayUrl,
      accountId,
      payload: {
        error: true,
        message: String(error),
      },
    };
  }
}

export async function GET(req: NextRequest) {
  const auth = requireOpenClawAgent(
    req,
    req.nextUrl.searchParams.get("agentId") ??
      req.nextUrl.searchParams.get("accountId") ??
      undefined,
  );
  if (auth instanceof NextResponse) {
    return auth;
  }
  const result = await checkHealth({
    gatewayUrl: req.nextUrl.searchParams.get("gatewayUrl") ?? undefined,
    authToken: req.nextUrl.searchParams.get("authToken") ?? undefined,
    sharedSecret: req.nextUrl.searchParams.get("sharedSecret") ?? undefined,
    accountId: req.nextUrl.searchParams.get("accountId") ?? undefined,
  });
  return NextResponse.json(result, { status: result.status });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const auth = requireOpenClawAgent(
    req,
    body.agentId ?? body.accountId ?? body.defaultAgentId,
  );
  if (auth instanceof NextResponse) {
    return auth;
  }
  const result = await checkHealth(body);
  return NextResponse.json(result, { status: result.status });
}
