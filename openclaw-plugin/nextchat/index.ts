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
  setNextChatRuntime,
  getNextChatRuntimeStats,
  listNextChatEvents,
  subscribeNextChatEvents,
} from "./src/runtime.js";

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

function startSseHeartbeat(res: ServerResponse): ReturnType<typeof setInterval> {
  if (!res.writableEnded) {
    res.write(": keepalive\n\n");
  }
  return setInterval(() => {
    if (!res.writableEnded) {
      res.write(": keepalive\n\n");
    }
  }, 15000);
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

  const heartbeat = stream ? startSseHeartbeat(res) : undefined;
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
  }).finally(() => {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
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
  const heartbeat = startSseHeartbeat(res);
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
