import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  dispatchInboundDirectDmWithRuntime,
  resolveEnvelopeFormatOptions,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  readSessionUpdatedAt,
  resolveStorePath,
} from "openclaw/plugin-sdk/config-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { finalizeInboundContext, dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { createNextChatSessionKey } from "./session-route.js";
import {
  appendNextChatReplyDelta,
  completeNextChatReply,
  failNextChatReply,
  getNextChatSession,
  loadNextChatConfigSnapshot,
  startNextChatReply,
  upsertNextChatSession,
} from "./runtime.js";
import type {
  NextChatChannelConfig,
  NextChatInboundAttachment,
  NextChatInboundMessage,
  NextChatMessageRequest,
  NextChatSessionRecord,
  NextChatSessionRequest,
} from "./types.js";

const NEXTCHAT_CHANNEL = "nextchat";
const NEXTCHAT_GENERIC_TITLES = new Set([
  "新的聊天",
  "新对话",
  "new chat",
  "new conversation",
  "untitled",
  "untitled chat",
]);

type EnvelopeFormatOptions = ReturnType<typeof resolveEnvelopeFormatOptions>;
type NextChatDispatchResult = {
  session: NextChatSessionRecord;
  content: string;
  mediaUrls: string[];
  error?: string;
};
type PreparedNextChatDispatch = {
  cfg: OpenClawConfig;
  session: NextChatSessionRecord;
  rawBody: string;
  bodyForAgent: string;
  clientMessageId: string;
  stream: boolean;
  writeDelta?: (delta: string) => void;
};
type QueuedNextChatDispatch = {
  prepared: PreparedNextChatDispatch;
  resolve: (result: NextChatDispatchResult) => void;
};
type NextChatAggregationBuffer = {
  items: QueuedNextChatDispatch[];
  timeout: ReturnType<typeof setTimeout> | null;
  debounceMs: number;
};

const aggregationBuffers = new Map<string, NextChatAggregationBuffer>();

function sanitizeEnvelopeHeaderPart(value: string): string {
  return value
    .replace(/\r\n|\r|\n/g, " ")
    .replaceAll("[", "(")
    .replaceAll("]", ")")
    .replace(/\s+/g, " ")
    .trim();
}

