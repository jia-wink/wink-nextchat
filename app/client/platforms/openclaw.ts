"use client";

import { useEffect, useRef, useState } from "react";
import {
  fetchEventSource,
  EventStreamContentType,
} from "@fortaine/fetch-event-source";
import { getClientConfig } from "@/app/config/client";
import {
  ApiPath,
  OpenClaw,
  REQUEST_TIMEOUT_MS,
  ServiceProvider,
} from "@/app/constant";
import {
  createMessage,
  type ChatMessage,
  type ChatSession,
  useAccessStore,
  useChatStore,
} from "@/app/store";
import { fetch as tauriFetch } from "@/app/utils/stream";
import { prettyObject } from "@/app/utils/format";
import type {
  ChatOptions,
  LLMApi,
  LLMModel,
  LLMUsage,
  RequestMessage,
  MultimodalContent,
  SpeechOptions,
} from "../api";

type OpenClawSessionBinding = {
  sessionId: string;
  sessionKey: string;
  conversationId: string;
  agentId: string;
  channel: string;
  createdAt: string;
};

type OpenClawAgentResponse = {
  defaultAgentId?: string;
  agents?: Array<string | { id: string; name?: string }>;
  models?: Array<string | { id: string; name?: string }>;
  accounts?: Array<string | { id: string; enabled?: boolean }>;
};

export type OpenClawAuthState = {
  authenticated: boolean;
  username?: string;
  agents: string[];
};

export type OpenClawPresenceDevice = {
  deviceId: string;
  username: string;
  agents: string[];
  ip: string;
  location: string;
  userAgent: string;
  deviceModel?: string;
  platform?: string;
  platformVersion?: string;
  browser?: string;
  browserVersion?: string;
  createdAt: string;
  lastSeenAt: string;
  loggedOutAt?: string;
  status: "online" | "offline";
};

export type OpenClawAdminSessionGroup = {
  username: string;
  onlineCount: number;
  totalCount: number;
  devices: OpenClawPresenceDevice[];
};

export type OpenClawAdminSessionsResponse = {
  generatedAt: string;
  onlineWindowMs: number;
  accounts: OpenClawAdminSessionGroup[];
};

type OpenClawJsonCompletion = {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
};

type OpenClawEvent = {
  type:
    | "session.created"
    | "message.accepted"
    | "message.delta"
    | "message.completed"
    | "message.failed"
    | "agent.status"
    | "typing.start"
    | "typing.stop";
  sessionId: string;
  messageId?: string;
  delta?: string;
  content?: string;
  mediaUrls?: string[];
  error?: string;
  meta?: Record<string, unknown>;
  timestamp?: string;
};

export type OpenClawCatalogModel = { id: string; name?: string };
export type OpenClawCatalogAccount = { id: string; enabled?: boolean };
const OPENCLAW_DEFAULT_MODEL_ID = "default";
const OPENCLAW_EVENT_RECONNECT_DELAY_MS = 1000;
const OPENCLAW_RECOVERABLE_SESSION_STATUSES = new Set([
  401, 403, 404, 409, 410,
]);

export function normalizeOpenClawModels(
  models: OpenClawAgentResponse["models"],
): OpenClawCatalogModel[] {
  const normalized = new Map<string, OpenClawCatalogModel>();

  for (const model of models ?? []) {
    const modelId = typeof model === "string" ? model.trim() : model.id?.trim();
    if (!modelId) continue;

    normalized.set(modelId, {
      id: modelId,
      name:
        typeof model === "string" ? undefined : model.name?.trim() || undefined,
    });
  }

  return [...normalized.values()];
}

export function normalizeOpenClawAccounts(
  accounts: OpenClawAgentResponse["accounts"],
): OpenClawCatalogAccount[] {
  const normalized = new Map<string, OpenClawCatalogAccount>();

  for (const account of accounts ?? []) {
    const accountId =
      typeof account === "string" ? account.trim() : account.id?.trim();
    if (!accountId) continue;

    normalized.set(accountId, {
      id: accountId,
      enabled: typeof account === "string" ? true : account.enabled,
    });
  }

  return [...normalized.values()];
}

