import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createInboundDebouncer,
  dispatchInboundDirectDmWithRuntime,
  resolveEnvelopeFormatOptions,
  resolveInboundDebounceMs,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
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
const FINAL_REPLY_WAIT_MS = 90_000;
const FINAL_REPLY_POLL_MS = 1_000;

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
  hasMedia: boolean;
  stream: boolean;
  writeDelta?: (delta: string) => void;
};
type QueuedNextChatDispatch = {
  prepared: PreparedNextChatDispatch;
  resolve: (result: NextChatDispatchResult) => void;
};

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
  const routedRuntime = session.explicitAgentId
    ? {
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
      }
    : nextchatRuntime;

  return {
    channel: {
      ...routedRuntime.channel,
      reply: {
        ...routedRuntime.channel.reply,
        dispatchReplyWithBufferedBlockDispatcher: async (params: any) => {
          const configuredBeforeDeliver = params.dispatcherOptions?.beforeDeliver;
          return routedRuntime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
            ...params,
            dispatcherOptions: {
              ...params.dispatcherOptions,
              beforeDeliver: async (payload: any, info: { kind?: string }) => {
                const deliverPayload = configuredBeforeDeliver
                  ? await configuredBeforeDeliver(payload, info)
                  : payload;
                if (!deliverPayload || info?.kind === "block") {
                  return null;
                }
                return deliverPayload;
              },
            },
          });
        },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextContent(content: unknown): { text: string; hasToolCall: boolean } {
  if (typeof content === "string") {
    return { text: content.trim(), hasToolCall: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasToolCall: false };
  }
  const texts: string[] = [];
  let hasToolCall = false;
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const item = part as Record<string, unknown>;
    if (item.type === "toolCall") {
      hasToolCall = true;
      continue;
    }
    if (item.type === "text" && typeof item.text === "string" && item.text.trim()) {
      texts.push(item.text.trim());
    }
  }
  return { text: texts.join("\n\n").trim(), hasToolCall };
}

function parseMessageTimeMs(row: Record<string, unknown>, message: Record<string, unknown>): number {
  if (typeof message.timestamp === "number") {
    return message.timestamp;
  }
  if (typeof row.timestamp === "string") {
    const parsed = Date.parse(row.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function isUsableChannelReply(text: string | undefined): boolean {
  const normalized = text?.trim() ?? "";
  if (!normalized) {
    return false;
  }
  return !/^(now let me|let me|i need to|the user is|i should|i will)\b/i.test(normalized);
}

function resolveSessionFileFromIndex(indexFile: string, sessionKey: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(indexFile, "utf8")) as Record<string, any>;
    const direct = raw[sessionKey];
    if (typeof direct?.sessionFile === "string") {
      return direct.sessionFile;
    }
    const lowered = sessionKey.toLowerCase();
    for (const [key, value] of Object.entries(raw)) {
      if (key.toLowerCase() === lowered && typeof value?.sessionFile === "string") {
        return value.sessionFile;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readLatestFinalAssistantText(params: {
  indexFile: string;
  sessionKey: string;
  afterMs: number;
}): string | undefined {
  const sessionFile = resolveSessionFileFromIndex(params.indexFile, params.sessionKey);
  if (!sessionFile) {
    return undefined;
  }
  let latest: { timeMs: number; text: string } | undefined;
  try {
    for (const line of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (row.type !== "message" || !row.message || typeof row.message !== "object") {
        continue;
      }
      const message = row.message as Record<string, unknown>;
      if (message.role !== "assistant" || message.proactiveReply) {
        continue;
      }
      const timeMs = parseMessageTimeMs(row, message);
      if (timeMs < params.afterMs) {
        continue;
      }
      const { text, hasToolCall } = extractTextContent(message.content);
      if (hasToolCall || !isUsableChannelReply(text)) {
        continue;
      }
      if (!latest || timeMs >= latest.timeMs) {
        latest = { timeMs, text };
      }
    }
  } catch {
    return undefined;
  }
  return latest?.text;
}

async function waitForFinalAssistantText(params: {
  indexFile?: string;
  sessionKey: string;
  afterMs: number;
  timeoutMs?: number;
}): Promise<string | undefined> {
  if (!params.indexFile) {
    return undefined;
  }
  const deadline = Date.now() + (params.timeoutMs ?? FINAL_REPLY_WAIT_MS);
  while (Date.now() <= deadline) {
    const text = readLatestFinalAssistantText({
      indexFile: params.indexFile,
      sessionKey: params.sessionKey,
      afterMs: params.afterMs,
    });
    if (text) {
      return text;
    }
    await sleep(FINAL_REPLY_POLL_MS);
  }
  return undefined;
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
    title: params.request.title?.trim() || undefined,
    model: params.request.model?.trim() || undefined,
    explicitAgentId: Boolean(explicitAgentId),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function resolveActivityFilePath(): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), ".openclaw");
  return path.join(stateDir, "runtime", "proactive_reply_activity.json");
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmpPath, filePath);
}

function markNextChatUserActivity(session: NextChatSessionRecord): void {
  const filePath = resolveActivityFilePath();
  let state: any = { version: 1, sessions: {} };
  try {
    state = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    state = { version: 1, sessions: {} };
  }
  if (!state || typeof state !== "object" || !state.sessions || typeof state.sessions !== "object") {
    state = { version: 1, sessions: {} };
  }
  const now = Date.now();
  const entry = {
    channel: NEXTCHAT_CHANNEL,
    agentId: session.agentId,
    accountId: session.accountId,
    sessionId: session.sessionId,
    sessionKey: session.sessionKey,
    lastUserActivityAt: now,
    updatedAt: now,
  };
  state.version = 1;
  state.sessions[session.sessionKey] = entry;
  state.sessions[session.sessionKey.toLowerCase()] = entry;
  writeJsonAtomic(filePath, state);
}

function buildDebounceKey(prepared: PreparedNextChatDispatch): string {
  return prepared.session.sessionKey;
}

function mergeQueuedNextChatDispatches(items: QueuedNextChatDispatch[]): PreparedNextChatDispatch {
  const latest = items[items.length - 1].prepared;
  return {
    ...latest,
    rawBody: items
      .map((item) => item.prepared.rawBody)
      .filter(Boolean)
      .join("\n\n"),
    bodyForAgent: items
      .map((item) => item.prepared.bodyForAgent)
      .filter(Boolean)
      .join("\n\n"),
    hasMedia: items.some((item) => item.prepared.hasMedia),
  };
}

function createNextChatDebounceErrorResult(
  item: QueuedNextChatDispatch,
  error: unknown,
): NextChatDispatchResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    session: item.prepared.session,
    content: `[OpenClaw error] ${message.trim() || "NextChat inbound debounce failed."}`,
    mediaUrls: [],
    error: message,
  };
}

