import { NextRequest } from "next/server";
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
  withProxyHeaders,
} from "../shared";

type RequestBody = {
  sessionId?: string;
  clientSessionId?: string;
  sessionKey?: string;
  accountId?: string;
  agentId?: string;
  defaultAgentId?: string;
  title?: string;
  clientLabel?: string;
  gatewayUrl?: string;
  authToken?: string;
  sharedSecret?: string;
  stream?: boolean;
  model?: string;
  messages?: Array<{ role?: string; content?: string }>;
  attachments?: Array<{ url?: string; mimeType?: string; name?: string }>;
};

export async function POST(req: NextRequest) {
  const body = await readRouteJson<RequestBody>(req);
  const gatewayUrl = resolveGatewayUrl(body.gatewayUrl);
  const authToken = resolveAuthToken(body.authToken);
  const sharedSecret = resolveSharedSecret(body.sharedSecret);
  const auth = requireOpenClawAgent(req, body.agentId || body.defaultAgentId);
  if (auth instanceof Response) {
    return auth;
  }
  const agentId = auth.agentId;
  const accountId = resolveAccountId(body.accountId, agentId);

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return errorJson("messages is required");
  }

  const upstream = await fetch(buildPluginUrl(gatewayUrl, "message"), {
    method: "POST",
    headers: {
      Accept: body.stream === false ? "application/json" : "text/event-stream",
      ...buildPluginHeaders({
        authToken,
        sharedSecret,
        agentId,
        accountId,
      }),
    },
    body: JSON.stringify({
      ...body,
      agentId,
      accountId,
      defaultAgentId: agentId,
    }),
    // @ts-expect-error Next.js runtime supports duplex for stream forwarding.
    duplex: "half",
  });

  return withProxyHeaders(upstream);
}