function formatEnvelopeTimestamp(
  ts: number | Date | undefined,
  options?: EnvelopeFormatOptions,
): string | undefined {
  if (!ts || options?.includeTimestamp === false) {
    return undefined;
  }
  const date = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function formatAgentEnvelope(params: {
  channel: string;
  from?: string;
  timestamp?: number | Date;
  host?: string;
  ip?: string;
  body: string;
  previousTimestamp?: number | Date;
  envelope?: EnvelopeFormatOptions;
}): string {
  const parts: string[] = [sanitizeEnvelopeHeaderPart(params.channel?.trim() || "Channel")];
  if (params.from?.trim()) {
    parts.push(sanitizeEnvelopeHeaderPart(params.from.trim()));
  }
  if (params.host?.trim()) {
    parts.push(sanitizeEnvelopeHeaderPart(params.host.trim()));
  }
  if (params.ip?.trim()) {
    parts.push(sanitizeEnvelopeHeaderPart(params.ip.trim()));
  }
  const timestamp = formatEnvelopeTimestamp(params.timestamp, params.envelope);
  if (timestamp) {
    parts.push(timestamp);
  }
  return `[${parts.join(" ")}] ${params.body}`;
}

const nextchatRuntime = {
  channel: {
    routing: {
      resolveAgentRoute,
    },
    session: {
      resolveStorePath,
      readSessionUpdatedAt,
      recordInboundSession,
    },
    reply: {
      resolveEnvelopeFormatOptions,
      formatAgentEnvelope,
      finalizeInboundContext,
      dispatchReplyWithBufferedBlockDispatcher,
    },
  },
};

function createSessionBoundRuntime(session: NextChatSessionRecord) {
  if (!session.explicitAgentId) {
    return nextchatRuntime;
  }

  return {
    channel: {
      ...nextchatRuntime.channel,
      routing: {
        resolveAgentRoute: () => ({
          agentId: session.agentId,
          sessionKey: session.sessionKey,
          accountId: session.accountId,
        }),
      },
    },
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) {
    return {};
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

function normalizeAccountId(value: unknown): string {
  const trimmed = String(value ?? "default").trim();
  return trimmed || "default";
}

function normalizeExplicitAgentId(value: unknown): string | undefined {
  const trimmed = String(value ?? "").trim();
  return trimmed || undefined;
}

function getLatestUserMessage(messages: NextChatInboundMessage[] | undefined): NextChatInboundMessage {
  const latest =
    [...(messages ?? [])].reverse().find((message) => String(message.role ?? "user") === "user") ??
    messages?.[messages.length - 1];
  return latest ?? { role: "user", content: "" };
}

function normalizeAttachmentUrls(input: NextChatInboundAttachment[] | undefined): string[] {
  return (input ?? [])
    .map((attachment) => attachment?.url?.trim())
    .filter((url): url is string => Boolean(url));
}

function normalizeMessageContent(message: NextChatInboundMessage | undefined): {
  rawBody: string;
  bodyForAgent: string;
  attachmentUrls: string[];
} {
  if (!message) {
    return { rawBody: "", bodyForAgent: "", attachmentUrls: [] };
  }
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return { rawBody: text, bodyForAgent: text, attachmentUrls: [] };
  }
  const textParts: string[] = [];
  const attachmentUrls: string[] = [];
  for (const part of message.content ?? []) {
    if (part?.type === "text" && part.text?.trim()) {
      textParts.push(part.text.trim());
    }
    const imageUrl = part?.image_url?.url?.trim();
    if (part?.type === "image_url" && imageUrl) {
      attachmentUrls.push(imageUrl);
    }
  }
  const text = textParts.join("\n").trim();
  const attachmentBlock = attachmentUrls.map((url) => `Attachment: ${url}`).join("\n");
  const bodyForAgent = [text, attachmentBlock].filter(Boolean).join("\n\n").trim();
  return {
    rawBody: text || bodyForAgent,
    bodyForAgent,
    attachmentUrls,
  };
}

function buildAssistantMarkdown(params: { text?: string; mediaUrls?: string[] }): string {
  const text = params.text?.trim() ?? "";
  const mediaUrls = (params.mediaUrls ?? []).map((url) => url.trim()).filter(Boolean);
  const mediaBlock = mediaUrls.map((url) => `![](${url})`).join("\n\n");
  if (!text) {
    return mediaBlock;
  }
  if (!mediaBlock) {
    return text;
  }
  return `${text}\n\n${mediaBlock}`;
}

function resolveMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.trunc(value));
}

function resolveNextChatConfig(cfg: OpenClawConfig): NextChatChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.nextchat ??
    {}) as NextChatChannelConfig;
}

function resolveLegacyNextChatDebounceMs(cfg: OpenClawConfig): number {
  const inbound = cfg.messages?.inbound;
  return (
    resolveMs((inbound?.byChannel as Record<string, unknown> | undefined)?.[NEXTCHAT_CHANNEL]) ??
    resolveMs(inbound?.debounceMs) ??
    0
  );
}

function resolveNextChatAggregationMs(cfg: OpenClawConfig, agentId: string): number {
  const nextchat = resolveNextChatConfig(cfg);
  const aggregation = nextchat.messageAggregation;
  const legacyMs = resolveLegacyNextChatDebounceMs(cfg);
  if (!aggregation) {
    return legacyMs;
  }

  const agentConfig = aggregation.agents?.[agentId];
  const shouldAggregate = agentConfig?.aggregateReplies ?? aggregation.enabled ?? true;
  if (!shouldAggregate) {
    return 0;
  }
  return resolveMs(agentConfig?.debounceMs) ?? resolveMs(aggregation.debounceMs) ?? legacyMs;
}

function withNextChatCoreDebounceDisabled(cfg: OpenClawConfig): OpenClawConfig {
  const messages = cfg.messages ?? {};
  const inbound = messages.inbound ?? {};
  return {
    ...cfg,
    messages: {
      ...messages,
      inbound: {
        ...inbound,
        byChannel: {
          ...(inbound.byChannel ?? {}),
          [NEXTCHAT_CHANNEL]: 0,
        },
      },
    },
  } as OpenClawConfig;
}

