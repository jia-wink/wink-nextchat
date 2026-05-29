import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/core";
import { nextchatPlugin } from "./src/channel.js";
import { authorizeNextChatRequest } from "./src/auth.js";
import {
  dispatchNextChatMessage,
  handleNextChatSessionRequest,
  listNextChatAgentsAndModels,
} from "./src/inbound.js";
import {
  appendNextChatEvent,
  appendNextChatReplyDelta,
  completeNextChatReply,
  setNextChatRuntime,
  getNextChatRuntimeStats,
  getNextChatSession,
  listNextChatEvents,
  listNextChatSessions,
  subscribeNextChatEvents,
  startNextChatReply,
  upsertNextChatSession,
} from "./src/runtime.js";
import type { NextChatSessionRecord } from "./src/types.js";

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(payload));
}

function sendInvalidRequest(res: ServerResponse, message: string) {
  sendJson(res, 400, {
    error: true,
    message,
  });
}

function sendMethodNotAllowed(res: ServerResponse, allow: string) {
  res.statusCode = 405;
  res.setHeader("Allow", allow);
  sendJson(res, 405, {
    error: true,
    message: "Method Not Allowed",
  });
}

function setSseHeaders(res: ServerResponse) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
}

function writeDone(res: ServerResponse) {
  if (!res.writableEnded) {
    res.write("data: [DONE]\n\n");
  }
}

