import { NextRequest, NextResponse } from "next/server";
import {
  buildPluginHeaders,
  buildPluginUrl,
  isAgentAllowed,
  loadOpenClawCatalog,
  readRouteJson,
  readOpenClawAuthSession,
  resolveAccountId,
  resolveAuthToken,
  resolveSharedSecret,
  resolveDefaultAgentId,
  resolveGatewayUrl,
} from "../shared";

export async function POST(req: NextRequest) {
  const body = await readRouteJson<{
    defaultAgentId?: string;
    accountId?: string;
    gatewayUrl?: string;
    authToken?: string;
    sharedSecret?: string;
  }>(req);
  const gatewayUrl = resolveGatewayUrl(body.gatewayUrl);
  const authToken = resolveAuthToken(body.authToken);
  const sharedSecret = resolveSharedSecret(body.sharedSecret);
  const session = readOpenClawAuthSession(req);
  if (!session) {
    return NextResponse.json(
      { error: true, message: "OpenClaw login is required" },
      { status: 401 },
    );
  }
  const requestedAgentId =
    body.defaultAgentId || (session.agents.includes("*") ? undefined : session.agents[0]);
  const accountId = resolveAccountId(body.accountId, requestedAgentId);
  const upstream = await fetch(buildPluginUrl(gatewayUrl, "agents", { accountId }), {
    method: "POST",
    headers: buildPluginHeaders({
      authToken,
      sharedSecret,
      agentId: requestedAgentId,
      accountId,
    }),
  });
  const payload = upstream.ok
    ? await upstream.json()
    : await loadOpenClawCatalog(resolveDefaultAgentId(body.defaultAgentId));
  return NextResponse.json(filterCatalogByAuth(payload, session));
}

export async function GET(req: NextRequest) {
  const gatewayUrl = resolveGatewayUrl(req.nextUrl.searchParams.get("gatewayUrl") ?? undefined);
  const authToken = resolveAuthToken(req.nextUrl.searchParams.get("authToken") ?? undefined);
  const sharedSecret = resolveSharedSecret(
    req.nextUrl.searchParams.get("sharedSecret") ?? undefined,
  );
  const session = readOpenClawAuthSession(req);
  if (!session) {
    return NextResponse.json(
      { error: true, message: "OpenClaw login is required" },
      { status: 401 },
    );
  }
  const agentId =
    req.nextUrl.searchParams.get("agentId") ??
    (session.agents.includes("*") ? undefined : session.agents[0]);
  const accountId = resolveAccountId(
    req.nextUrl.searchParams.get("accountId") ?? undefined,
    agentId ?? undefined,
  );
  const upstream = await fetch(buildPluginUrl(gatewayUrl, "agents", { accountId }), {
    headers: buildPluginHeaders({
      authToken,
      sharedSecret,
      agentId,
      accountId,
    }),
  }).catch(() => null);
  const payload =
    upstream && upstream.ok ? await upstream.json() : await loadOpenClawCatalog();
  return NextResponse.json(filterCatalogByAuth(payload, session));
}

function filterCatalogByAuth(payload: any, session: { agents: string[] }) {
  if (session.agents.includes("*")) {
    return payload;
  }

  const allowedAgents = new Set(session.agents);
  const agents = (payload?.agents ?? []).filter((agent: any) => {
    const agentId = typeof agent === "string" ? agent : agent?.id;
    return agentId && allowedAgents.has(agentId);
  });
  return {
    ...payload,
    defaultAgentId: agents[0]?.id ?? session.agents[0],
    agents,
    models: payload?.models ?? [],
    accounts: session.agents.map((agentId) => ({ id: agentId, enabled: true })),
  };
}