function buildAggregationKey(session: NextChatSessionRecord): string {
  return [
    NEXTCHAT_CHANNEL,
    session.accountId || "default",
    session.agentId || "main",
    session.sessionId,
  ].join(":");
}

function mergePreparedDispatches(items: QueuedNextChatDispatch[]): PreparedNextChatDispatch {
  const latest = items[items.length - 1].prepared;
  const rawBody = items
    .map((item) => item.prepared.rawBody.trim())
    .filter(Boolean)
    .join("\n\n");
  const bodyForAgent = items
    .map((item) => item.prepared.bodyForAgent.trim())
    .filter(Boolean)
    .join("\n\n");
  const writeDeltaCallbacks = items
    .map((item) => item.prepared.writeDelta)
    .filter((callback): callback is (delta: string) => void => Boolean(callback));

  return {
    ...latest,
    rawBody: rawBody || latest.rawBody,
    bodyForAgent: bodyForAgent || latest.bodyForAgent,
    writeDelta: writeDeltaCallbacks.length
      ? (delta) => {
          for (const callback of writeDeltaCallbacks) {
            callback(delta);
          }
        }
      : undefined,
  };
}

async function flushAggregationBuffer(key: string, buffer: NextChatAggregationBuffer): Promise<void> {
  if (aggregationBuffers.get(key) === buffer) {
    aggregationBuffers.delete(key);
  }
  if (buffer.timeout) {
    clearTimeout(buffer.timeout);
    buffer.timeout = null;
  }
  const items = buffer.items.splice(0);
  if (items.length === 0) {
    return;
  }
  const result = await dispatchPreparedNextChatMessage(mergePreparedDispatches(items));
  for (const item of items) {
    item.resolve(result);
  }
}

function scheduleAggregationFlush(key: string, buffer: NextChatAggregationBuffer): void {
  if (buffer.timeout) {
    clearTimeout(buffer.timeout);
  }
  buffer.timeout = setTimeout(() => {
    void flushAggregationBuffer(key, buffer);
  }, buffer.debounceMs);
  buffer.timeout.unref?.();
}

function enqueuePreparedNextChatMessage(
  prepared: PreparedNextChatDispatch,
  debounceMs: number,
): Promise<NextChatDispatchResult> {
  if (!(debounceMs > 0)) {
    return dispatchPreparedNextChatMessage(prepared);
  }

  const key = buildAggregationKey(prepared.session);
  return new Promise((resolve) => {
    const existing = aggregationBuffers.get(key);
    if (existing) {
      existing.items.push({ prepared, resolve });
      existing.debounceMs = debounceMs;
      scheduleAggregationFlush(key, existing);
      return;
    }

    const buffer: NextChatAggregationBuffer = {
      items: [{ prepared, resolve }],
      timeout: null,
      debounceMs,
    };
    aggregationBuffers.set(key, buffer);
    scheduleAggregationFlush(key, buffer);
  });
}