export function toOpenClawLlmModels(
  models: OpenClawCatalogModel[],
): LLMModel[] {
  const resolvedModels =
    models.length > 0
      ? models
      : [{ id: OPENCLAW_DEFAULT_MODEL_ID, name: "Default" }];

  return resolvedModels.map((model, index) => ({
    name: model.id,
    displayName: model.name
      ? `OpenClaw (${model.name})`
      : `OpenClaw (${model.id})`,
    available: true,
    sorted: index,
    provider: {
      id: "openclaw",
      providerName: ServiceProvider.OpenClaw,
      providerType: "openclaw",
      sorted: 0,
    },
  }));
}

type ClientDeviceMetadata = {
  model?: string;
  platform?: string;
  platformVersion?: string;
  browser?: string;
  browserVersion?: string;
  userAgent?: string;
};

function pickBrowserFromBrands(
  brands?: Array<{ brand?: string; version?: string }>,
): Pick<ClientDeviceMetadata, "browser" | "browserVersion"> {
  const candidates = brands ?? [];
  const browser = candidates.find(
    (brand) =>
      brand.brand &&
      !/not[ .]?a[ .]?brand|chromium/i.test(brand.brand) &&
      brand.brand !== "Google Chrome",
  );
  const fallback = candidates.find((brand) => brand.brand === "Google Chrome");
  const selected = browser ?? fallback;
  return {
    browser: selected?.brand,
    browserVersion: selected?.version,
  };
}

async function getClientDeviceMetadata(): Promise<ClientDeviceMetadata> {
  if (typeof navigator === "undefined") {
    return {};
  }

  const metadata: ClientDeviceMetadata = {
    userAgent: navigator.userAgent,
  };
  const userAgentData = (navigator as any).userAgentData;
  if (!userAgentData?.getHighEntropyValues) {
    return metadata;
  }

  try {
    const highEntropy = await userAgentData.getHighEntropyValues([
      "model",
      "platform",
      "platformVersion",
      "fullVersionList",
    ]);
    const browser = pickBrowserFromBrands(
      highEntropy.fullVersionList ?? userAgentData.brands,
    );
    return {
      ...metadata,
      model: highEntropy.model,
      platform: highEntropy.platform,
      platformVersion: highEntropy.platformVersion,
      browser: browser.browser,
      browserVersion: browser.browserVersion,
    };
  } catch {
    return metadata;
  }
}

export async function getOpenClawAuthState(): Promise<OpenClawAuthState> {
  const response = await fetch(resolveBridgePath(OpenClaw.AuthPath), {
    method: "GET",
  });
  if (!response.ok) {
    return { authenticated: false, agents: [] };
  }
  return response.json();
}

export async function loginOpenClaw(
  username: string,
  password: string,
): Promise<OpenClawAuthState> {
  const response = await fetch(resolveBridgePath(OpenClaw.AuthPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      username,
      password,
      device: await getClientDeviceMetadata(),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || "OpenClaw login failed");
  }
  return payload;
}

export async function logoutOpenClaw(): Promise<void> {
  await fetch(resolveBridgePath(OpenClaw.AuthPath), {
    method: "DELETE",
  });
}

export async function heartbeatOpenClawPresence(): Promise<void> {
  await fetch(resolveBridgePath("presence"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ device: await getClientDeviceMetadata() }),
  });
}

