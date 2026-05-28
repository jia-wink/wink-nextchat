import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { getServerSideConfig } from "@/app/config/server";

type RequestConfig = {
  gatewayUrl?: string;
  authToken?: string;
  accountId?: string;
  defaultAgentId?: string;
  clientSessionId?: string;
  sessionId?: string;
  sessionKey?: string;
  agentId?: string;
  title?: string;
};

type OpenClawConfigShape = {
  agents?: {
    list?: Array<{ id?: string; name?: string; model?: { primary?: string } }>;
    defaults?: {
      model?: {
        primary?: string;
      };
      models?: Record<string, { alias?: string }>;
    };
  };
  channels?: {
    nextchat?: {
      accounts?: Record<string, { enabled?: boolean }>;
    };
  };
};

type OpenClawServerConfig = ReturnType<typeof getServerSideConfig> & {
  openclawAccountId?: string;
};

export type OpenClawAgent = {
  id: string;
  name?: string;
};

export type OpenClawModel = {
  id: string;
  name?: string;
};

export type OpenClawAccount = {
  id: string;
  enabled?: boolean;
};

type OpenClawAuthUser = {
  username: string;
  password: string;
  agents: string[];
};

export type OpenClawAuthSession = {
  username: string;
  agents: string[];
};

export const OPENCLAW_AUTH_COOKIE = "nextchat-openclaw-auth";

const serverConfig = getServerSideConfig() as OpenClawServerConfig;

export function resolveGatewayUrl(input?: string): string {
  const raw =
    input?.trim() ||
    serverConfig.openclawGatewayUrl?.trim() ||
    "http://127.0.0.1:18789";
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export function resolveAuthToken(input?: string): string | undefined {
  const raw = input?.trim() || serverConfig.openclawAuthToken?.trim();
  return raw ? raw : undefined;
}

export function resolveSharedSecret(input?: string): string | undefined {
  const raw =
    input?.trim() ||
    serverConfig.openclawSharedSecret?.trim() ||
    serverConfig.openclawAuthToken?.trim();
  return raw ? raw : undefined;
}

export function resolveDefaultAgentId(input?: string): string {
  return input?.trim() || serverConfig.openclawDefaultAgentId?.trim() || "main";
}

export function resolveAgentId(input?: string): string {
  return input?.trim() || resolveDefaultAgentId();
}

export function resolveAccountId(input?: string, agentId?: string): string {
  const raw = input?.trim();
  if (raw) {
    return raw;
  }
  const resolvedAgentId = agentId?.trim();
  const configured = serverConfig.openclawAccountId?.trim();
  if (configured && (!resolvedAgentId || resolvedAgentId === "main")) {
    return configured;
  }
  return resolvedAgentId && resolvedAgentId !== "main"
    ? resolvedAgentId
    : "default";
}

export function buildSessionKey(params: {
  sessionId?: string;
  clientSessionId?: string;
  agentId: string;
}): string {
  const sessionId = (
    params.sessionId ||
    params.clientSessionId ||
    randomUUID()
  ).replace(/[^a-zA-Z0-9:_-]/g, "-");
  return `agent:${params.agentId}:nextchat:${sessionId}`;
}

export function buildGatewayHeaders(params: {
  authToken?: string;
  agentId: string;
  sessionKey?: string;
  accountId?: string;
}): HeadersInit {
  return {
    "Content-Type": "application/json",
    ...(params.authToken
      ? { Authorization: `Bearer ${params.authToken}` }
      : {}),
    "x-openclaw-agent-id": params.agentId,
    "x-nextchat-account-id": resolveAccountId(params.accountId, params.agentId),
    ...(params.sessionKey
      ? { "x-openclaw-session-key": params.sessionKey }
      : {}),
    "x-openclaw-message-channel": "nextchat",
  };
}

export function buildPluginHeaders(params: {
  authToken?: string;
  sharedSecret?: string;
  agentId?: string;
  accountId?: string;
}): HeadersInit {
  const agentId = resolveAgentId(params.agentId);
  return {
    "Content-Type": "application/json",
    ...(params.authToken
      ? { Authorization: `Bearer ${params.authToken}` }
      : {}),
    ...(params.sharedSecret
      ? { "x-nextchat-secret": params.sharedSecret }
      : {}),
    "x-nextchat-account-id": resolveAccountId(params.accountId, agentId),
  };
}

function getOpenClawAuthSecret(): string {
  return (
    serverConfig.openclawSharedSecret?.trim() ||
    serverConfig.openclawAuthToken?.trim() ||
    "nextchat-openclaw-local-auth"
  );
}

function signOpenClawAuthPayload(payload: string): string {
  return createHmac("sha256", getOpenClawAuthSecret())
    .update(payload)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function getOpenClawUsers(): OpenClawAuthUser[] {
  const raw = process.env.OPENCLAW_AUTH_USERS?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as OpenClawAuthUser[];
    const users = parsed
      .map((user) => ({
        username: user.username?.trim(),
        password: user.password,
        agents: Array.isArray(user.agents)
          ? user.agents.map((agent) => agent.trim()).filter(Boolean)
          : [],
      }))
      .filter(
        (user) => user.username && user.password && user.agents.length > 0,
      );
    return users;
  } catch {
    console.warn("[OpenClaw] invalid OPENCLAW_AUTH_USERS JSON");
    return [];
  }
}

export function authenticateOpenClawUser(
  username: string,
  password: string,
): OpenClawAuthSession | undefined {
  const user = getOpenClawUsers().find(
    (candidate) =>
      candidate.username === username.trim() && candidate.password === password,
  );
  if (!user) {
    return undefined;
  }
  return {
    username: user.username,
    agents: user.agents,
  };
}

export function createOpenClawAuthCookie(session: OpenClawAuthSession): string {
  const payload = Buffer.from(
    JSON.stringify({
      username: session.username,
      agents: session.agents,
      issuedAt: Date.now(),
    }),
  ).toString("base64url");
  return `${payload}.${signOpenClawAuthPayload(payload)}`;
}

export function readOpenClawAuthSession(
  req: NextRequest,
): OpenClawAuthSession | undefined {
  const token = req.cookies.get(OPENCLAW_AUTH_COOKIE)?.value;
  if (!token) {
    return undefined;
  }

  const [payload, signature] = token.split(".");
  if (
    !payload ||
    !signature ||
    !safeEqual(signature, signOpenClawAuthPayload(payload))
  ) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const username =
      typeof parsed.username === "string" ? parsed.username.trim() : "";
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents
          .map((agent: unknown) =>
            typeof agent === "string" ? agent.trim() : "",
          )
          .filter(Boolean)
      : [];
    if (!username || agents.length === 0) {
      return undefined;
    }
    return { username, agents };
  } catch {
    return undefined;
  }
}

