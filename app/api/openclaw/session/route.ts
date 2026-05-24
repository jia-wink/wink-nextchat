import { NextRequest, NextResponse } from "next/server";
import {
  buildPluginHeaders,
  buildPluginUrl,
  readRouteJson,
  requireOpenClawAgent,
  resolveAccountId,
  resolveAuthToken,
  resolveGatewayUrl,
  resolveSharedSecret,
} from "../shared";

export async function POST(req: NextRequest) {
  const body = await readRouteJson<{
    clientSessionId?: string;
    sessionId?: string;
    accountId?: string;
    agentId?: string;
    defaultAgentId?: string;
    title?: string;
    model?: string;
    clientLabel?: string;
    gatewayUrl?: string;
    authToken?: string;
    sharedSecret?: string;
  }>(req);
  const gatewayUrl = resolveGatewayUrl(body.gatewayUrl);
  const authToken = resolveAuthToken(body.authToken);
  const sharedSecret = resolveSharedSecret(body.sharedSecret);
  const auth = requireOpenClawAgent(req, body.agentId || body.defaultAgentId);
  if (auth instanceof NextResponse) {
    return auth;
  }
  const agentId = auth.agentId;
  const accountId = resolveAccountId(body.accountId, agentId);
  const upstream = await fetch(buildPluginUrl(gatewayUrl, "session"), {
    method: "POST",
    headers: buildPluginHeaders({
      authToken,
      sharedSecret,
      agentId,
      accountId,
    }),
    body: JSON.stringify({
      ...body,
      agentId,
      accountId,
      defaultAgentId: agentId,
      clientLabel: body.clientLabel?.trim() || undefined,
    }),
  });
  const payload = await upstream.json().catch(() => ({
    error: true,
    message: "Failed to create NextChat session.",
  }));
  return NextResponse.json(payload, { status: upstream.status });
}
