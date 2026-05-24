import { NextRequest } from "next/server";
import {
  buildPluginHeaders,
  buildPluginUrl,
  requireOpenClawAgent,
  resolveAccountId,
  resolveAuthToken,
  resolveGatewayUrl,
  resolveSharedSecret,
  withProxyHeaders,
} from "../shared";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim() || undefined;
  const sessionKey = req.nextUrl.searchParams.get("sessionKey")?.trim() || undefined;
  const agentId = req.nextUrl.searchParams.get("agentId")?.trim() ||
    req.nextUrl.searchParams.get("accountId")?.trim() ||
    undefined;
  const gatewayUrl = resolveGatewayUrl(
    req.nextUrl.searchParams.get("gatewayUrl")?.trim() || undefined,
  );
  const authToken = resolveAuthToken(
    req.nextUrl.searchParams.get("authToken")?.trim() || undefined,
  );
  const sharedSecret = resolveSharedSecret(
    req.nextUrl.searchParams.get("sharedSecret")?.trim() || undefined,
  );
  const auth = requireOpenClawAgent(req, agentId);
  if (auth instanceof Response) {
    return auth;
  }
  const resolvedAgentId = auth.agentId;
  const accountId = resolveAccountId(
    req.nextUrl.searchParams.get("accountId")?.trim() || undefined,
    resolvedAgentId,
  );
  const upstream = await fetch(buildPluginUrl(gatewayUrl, "events", { sessionId, sessionKey, accountId }), {
    headers: {
      Accept: "text/event-stream",
      ...buildPluginHeaders({
        authToken,
        sharedSecret,
        agentId: resolvedAgentId,
        accountId,
      }),
    },
  });

  return withProxyHeaders(upstream);
}