export async function getOpenClawAdminSessions(): Promise<OpenClawAdminSessionsResponse> {
  const response = await fetch(resolveBridgePath("admin/sessions"), {
    method: "GET",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || "Failed to load OpenClaw sessions");
  }
  return payload;
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function joinUrl(base: string, suffix: string): string {
  const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const normalizedSuffix = suffix.startsWith("/") ? suffix.slice(1) : suffix;
  return `${normalizedBase}/${normalizedSuffix}`;
}

function resolveBridgeBase(): string {
  const accessStore = useAccessStore.getState();
  const configured = accessStore.openclawBridgeUrl?.trim();
  if (configured) {
    return configured;
  }
  const isApp = !!getClientConfig()?.isApp;
  return isApp ? OpenClaw.ExampleEndpoint : ApiPath.OpenClaw;
}

function resolveBridgePath(path: string): string {
  const base = resolveBridgeBase();
  if (!isAbsoluteUrl(base)) {
    const normalizedBase = base.endsWith("/") ? base.slice(0, -1) : base;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizedBase}${normalizedPath}`;
  }
  return joinUrl(base, path);
}

function toPlainMessages(messages: ChatOptions["messages"]): RequestMessage[] {
  return messages.map((message) => ({
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : (message.content.filter((part): part is MultimodalContent =>
            Boolean(part?.type === "text" ? part.text : part?.image_url?.url),
          ) as MultimodalContent[]),
  }));
}

function getLatestUserTurn(
  messages: ChatOptions["messages"],
): ChatOptions["messages"] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      return [messages[i]];
    }
  }

  return messages.slice(-1);
}

function detectBrowserLabel(userAgent: string): string | undefined {
  const ua = userAgent.toLowerCase();
  if (ua.includes("edg/")) return "Edge";
  if (ua.includes("chrome/") && !ua.includes("edg/")) return "Chrome";
  if (ua.includes("firefox/")) return "Firefox";
  if (ua.includes("safari/") && !ua.includes("chrome/")) return "Safari";
  return undefined;
}

function detectDeviceLabel(userAgent: string): string | undefined {
  const androidMatch = userAgent.match(
    /Android[\d.\s]*;\s*([^;()]+?)(?:\s+Build\/|\))/i,
  );
  if (androidMatch?.[1]?.trim()) {
    return androidMatch[1].trim();
  }
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows NT/i.test(userAgent)) return "Windows PC";
  if (/Linux/i.test(userAgent)) return "Linux PC";
  return undefined;
}

function buildClientLabel(): string | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const userAgent = navigator.userAgent || "";
  const deviceLabel = detectDeviceLabel(userAgent);
  const browserLabel = detectBrowserLabel(userAgent);
  const label = [deviceLabel, browserLabel].filter(Boolean).join(" ");
  return label || undefined;
}

function buildOpenClawEventsUrl(session: ChatSession): string {
  const accessStore = useAccessStore.getState();
  const params = new URLSearchParams();
  params.set("sessionId", session.id);

  if (session.openclaw?.sessionKey?.trim()) {
    params.set("sessionKey", session.openclaw.sessionKey.trim());
  }

  const agentId =
    session.openclaw?.agentId?.trim() ||
    accessStore.openclawAgentId?.trim() ||
    session.mask.modelConfig.model;
  if (agentId) {
    params.set("agentId", agentId);
  }

  if (accessStore.openclawGatewayUrl?.trim()) {
    params.set("gatewayUrl", accessStore.openclawGatewayUrl.trim());
  }

  if (accessStore.openclawAuthToken?.trim()) {
    params.set("authToken", accessStore.openclawAuthToken.trim());
  }

  return `${resolveBridgePath(OpenClaw.EventsPath)}?${params.toString()}`;
}

function createOpenClawAssistantMessage(
  session: ChatSession,
  messageId: string,
  timestamp?: string,
): ChatMessage {
  return createMessage({
    role: "assistant",
    model: session.mask.modelConfig.model,
    content: "",
    streaming: true,
    serverMessageId: messageId,
    serverMessageIds: [messageId],
    status: "streaming",
    timestamp: timestamp ?? new Date().toISOString(),
    date: timestamp
      ? new Date(timestamp).toLocaleString()
      : new Date().toLocaleString(),
    openclawAggregated: true,
  });
}

function hasOpenClawServerMessageId(
  message: ChatMessage,
  messageId: string,
): boolean {
  return (
    message.serverMessageId === messageId ||
    message.serverMessageIds?.includes(messageId) === true
  );
}

function addOpenClawServerMessageId(message: ChatMessage, messageId: string) {
  if (hasOpenClawServerMessageId(message, messageId)) {
    return;
  }
  message.serverMessageIds = [...(message.serverMessageIds ?? []), messageId];
  message.serverMessageId = message.serverMessageId ?? messageId;
}

function findOpenClawAssistantMessage(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage | undefined {
  return messages.find((message) =>
    hasOpenClawServerMessageId(message, messageId),
  );
}

function findActiveOpenClawAggregateMessage(
  messages: ChatMessage[],
): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    if (!message.openclawAggregated) continue;
    if (message.status === "failed") return undefined;
    if (message.status === "completed" && !message.openclawPendingRequests) {
      return undefined;
    }
    return message;
  }
  return undefined;
}

function updateOpenClawConnectionState(
  session: ChatSession,
  status: NonNullable<ChatSession["openclaw"]>["connectionStatus"],
  message?: string,
) {
  const chatStore = useChatStore.getState();
  chatStore.updateTargetSession(session, (draft) => {
    draft.openclaw = {
      ...draft.openclaw,
      connectionStatus: status,
      connectionMessage: message,
    };
  });
}

function isTrackedOutboundMessage(
  trackedMessageIds: Set<string>,
  draft: ChatSession,
  messageId: string,
): boolean {
  if (trackedMessageIds.has(messageId)) {
    return true;
  }

  return draft.messages.some((message) =>
    hasOpenClawServerMessageId(message, messageId),
  );
}

function isProactiveOpenClawEvent(event: OpenClawEvent): boolean {
  return event.meta?.proactive === true;
}

function applyOpenClawEventToSession(
  session: ChatSession,
  event: OpenClawEvent,
  trackedMessageIds: Set<string>,
) {
  const chatStore = useChatStore.getState();
  const messageId = event.messageId?.trim();

  if (event.type === "message.accepted") {
    const isOutbound = event.meta?.source === "outbound";
    const isProactive = isProactiveOpenClawEvent(event);

    if (!messageId || (!isOutbound && !isProactive)) {
      return;
    }

    trackedMessageIds.add(messageId);
    chatStore.updateTargetSession(session, (draft) => {
      const existing =
        findOpenClawAssistantMessage(draft.messages, messageId) ??
        (isProactive
          ? undefined
          : findActiveOpenClawAggregateMessage(draft.messages));
      if (existing) {
        addOpenClawServerMessageId(existing, messageId);
        if (existing.status === "completed" || existing.status === "failed") {
          return;
        }
        existing.streaming = true;
        existing.status = "streaming";
        existing.timestamp = event.timestamp ?? existing.timestamp;
        return;
      }

      draft.messages.push(
        createOpenClawAssistantMessage(draft, messageId, event.timestamp),
      );
    });
    return;
  }

  if (
    !messageId ||
    !isTrackedOutboundMessage(trackedMessageIds, session, messageId)
  ) {
    return;
  }

  let finalizedMessage: ChatMessage | undefined;
  chatStore.updateTargetSession(session, (draft) => {
    let message = findOpenClawAssistantMessage(draft.messages, messageId);
    if (!message) {
      const activeAggregate = findActiveOpenClawAggregateMessage(
        draft.messages,
      );
      if (activeAggregate) {
        addOpenClawServerMessageId(activeAggregate, messageId);
        message = activeAggregate;
      } else {
        message = createOpenClawAssistantMessage(
          draft,
          messageId,
          event.timestamp,
        );
        draft.messages.push(message);
      }
    }

    if (
      message.status === "completed" &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      return;
    }

    if (event.type === "typing.start") {
      message.streaming = true;
      message.status = "streaming";
      return;
    }

    if (event.type === "typing.stop") {
      message.streaming = false;
      if (message.status === "streaming") {
        message.status = "pending";
      }
      return;
    }

    if (event.type === "message.delta") {
      if (event.delta) {
        message.content = `${
          typeof message.content === "string" ? message.content : ""
        }${event.delta}`;
      }
      message.streaming = true;
      message.status = "streaming";
      return;
    }

    if (event.type === "message.failed") {
      if (message.status === "failed") {
        return;
      }

      message.streaming = false;
      message.status = "failed";
      message.isError = true;
      message.error = event.error;

      if (event.error) {
        const currentContent =
          typeof message.content === "string" ? message.content.trim() : "";
        message.content = currentContent
          ? `${currentContent}\n\n[OpenClaw error] ${event.error}`
          : `[OpenClaw error] ${event.error}`;
      }
      return;
    }

    if (event.type === "message.completed") {
      if (message.status === "completed") {
        return;
      }

      message.streaming = false;
      message.status = "completed";
      message.isError = false;
      message.error = undefined;
      message.content =
        event.content ??
        (typeof message.content === "string" ? message.content : "");

      if (event.timestamp) {
        message.timestamp = event.timestamp;
        message.date = new Date(event.timestamp).toLocaleString();
      } else {
        message.date = new Date().toLocaleString();
      }

      finalizedMessage = { ...message };
    }
  });

  if (finalizedMessage) {
    chatStore.onNewMessage(finalizedMessage, session);
  }
}

export function useOpenClawEventSync(session: ChatSession) {
  const sessionRef = useRef(session);
  const trackedMessageIdsRef = useRef<Set<string>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRebindingRef = useRef(false);
  const [reconnectVersion, setReconnectVersion] = useState(0);

  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  useEffect(() => {
    trackedMessageIdsRef.current = new Set(
      session.messages.flatMap((message) => [
        ...(message.serverMessageId ? [message.serverMessageId] : []),
        ...(message.serverMessageIds ?? []),
      ]),
    );
  }, [session.id, session.messages]);

  useEffect(() => {
    const isOpenClawSession =
      session.mask.modelConfig.providerName === ServiceProvider.OpenClaw;
    const sessionKey = session.openclaw?.sessionKey?.trim();

    if (!isOpenClawSession || !sessionKey) {
      return;
    }

    const scheduleReconnect = (delay = OPENCLAW_EVENT_RECONNECT_DELAY_MS) => {
      updateOpenClawConnectionState(sessionRef.current, "reconnecting");
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        setReconnectVersion((version) => version + 1);
      }, delay);
    };

    const refreshSessionBinding = async () => {
      if (isRebindingRef.current) {
        return;
      }
      isRebindingRef.current = true;
      try {
        updateOpenClawConnectionState(
          sessionRef.current,
          "reconnecting",
          "正在刷新会话…",
        );
        await ensureSessionBinding(true, sessionRef.current);
      } catch (error) {
        console.error("[OpenClaw] failed to refresh session binding", error);
        updateOpenClawConnectionState(
          sessionRef.current,
          "reconnecting",
          "会话刷新失败，正在重试…",
        );
      } finally {
        isRebindingRef.current = false;
        scheduleReconnect();
      }
    };

    const handleResume = () => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      scheduleReconnect(0);
    };

    window.addEventListener("focus", handleResume);
    window.addEventListener("online", handleResume);
    window.addEventListener("pageshow", handleResume);
    document.addEventListener("visibilitychange", handleResume);

    const controller = new AbortController();
    const eventsUrl = buildOpenClawEventsUrl(session);
    updateOpenClawConnectionState(sessionRef.current, "connecting");
    void fetchEventSource(eventsUrl, {
      fetch: tauriFetch as typeof fetch,
      method: "GET",
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(res) {
        if (!res.ok) {
          const message = await res.text();
          if (OPENCLAW_RECOVERABLE_SESSION_STATUSES.has(res.status)) {
            controller.abort();
            void refreshSessionBinding();
            return;
          }

          const error = new Error(
            message || `OpenClaw events request failed (${res.status})`,
          ) as Error & { status?: number };
          error.status = res.status;
          throw error;
        }
        updateOpenClawConnectionState(sessionRef.current, "connected");
      },
      onmessage(msg) {
        if (msg.data === "[DONE]" || !msg.data?.trim()) {
          return;
        }

        try {
          const payload = JSON.parse(msg.data) as OpenClawEvent;
          applyOpenClawEventToSession(
            sessionRef.current,
            payload,
            trackedMessageIdsRef.current,
          );
        } catch (error) {
          console.error("[OpenClaw] failed to process event", error);
        }
      },
      onclose() {
        if (controller.signal.aborted) {
          return;
        }
        scheduleReconnect();
      },
      onerror(error) {
        if (controller.signal.aborted) {
          return;
        }

        const status =
          typeof error === "object" && error && "status" in error
            ? Number((error as { status?: unknown }).status)
            : undefined;
        if (status && OPENCLAW_RECOVERABLE_SESSION_STATUSES.has(status)) {
          controller.abort();
          void refreshSessionBinding();
          return;
        }

        console.error("[OpenClaw] event stream error", error);
        updateOpenClawConnectionState(
          sessionRef.current,
          "reconnecting",
          "连接已断开，正在重试…",
        );
        return OPENCLAW_EVENT_RECONNECT_DELAY_MS;
      },
    });

    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      window.removeEventListener("focus", handleResume);
      window.removeEventListener("online", handleResume);
      window.removeEventListener("pageshow", handleResume);
      document.removeEventListener("visibilitychange", handleResume);
      controller.abort();
    };
  }, [
    reconnectVersion,
    session.id,
    session.mask.modelConfig.providerName,
    session.openclaw?.sessionKey,
    session.openclaw?.agentId,
  ]);
}

function isLegacyOpenClawSessionKey(
  sessionKey: string | undefined,
  agentId?: string,
): boolean {
  const normalized = sessionKey?.trim();
  if (!normalized) {
    return true;
  }
  if (normalized.includes(":nextchat:direct:")) {
    return true;
  }
  if (
    agentId &&
    !normalized.includes(`agent:${agentId}:nextchat:`) &&
    !normalized.includes(`:nextchat:${agentId}:`)
  ) {
    return true;
  }
  return false;
}

function resolveSessionAgentId(session: ChatSession): string {
  const accessStore = useAccessStore.getState();
  const candidate =
    session.openclaw?.agentId?.trim() || accessStore.openclawAgentId || "main";
  const allowedAgents = accessStore.openclawAllowedAgents ?? [];
  if (
    allowedAgents.length > 0 &&
    !allowedAgents.includes("*") &&
    !allowedAgents.includes(candidate)
  ) {
    return allowedAgents[0] || candidate;
  }
  return candidate;
}

async function ensureSessionBinding(
  forceRefresh = false,
  targetSession?: ChatSession,
): Promise<OpenClawSessionBinding> {
  const accessStore = useAccessStore.getState();
  const chatStore = useChatStore.getState();
  const session = targetSession ?? chatStore.currentSession();
  const existing = session.openclaw;
  const sessionAgentId = resolveSessionAgentId(session);
  if (
    !forceRefresh &&
    existing?.sessionKey &&
    !isLegacyOpenClawSessionKey(existing.sessionKey, sessionAgentId) &&
    existing?.agentId === sessionAgentId
  ) {
    return {
      sessionId: session.id,
      sessionKey: existing.sessionKey,
      conversationId: existing.conversationId ?? existing.sessionKey,
      agentId: existing.agentId ?? sessionAgentId,
      channel: existing.channel ?? "nextchat",
      createdAt: existing.createdAt ?? new Date().toISOString(),
    };
  }

  const response = await fetch(resolveBridgePath(OpenClaw.SessionPath), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      clientSessionId: session.id,
      title: session.topic,
      agentId: sessionAgentId,
      gatewayUrl: accessStore.openclawGatewayUrl,
      authToken: accessStore.openclawAuthToken,
      defaultAgentId: sessionAgentId,
      model: session.mask.modelConfig.model,
      clientLabel: buildClientLabel(),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "failed to bind OpenClaw session");
  }

  const binding = (await response.json()) as OpenClawSessionBinding;
  chatStore.updateTargetSession(session, (draft) => {
    draft.openclaw = {
      sessionKey: binding.sessionKey,
      conversationId: binding.conversationId,
      agentId: binding.agentId,
      channel: binding.channel,
      createdAt: binding.createdAt,
    };
  });
  return binding;
}

function buildOpenClawSessionMetadata(session: ChatSession): {
  title?: string;
  clientLabel?: string;
} {
  const topic = session.topic?.trim();
  const sessionKey = session.openclaw?.sessionKey?.trim();
  const title = topic
    ? !sessionKey || topic.includes(sessionKey)
      ? topic
      : `${topic} · ${sessionKey}`
    : undefined;
  return {
    title,
    clientLabel: buildClientLabel(),
  };
}

function isRecoverableOpenClawDispatchError(status: number, message: string) {
  if ([502, 504, 524].includes(status)) {
    return true;
  }

  return /gateway (time-out|timeout)|bad gateway/i.test(message);
}

export class OpenClawApi implements LLMApi {
  async chat(options: ChatOptions): Promise<void> {
    const accessStore = useAccessStore.getState();
    const session = useChatStore.getState().currentSession();
    const binding = await ensureSessionBinding();
    const sessionMetadata = buildOpenClawSessionMetadata({
      ...session,
      openclaw: {
        ...session.openclaw,
        sessionKey: binding.sessionKey,
      },
    });
    const requestPayload = {
      sessionId: binding.sessionId,
      sessionKey: binding.sessionKey,
      conversationId: binding.conversationId,
      agentId: binding.agentId,
      stream: options.config.stream !== false,
      model: options.config.model,
      messages: toPlainMessages(getLatestUserTurn(options.messages)),
      gatewayUrl: accessStore.openclawGatewayUrl,
      authToken: accessStore.openclawAuthToken,
      defaultAgentId: binding.agentId,
      title: sessionMetadata.title,
      clientLabel: sessionMetadata.clientLabel,
    };

    let responseText = "";
    let responseRes: Response | undefined;
    let finished = false;
    const controller = new AbortController();
    options.onController?.(controller);
    const timeoutId = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS * 5,
    );

    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutId);
      options.onFinish(responseText, responseRes ?? new Response(responseText));
    };

    fetchEventSource(resolveBridgePath(OpenClaw.MessagePath), {
      fetch: tauriFetch as typeof fetch,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestPayload),
      signal: controller.signal,
      openWhenHidden: true,
      async onopen(res) {
        responseRes = res;
        clearTimeout(timeoutId);
        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok) {
          let message = await res.clone().text();
          try {
            message = prettyObject(await res.clone().json());
          } catch {}
          if (isRecoverableOpenClawDispatchError(res.status, message)) {
            finish();
            return;
          }
          throw new Error(message || `OpenClaw request failed (${res.status})`);
        }
        if (contentType.startsWith("application/json")) {
          const payload = (await res.clone().json()) as OpenClawJsonCompletion;
          responseText =
            payload.choices?.[0]?.message?.content ??
            payload.choices?.[0]?.delta?.content ??
            "";
          finish();
          return;
        }
        if (contentType.startsWith("text/plain")) {
          responseText = await res.clone().text();
          finish();
          return;
        }
        if (!contentType.startsWith(EventStreamContentType)) {
          const message = await res.clone().text();
          throw new Error(message || `OpenClaw request failed (${res.status})`);
        }
      },
      onmessage(msg) {
        if (msg.data === "[DONE]") {
          finish();
          return;
        }
        if (!msg.data?.trim()) {
          return;
        }
        const payload = JSON.parse(msg.data) as {
          choices?: Array<{
            delta?: { content?: string };
            finish_reason?: string | null;
          }>;
        };
        const chunk = payload.choices?.[0]?.delta?.content ?? "";
        if (!chunk) {
          return;
        }
        responseText += chunk;
        options.onUpdate?.(responseText, chunk);
      },
      onclose() {
        finish();
      },
      onerror(error) {
        options.onError?.(error as Error);
        throw error;
      },
    });
  }

  async speech(_options: SpeechOptions): Promise<ArrayBuffer> {
    throw new Error(
      "OpenClaw speech is not implemented in the NextChat bridge",
    );
  }

  async usage(): Promise<LLMUsage> {
    return { used: 0, total: 0 };
  }

  async models(): Promise<LLMModel[]> {
    const accessStore = useAccessStore.getState();
    const response = await fetch(resolveBridgePath(OpenClaw.AgentsPath), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        gatewayUrl: accessStore.openclawGatewayUrl,
        authToken: accessStore.openclawAuthToken,
        defaultAgentId: accessStore.openclawAgentId,
      }),
    });
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as OpenClawAgentResponse;
    return toOpenClawLlmModels(normalizeOpenClawModels(payload.models));
  }
}
