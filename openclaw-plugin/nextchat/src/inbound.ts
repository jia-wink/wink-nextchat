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

export async function dispatchNextChatMessage(params: {
  body: NextChatMessageRequest;
  writeDelta?: (delta: string) => void;
  stream: boolean;
}): Promise<{
  session: NextChatSessionRecord;
  content: string;
  mediaUrls: string[];
  error?: string;
} | null> {
  let session: NextChatSessionRecord | undefined;
  try {
    const cfg = loadNextChatConfigSnapshot() as OpenClawConfig;
    const existing = getNextChatSession({
      sessionKey: params.body.sessionKey?.trim(),
      sessionId: params.body.sessionId?.trim() || params.body.clientSessionId?.trim(),
    });
    session =
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
    startNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      meta: {
        agentId: session.agentId,
        accountId: session.accountId,
      },
    });

    await dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: nextchatRuntime,
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
      rawBody: normalized.rawBody || bodyForAgent,
      bodyForAgent,
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
        if (delta && params.writeDelta) {
          params.writeDelta(delta);
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
    if (session) {
      failNextChatReply({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        error: normalizedMessage,
      });
    }
    if (params.stream && params.writeDelta) {
      params.writeDelta(`[OpenClaw error] ${normalizedMessage}`);
    }
    console.error("[nextchat] dispatchNextChatMessage failed:", error);
    if (!session) {
      return null;
    }
    return {
      session,
      content: `[OpenClaw error] ${normalizedMessage}`,
      mediaUrls: [],
      error: normalizedMessage,
    };
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
