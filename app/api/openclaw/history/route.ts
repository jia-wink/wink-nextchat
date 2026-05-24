import { NextRequest, NextResponse } from "next/server";
import {
  buildPluginHeaders,
  buildPluginUrl,
  errorJson,
  readRouteJson,
  requireOpenClawAgent,
  resolveAccountId,
  resolveAuthToken,
  resolveGatewayUrl,
  resolveSharedSecret,
} from "../shared";

type RequestBody = {
  sessionId?: string;
  clientSessionId?: string;
  sessionKey?: string;
  accountId?: string;
  agentId?: string;
  defaultAgentId?: string;
  gatewayUrl?: string;
  authToken?: string;
  sharedSecret?: string;
  limit?: number;
};

export async function POST(req: NextRequest) {
  const body = await readRouteJson<RequestBody>(req);
  const sessionKey = body.sessionKey?.trim();

  if (!sessionKey && !body.sessionId?.trim() && !body.clientSessionId?.trim()) {
    return errorJson("sessionKey or sessionId is required");
  }

  const gatewayUrl = resolveGatewayUrl(body.gatewayUrl);
  const authToken = resolveAuthToken(body.authToken);
  const sharedSecret = resolveSharedSecret(body.sharedSecret);
  const auth = requireOpenClawAgent(req, body.agentId || body.defaultAgentId);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const agentId = auth.agentId;
  const accountId = resolveAccountId(body.accountId, agentId);
  const upstream = await fetch(
    buildPluginUrl(gatewayUrl, "history", {
      sessionId: body.sessionId?.trim() || body.clientSessionId?.trim() || undefined,
      sessionKey,
      accountId,
    }),
    {
      method: "POST",
      headers: buildPluginHeaders({
        authToken,
        sharedSecret,
        agentId,
        accountId,
      }),
    },
  );

  const payload = await upstream.json().catch(() => ({
    sessionKey,
    items: [],
    messages: [],
  }));

  return NextResponse.json(payload, { status: upstream.status });
}