function normalizeSessionTitle(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isGenericSessionTitle(value: string | undefined): boolean {
  const normalized = normalizeSessionTitle(value);
  if (!normalized) {
    return true;
  }
  return NEXTCHAT_GENERIC_TITLES.has(normalized.toLowerCase());
}

function formatSessionCreatedAt(createdAt: string): string {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function buildGeneratedSessionTitle(params: {
  clientLabel?: string;
  createdAt: string;
}): string {
  const deviceLabel = normalizeSessionTitle(params.clientLabel) ?? "NextChat";
  return `${deviceLabel} · ${formatSessionCreatedAt(params.createdAt)}`;
}

function resolveSessionTitle(params: {
  title?: string;
  clientLabel?: string;
  createdAt: string;
  fallbackTitle?: string;
}): string | undefined {
  const preferred = normalizeSessionTitle(params.title);
  if (!isGenericSessionTitle(preferred)) {
    return preferred;
  }

  const fallback = normalizeSessionTitle(params.fallbackTitle);
  if (fallback && !isGenericSessionTitle(fallback)) {
    return fallback;
  }

  return buildGeneratedSessionTitle({
    clientLabel: params.clientLabel,
    createdAt: params.createdAt,
  });
}

function buildSessionRecord(params: {
  cfg: OpenClawConfig;
  request: NextChatSessionRequest;
}): NextChatSessionRecord {
  const sessionId = String(
    params.request.sessionId ?? params.request.clientSessionId ?? randomUUID(),
  ).trim();
  const accountId = normalizeAccountId(params.request.accountId);
  const explicitAgentId = normalizeExplicitAgentId(params.request.agentId);
  const createdAt = new Date().toISOString();
  const route = explicitAgentId
    ? {
        agentId: explicitAgentId,
        accountId,
        sessionKey:
          params.request.sessionKey?.trim() ||
          createNextChatSessionKey({
            agentId: explicitAgentId,
            sessionId,
            accountId,
          }),
      }
    : resolveAgentRoute({
        cfg: params.cfg,
        channel: NEXTCHAT_CHANNEL,
        accountId,
        peer: {
          kind: "direct",
          id: sessionId,
        },
      });

  return {
    sessionId,
    sessionKey: route.sessionKey,
    conversationId: route.sessionKey,
    agentId: route.agentId,
    accountId: route.accountId ?? accountId,
    channel: "nextchat",
    title: resolveSessionTitle({
      title: params.request.title,
      clientLabel: params.request.clientLabel,
      createdAt,
    }),
    clientLabel: normalizeSessionTitle(params.request.clientLabel),
    model: params.request.model?.trim() || undefined,
    explicitAgentId: Boolean(explicitAgentId),
    createdAt,
    updatedAt: createdAt,
  };
}

export async function handleNextChatSessionRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<NextChatSessionRecord | null> {
  try {
    const body = (await readJson(req)) as NextChatSessionRequest;
    const cfg = loadNextChatConfigSnapshot() as OpenClawConfig;
    const session = buildSessionRecord({ cfg, request: body });
    upsertNextChatSession(session);
    return session;
  } catch (error) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: true,
        message: `Invalid request: ${String(error)}`,
      }),
    );
    return null;
  }
}

async function dispatchPreparedNextChatMessage(
  prepared: PreparedNextChatDispatch,
): Promise<NextChatDispatchResult> {
  const { cfg, session, clientMessageId } = prepared;
  try {
    startNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      meta: {
        agentId: session.agentId,
        accountId: session.accountId,
      },
    });

    await dispatchInboundDirectDmWithRuntime({
      cfg: withNextChatCoreDebounceDisabled(cfg),
      runtime: createSessionBoundRuntime(session),
      channel: NEXTCHAT_CHANNEL,
      channelLabel: "NextChat",
      accountId: session.accountId,
      peer: {
        kind: "direct",
        id: session.sessionId,
      },
      senderId: session.accountId,
      senderAddress: `nextchat:${session.sessionId}`,
      recipientAddress: `nextchat:${session.sessionId}`,
      conversationLabel: session.title?.trim() || session.sessionId,
      rawBody: prepared.rawBody || prepared.bodyForAgent,
      bodyForAgent: prepared.bodyForAgent,
      messageId: clientMessageId,
      provider: NEXTCHAT_CHANNEL,
      surface: NEXTCHAT_CHANNEL,
      originatingChannel: NEXTCHAT_CHANNEL,
      originatingTo: `nextchat:${session.sessionId}`,
      deliver: async (payload) => {
        const delta = buildAssistantMarkdown({
          text: payload.text,
          mediaUrls: payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []),
        });
        const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
        appendNextChatReplyDelta({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          delta,
          mediaUrls,
        });
        if (delta && prepared.writeDelta) {
          prepared.writeDelta(delta);
        }
      },
      onRecordError: (error) => {
        failNextChatReply({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          error: `Failed to record session: ${String(error)}`,
        });
      },
      onDispatchError: (error) => {
        failNextChatReply({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          error: String(error),
        });
      },
    });

    const reply = completeNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
    });
    return {
      session,
      content: reply?.content ?? "",
      mediaUrls: reply?.mediaUrls ?? [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.trim() || "OpenClaw dispatch failed.";
    failNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      error: normalizedMessage,
    });
    if (prepared.stream && prepared.writeDelta) {
      prepared.writeDelta(`[OpenClaw error] ${normalizedMessage}`);
    }
    console.error("[nextchat] dispatchNextChatMessage failed:", error);
    return {
      session,
      content: `[OpenClaw error] ${normalizedMessage}`,
      mediaUrls: [],
      error: normalizedMessage,
    };
  }
}