export function isAgentAllowed(
  session: OpenClawAuthSession,
  agentId: string,
): boolean {
  return session.agents.includes("*") || session.agents.includes(agentId);
}

export function requireOpenClawAgent(
  req: NextRequest,
  requestedAgentId?: string,
): { session: OpenClawAuthSession; agentId: string } | NextResponse {
  const session = readOpenClawAuthSession(req);
  if (!session) {
    return errorJson("OpenClaw login is required", 401);
  }

  const agentId = resolveAgentId(
    requestedAgentId ||
      (session.agents.includes("*") ? undefined : session.agents[0]),
  );
  if (!isAgentAllowed(session, agentId)) {
    const defaultAgentId = resolveDefaultAgentId();
    if (!session.agents.includes("*") && agentId === defaultAgentId) {
      return { session, agentId: session.agents[0] };
    }
    return errorJson(`OpenClaw account cannot access agent: ${agentId}`, 403);
  }

  return { session, agentId };
}

export function buildPluginUrl(
  gatewayUrl: string,
  path: string,
  searchParams?: Record<string, string | undefined>,
): string {
  const url = new URL(
    `/api/channels/nextchat/${path.replace(/^\/+/, "")}`,
    `${gatewayUrl}/`,
  );
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (value?.trim()) {
      url.searchParams.set(key, value.trim());
    }
  }
  return url.toString();
}

export async function readRouteJson<T = RequestConfig>(
  req: NextRequest,
): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

function resolveConfigPath(): string {
  return (
    serverConfig.openclawConfigPath?.trim() ||
    path.join(os.homedir(), ".openclaw", "openclaw.json")
  );
}

export async function loadOpenClawAgents(
  fallbackDefaultAgentId?: string,
): Promise<{ defaultAgentId: string; agents: OpenClawAgent[] }> {
  const payload = await loadOpenClawCatalog(fallbackDefaultAgentId);
  return {
    defaultAgentId: payload.defaultAgentId,
    agents: payload.agents,
  };
}

export async function loadOpenClawCatalog(
  fallbackDefaultAgentId?: string,
): Promise<{
  defaultAgentId: string;
  agents: OpenClawAgent[];
  models: OpenClawModel[];
  accounts: OpenClawAccount[];
}> {
  const defaultAgentId = resolveDefaultAgentId(fallbackDefaultAgentId);
  try {
    const configPath = resolveConfigPath();
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as OpenClawConfigShape;
    const agents = (parsed.agents?.list ?? [])
      .map((agent) => ({
        id: agent.id?.trim() ?? "",
        name: agent.name?.trim() || undefined,
      }))
      .filter((agent) => agent.id);
    const modelMap = new Map<string, OpenClawModel>();
    const configuredModels = parsed.agents?.defaults?.models ?? {};
    for (const [modelId, modelConfig] of Object.entries(configuredModels)) {
      const normalizedId = modelId.trim();
      if (!normalizedId) continue;
      modelMap.set(normalizedId, {
        id: normalizedId,
        name: modelConfig?.alias?.trim() || undefined,
      });
    }
    for (const agent of parsed.agents?.list ?? []) {
      const modelId = agent.model?.primary?.trim();
      if (!modelId || modelMap.has(modelId)) continue;
      modelMap.set(modelId, { id: modelId });
    }
    const defaultPrimaryModel = parsed.agents?.defaults?.model?.primary?.trim();
    if (defaultPrimaryModel && !modelMap.has(defaultPrimaryModel)) {
      modelMap.set(defaultPrimaryModel, { id: defaultPrimaryModel });
    }
    if (!agents.some((agent) => agent.id === defaultAgentId)) {
      agents.unshift({ id: defaultAgentId, name: defaultAgentId });
    }
    const accounts = Object.entries(
      parsed.channels?.nextchat?.accounts ?? {},
    ).map(([accountId, accountConfig]) => ({
      id: accountId,
      enabled: accountConfig?.enabled,
    }));
    return {
      defaultAgentId,
      agents,
      models: [...modelMap.values()],
      accounts:
        accounts.length > 0 ? accounts : [{ id: "default", enabled: true }],
    };
  } catch {
    return {
      defaultAgentId,
      agents: [{ id: defaultAgentId, name: defaultAgentId }],
      models: [],
      accounts: [{ id: "default", enabled: true }],
    };
  }
}

export function withProxyHeaders(upstream: Response): Response {
  const headers = new Headers(upstream.headers);
  headers.delete("content-encoding");
  headers.set("X-Accel-Buffering", "no");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export function errorJson(message: string, status = 400): NextResponse {
  return NextResponse.json(
    {
      error: true,
      message,
    },
    { status },
  );
}