const nextchatInboundDebouncer = createInboundDebouncer<QueuedNextChatDispatch>({
  debounceMs: 0,
  buildKey: (item) => buildDebounceKey(item.prepared),
  resolveDebounceMs: (item) =>
    resolveInboundDebounceMs({
      cfg: item.prepared.cfg,
      channel: NEXTCHAT_CHANNEL,
    }),
  shouldDebounce: (item) =>
    shouldDebounceTextInbound({
      text: item.prepared.rawBody || item.prepared.bodyForAgent,
      cfg: item.prepared.cfg,
      hasMedia: item.prepared.hasMedia,
    }),
  serializeImmediate: true,
  onFlush: async (items) => {
    if (items.length === 0) {
      return;
    }
    const result = await dispatchPreparedNextChatMessage(mergeQueuedNextChatDispatches(items));
    for (const item of items) {
      item.resolve(result);
    }
  },
  onError: (error, items) => {
    for (const item of items) {
      item.resolve(createNextChatDebounceErrorResult(item, error));
    }
  },
});

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
  const startedAtMs = Date.now();
  let deliveredText = "";
  let deliveredMediaUrls: string[] = [];
  try {
    startNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messageId: clientMessageId,
      meta: {
        agentId: session.agentId,
        accountId: session.accountId,
      },
    });

    const dispatchResult = await dispatchInboundDirectDmWithRuntime({
      cfg,
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
        if (delta) {
          deliveredText = [deliveredText, delta].filter(Boolean).join("\n\n");
        }
        if (mediaUrls.length) {
          deliveredMediaUrls = [...deliveredMediaUrls, ...mediaUrls];
        }
        appendNextChatReplyDelta({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          messageId: clientMessageId,
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
          messageId: clientMessageId,
          error: `Failed to record session: ${String(error)}`,
        });
      },
      onDispatchError: (error) => {
        failNextChatReply({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          messageId: clientMessageId,
          error: String(error),
        });
      },
    });

    if (!isUsableChannelReply(deliveredText)) {
      const recoveredText = await waitForFinalAssistantText({
        indexFile: dispatchResult.storePath,
        sessionKey: session.sessionKey,
        afterMs: startedAtMs,
      });
      if (recoveredText && recoveredText.trim() !== deliveredText.trim()) {
        deliveredText = recoveredText.trim();
        appendNextChatReplyDelta({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          messageId: clientMessageId,
          delta: deliveredText,
        });
        if (prepared.writeDelta) {
          prepared.writeDelta(deliveredText);
        }
      }
    }

    const reply = completeNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messageId: clientMessageId,
    });
    return {
      session,
      content: reply?.content ?? deliveredText,
      mediaUrls: reply?.mediaUrls ?? deliveredMediaUrls,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const normalizedMessage = message.trim() || "OpenClaw dispatch failed.";
    failNextChatReply({
      sessionKey: session.sessionKey,
      sessionId: session.sessionId,
      messageId: clientMessageId,
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
    session.title = params.body.title?.trim() || session.title;
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
    markNextChatUserActivity(session);
    return await new Promise<NextChatDispatchResult>((resolve) => {
      void nextchatInboundDebouncer.enqueue({
        prepared: {
          cfg,
          session,
          rawBody: normalized.rawBody || bodyForAgent,
          bodyForAgent,
          clientMessageId,
          hasMedia: attachmentUrls.length > 0,
          stream: params.stream,
          writeDelta: params.writeDelta,
        },
        resolve,
      });
    });
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