function writeNamedSse(res: ServerResponse, event: string, payload: unknown) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function writeOpenAiDelta(res: ServerResponse, payload: { model: string; content: string }) {
  res.write(
    `data: ${JSON.stringify({
      id: `chatcmpl_${randomUUID()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: payload.model,
      choices: [
        {
          index: 0,
          delta: {
            content: payload.content,
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  );
}

function buildOpenAiJsonCompletion(params: { model: string; content: string }) {
  return {
    id: `chatcmpl_${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: params.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: params.content,
        },
        finish_reason: "stop",
      },
    ],
  };
}

function normalizeText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

function normalizeNextChatId(value: unknown): string | undefined {
  const text = normalizeText(value);
  if (!text) {
    return undefined;
  }
  return text.replace(/^nextchat:/i, "");
}

function resolveSessionFromRuntime(params: {
  sessionKey?: string;
  sessionId?: string;
  target?: string;
}): NextChatSessionRecord | undefined {
  const sessionKey = normalizeText(params.sessionKey);
  if (sessionKey) {
    const direct = getNextChatSession({ sessionKey });
    if (direct) {
      return direct;
    }
  }
  const candidates = [
    normalizeNextChatId(params.sessionId),
    normalizeNextChatId(params.target),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const direct = getNextChatSession({ sessionId: candidate });
    if (direct) {
      return direct;
    }
    const lowered = candidate.toLowerCase();
    const found = listNextChatSessions().find((session) => {
      return (
        session.sessionId.toLowerCase() === lowered ||
        session.sessionKey.toLowerCase() === lowered ||
        session.sessionKey.toLowerCase().endsWith(`:${lowered}`)
      );
    });
    if (found) {
      return found;
    }
  }
  return undefined;
}

function parseSessionKey(sessionKey: string): {
  agentId: string;
  accountId: string;
  sessionId: string;
} | undefined {
  const parts = sessionKey.split(":");
  if (parts.length < 5 || parts[0] !== "agent" || parts[2] !== "nextchat") {
    return undefined;
  }
  if (parts[3] === "direct" || parts[3] === "group") {
    return {
      agentId: parts[1],
      accountId: "default",
      sessionId: parts.slice(4).join(":"),
    };
  }
  return {
    agentId: parts[1],
    accountId: parts[3] || "default",
    sessionId: parts.slice(4).join(":"),
  };
}

function ensureProactiveSession(params: Record<string, unknown>): NextChatSessionRecord | undefined {
  const existing = resolveSessionFromRuntime({
    sessionKey: normalizeText(params.sessionKey),
    sessionId: normalizeText(params.sessionId),
    target: normalizeText(params.target),
  });
  if (existing) {
    return existing;
  }

  const sessionKey = normalizeText(params.sessionKey);
  if (!sessionKey) {
    return undefined;
  }
  const parsed = parseSessionKey(sessionKey);
  if (!parsed) {
    return undefined;
  }
  const accountId = normalizeText(params.accountId) ?? parsed.accountId;
  const sessionId =
    normalizeNextChatId(params.sessionId) ??
    normalizeNextChatId(params.target) ??
    parsed.sessionId;
  const now = new Date().toISOString();
  const session: NextChatSessionRecord = {
    sessionId,
    sessionKey,
    conversationId: sessionKey,
    agentId: normalizeText(params.agentId) ?? parsed.agentId,
    accountId,
    channel: "nextchat",
    title: normalizeText(params.title),
    explicitAgentId: Boolean(normalizeText(params.agentId)),
    createdAt: now,
    updatedAt: now,
  };
  upsertNextChatSession(session);
  return session;
}

function registerNextChatGatewayMethods(api: any) {
  api.registerGatewayMethod("nextchat.send", async ({ params, respond }: any) => {
    try {
      const body = (params || {}) as Record<string, unknown>;
      const content = normalizeText(body.content) ?? normalizeText(body.message);
      if (!content) {
        return respond(false, { error: "content or message is required" });
      }
      const session = ensureProactiveSession(body);
      if (!session) {
        return respond(false, {
          error: "sessionKey or an active NextChat session is required",
        });
      }
      const reply = startNextChatReply({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messageId: normalizeText(body.messageId),
        meta: {
          agentId: session.agentId,
          accountId: session.accountId,
          source: "gateway",
          proactive: true,
        },
      });
      appendNextChatReplyDelta({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messageId: reply.messageId,
        delta: content,
      });
      completeNextChatReply({
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messageId: reply.messageId,
      });
      respond(true, {
        ok: true,
        channel: "nextchat",
        sessionKey: session.sessionKey,
        sessionId: session.sessionId,
        messageId: reply.messageId,
      });
    } catch (error: any) {
      respond(false, { error: error?.message ?? String(error) });
    }
  });
}

async function handleAgentsRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }
  sendJson(res, 200, listNextChatAgentsAndModels());
  return true;
}

async function handleSessionRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  const session = await handleNextChatSessionRequest(req, res);
  if (!session) {
    return true;
  }
  appendNextChatEvent(
    { sessionKey: session.sessionKey },
    {
      type: "session.created",
      sessionId: session.sessionId,
      meta: {
        agentId: session.agentId,
        accountId: session.accountId,
        channel: session.channel,
      },
    },
  );
  sendJson(res, 200, session);
  return true;
}

async function handleMessageRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, "POST");
    return true;
  }
  let body: { stream?: boolean } & Record<string, unknown>;
  let stream = true;
  try {
    const clonedChunks: Buffer[] = [];
    for await (const chunk of req) {
      clonedChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(clonedChunks).toString("utf8");
    body = raw ? (JSON.parse(raw) as { stream?: boolean } & Record<string, unknown>) : {};
    stream = body.stream !== false;
  } catch {
    sendInvalidRequest(res, "Invalid JSON payload.");
    return true;
  }

  if (stream) {
    setSseHeaders(res);
  }

  const result = await dispatchNextChatMessage({
    body,
    stream,
    writeDelta: stream
      ? (delta) => {
          writeOpenAiDelta(res, {
            model: "openclaw",
            content: delta,
          });
        }
      : undefined,
  });

  if (!result) {
    if (stream) {
      writeDone(res);
      res.end();
    } else {
      sendJson(res, 500, {
        error: {
          message: "Failed to dispatch NextChat message.",
          type: "server_error",
        },
      });
    }
    return true;
  }

  if (stream) {
    writeDone(res);
    res.end();
  } else {
    if (result.error) {
      sendJson(res, 500, {
        error: {
          message: result.error,
          type: "server_error",
        },
      });
      return true;
    }
    sendJson(
      res,
      200,
      buildOpenAiJsonCompletion({
        model: `openclaw/${result.session.agentId}`,
        content: result.content,
      }),
    );
  }
  return true;
}

async function handleEventsRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey")?.trim() || undefined;
  const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
  if (!sessionKey && !sessionId) {
    sendJson(res, 400, { error: true, message: "sessionKey or sessionId is required" });
    return true;
  }
  setSseHeaders(res);
  res.write("retry: 1000\n\n");
  for (const event of listNextChatEvents({ sessionKey, sessionId })) {
    writeNamedSse(res, event.type, event);
  }
  const unsubscribe = subscribeNextChatEvents({ sessionKey, sessionId }, (event) => {
    if (!res.writableEnded) {
      writeNamedSse(res, event.type, event);
    }
  });
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  return true;
}

async function handleHistoryRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const sessionKey = url.searchParams.get("sessionKey")?.trim() || undefined;
  const sessionId = url.searchParams.get("sessionId")?.trim() || undefined;
  sendJson(res, 200, {
    sessionKey,
    sessionId,
    events: listNextChatEvents({ sessionKey, sessionId }),
  });
  return true;
}

async function handleHealthRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "POST") {
    sendMethodNotAllowed(res, "GET, POST");
    return true;
  }
  const auth = authorizeNextChatRequest(req, res);
  if (!auth.ok) {
    return true;
  }
  try {
    sendJson(res, 200, {
      ok: true,
      channel: "nextchat",
      accountId: auth.accountId,
      runtime: getNextChatRuntimeStats(),
      catalog: listNextChatAgentsAndModels(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    sendJson(res, 200, {
      ok: false,
      channel: "nextchat",
      accountId: auth.accountId,
      runtime: getNextChatRuntimeStats(),
      error: String(error),
      timestamp: new Date().toISOString(),
    });
  }
  return true;
}

export default defineChannelPluginEntry({
  id: "nextchat",
  name: "NextChat",
  description: "NextChat bridge channel plugin",
  plugin: nextchatPlugin,
  setRuntime: setNextChatRuntime,
  registerFull(api) {
    registerNextChatGatewayMethods(api);
    api.registerHttpRoute({
      path: "/api/channels/nextchat",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname === "/api/channels/nextchat/health") {
          return await handleHealthRequest(req, res);
        }
        const auth = authorizeNextChatRequest(req, res);
        if (!auth.ok) {
          return true;
        }
        if (pathname === "/api/channels/nextchat/agents") {
          return await handleAgentsRequest(req, res);
        }
        if (pathname === "/api/channels/nextchat/session") {
          return await handleSessionRequest(req, res);
        }
        if (pathname === "/api/channels/nextchat/message") {
          return await handleMessageRequest(req, res);
        }
        if (pathname === "/api/channels/nextchat/events") {
          return await handleEventsRequest(req, res);
        }
        if (pathname === "/api/channels/nextchat/history") {
          return await handleHistoryRequest(req, res);
        }
        return false;
      },
    });
  },
});