export async function dispatchNextChatMessage(params: {
  body: NextChatMessageRequest;
  writeDelta?: (delta: string) => void;
  stream: boolean;
}): Promise<NextChatDispatchResult | null> {
  try {
    const cfg = loadNextChatConfigSnapshot() as OpenClawConfig;
    const existing = getNextChatSession({
      sessionKey: params.body.sessionKey?.trim(),
      sessionId: params.body.sessionId?.trim() || params.body.clientSessionId?.trim(),
    });
    const session =
      existing ??
      buildSessionRecord({
        cfg,
        request: params.body,
      });
    session.model = params.body.model?.trim() || session.model;
    session.clientLabel = normalizeSessionTitle(params.body.clientLabel) || session.clientLabel;
    session.title = resolveSessionTitle({
      title: params.body.title,
      clientLabel: session.clientLabel,
      createdAt: session.createdAt,
      fallbackTitle: session.title,
    });
    upsertNextChatSession(session);

    const userMessage = getLatestUserMessage(params.body.messages);
    const normalized = normalizeMessageContent(userMessage);
    const attachmentUrls = [
      ...normalized.attachmentUrls,
      ...normalizeAttachmentUrls(params.body.attachments),
    ];
    const bodyForAgent = buildAssistantMarkdown({
      text: normalized.bodyForAgent || normalized.rawBody,
      mediaUrls: attachmentUrls,
    });
    const clientMessageId = String(params.body.clientMessageId ?? randomUUID()).trim();
    return await enqueuePreparedNextChatMessage(
      {
        cfg,
        session,
        rawBody: normalized.rawBody || bodyForAgent,
        bodyForAgent,
        clientMessageId,
        stream: params.stream,
        writeDelta: params.writeDelta,
      },
      resolveNextChatAggregationMs(cfg, session.agentId),
    );
  } catch (error) {
    console.error("[nextchat] dispatchNextChatMessage failed:", error);
    return null;
  }
}

export function listNextChatAgentsAndModels() {
  const cfg = loadNextChatConfigSnapshot() as OpenClawConfig;
  const nextchat = (cfg.channels as Record<string, any> | undefined)?.nextchat ?? {};
  const configuredDefaultAgentId =
    String(cfg.agents?.defaults?.agentId ?? cfg.channels?.nextchat?.defaultAgentId ?? "main").trim() ||
    "main";
  const configuredAgents = Array.isArray(cfg.agents?.list)
    ? cfg.agents.list
        .map((entry) => ({
          id: String(entry?.id ?? "").trim(),
          name:
            typeof entry?.name === "string" && entry.name.trim() ? entry.name.trim() : undefined,
        }))
        .filter((entry) => entry.id)
    : [];
  const agents =
    configuredAgents.length > 0
      ? configuredAgents
      : [
          {
            id: configuredDefaultAgentId,
          },
        ];
  if (!agents.some((entry) => entry.id === configuredDefaultAgentId)) {
    agents.unshift({ id: configuredDefaultAgentId });
  }
  const accounts = Object.keys(nextchat.accounts ?? {});
  const configuredModels = Object.keys(cfg.agents?.defaults?.models ?? {}).map((id) => ({
    id,
    name: cfg.agents?.defaults?.models?.[id]?.alias,
  }));
  return {
    defaultAgentId: configuredDefaultAgentId,
    agents,
    models: configuredModels,
    accounts: accounts.length > 0 ? accounts : ["default"],
  };
}
