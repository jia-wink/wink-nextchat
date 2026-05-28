import { NextRequest, NextResponse } from "next/server";
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

  if (!body.stream) {
    return transformOpenClawJson(upstream);
  }

  return transformOpenClawStream(upstream);
}

type ParsedSseEvent = {
  event?: string;
  data: string;
};

type OpenClawPluginEvent = {
  type?: string;
  delta?: string;
  content?: string;
  error?: string;
};

type OpenAiChunk = {
  choices?: Array<{
    delta?: { content?: string };
    message?: { content?: string };
    finish_reason?: string | null;
  }>;
  error?: { message?: string } | string;
};

type NormalizedSsePayload = {
  delta?: string;
  finalContent?: string;
  error?: string;
  done?: boolean;
};

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
} as const;

function createOpenAiDeltaChunk(
  content: string,
  finishReason: string | null = null,
) {
  return `data: ${JSON.stringify({
    choices: [
      {
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  })}\n\n`;
}

function createDoneChunk() {
  return "data: [DONE]\n\n";
}

function findSseSeparator(buffer: string) {
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (crlfIndex >= 0) {
    return { index: crlfIndex, length: 4 };
  }

  const lfIndex = buffer.indexOf("\n\n");
  if (lfIndex >= 0) {
    return { index: lfIndex, length: 2 };
  }

  return undefined;
}

function parseSseEvent(block: string): ParsedSseEvent | undefined {
  const lines = block.split(/\r?\n/);
  let eventName: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  return {
    event: eventName,
    data: dataLines.join("\n"),
  };
}

function normalizeSsePayload(data: string): NormalizedSsePayload | undefined {
  const trimmed = data.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "[DONE]") {
    return { done: true };
  }

  let payload: OpenClawPluginEvent | OpenAiChunk;
  try {
    payload = JSON.parse(trimmed) as OpenClawPluginEvent | OpenAiChunk;
  } catch {
    return undefined;
  }

  const openClawPayload = payload as OpenClawPluginEvent;
  if (openClawPayload.type === "message.delta") {
    return { delta: openClawPayload.delta ?? "" };
  }
  if (openClawPayload.type === "message.completed") {
    return { finalContent: openClawPayload.content ?? "", done: true };
  }
  if (openClawPayload.type === "message.failed") {
    return {
      error: openClawPayload.error ?? "Unknown error",
      done: true,
    };
  }

  const openAiPayload = payload as OpenAiChunk;
  const choice = openAiPayload.choices?.[0];
  if (choice) {
    const delta = choice.delta?.content ?? choice.message?.content ?? "";
    return {
      delta,
      done: choice.finish_reason != null,
    };
  }
  if (openAiPayload.error) {
    const error =
      typeof openAiPayload.error === "string"
        ? openAiPayload.error
        : openAiPayload.error.message;
    return { error: error ?? "Unknown error", done: true };
  }

  return undefined;
}

async function transformOpenClawJson(upstream: Response) {
  if (!upstream.ok) {
    return withProxyHeaders(upstream);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    return withProxyHeaders(upstream);
  }

  const reader = upstream.body?.getReader();
  if (!reader) {
    return NextResponse.json({
      id: crypto.randomUUID(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "" },
          finish_reason: "stop",
        },
      ],
    });
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let responseText = "";
  let finalContent: string | undefined;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let separator = findSseSeparator(buffer);
    while (separator) {
      const rawBlock = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const parsed = parseSseEvent(rawBlock);
      if (parsed) {
        const payload = normalizeSsePayload(parsed.data);
        if (payload?.delta) {
          responseText += payload.delta;
        }
        if (payload?.finalContent !== undefined) {
          finalContent = payload.finalContent || responseText;
          break;
        }
        if (payload?.error) {
          finalContent = responseText
            ? `${responseText}\n\n[OpenClaw error] ${payload.error}`
            : `[OpenClaw error] ${payload.error}`;
          break;
        }
        if (payload?.done) {
          finalContent = responseText;
          break;
        }
      }
      separator = findSseSeparator(buffer);
    }

    if (finalContent !== undefined) {
      break;
    }
  }

  return NextResponse.json({
    id: crypto.randomUUID(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: finalContent ?? responseText,
        },
        finish_reason: "stop",
      },
    ],
  });
}

function transformOpenClawStream(upstream: Response) {
  if (!upstream.ok || !upstream.body) {
    return withProxyHeaders(upstream);
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("text/event-stream")) {
    return withProxyHeaders(upstream);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.body!.getReader();
      let buffer = "";
      let accumulatedContent = "";
      let finished = false;

      const closeWithDone = () => {
        if (finished) return;
        finished = true;
        controller.enqueue(encoder.encode(createOpenAiDeltaChunk("", "stop")));
        controller.enqueue(encoder.encode(createDoneChunk()));
        controller.close();
      };

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            closeWithDone();
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          let separator = findSseSeparator(buffer);

          while (separator) {
            const rawBlock = buffer.slice(0, separator.index);
            buffer = buffer.slice(separator.index + separator.length);
            const parsed = parseSseEvent(rawBlock);
            if (!parsed) {
              separator = findSseSeparator(buffer);
              continue;
            }

            const payload = normalizeSsePayload(parsed.data);
            if (!payload) {
              separator = findSseSeparator(buffer);
              continue;
            }

            if (payload.delta) {
              accumulatedContent += payload.delta;
              controller.enqueue(
                encoder.encode(createOpenAiDeltaChunk(payload.delta, null)),
              );
            }

            if (payload.finalContent !== undefined) {
              const finalContent = payload.finalContent || accumulatedContent;
              if (finalContent && finalContent !== accumulatedContent) {
                const suffix = finalContent.slice(accumulatedContent.length);
                if (suffix) {
                  controller.enqueue(
                    encoder.encode(createOpenAiDeltaChunk(suffix, null)),
                  );
                }
              }
              closeWithDone();
              return;
            }

            if (payload.error) {
              const errorText = `[OpenClaw error] ${payload.error}`;
              controller.enqueue(
                encoder.encode(createOpenAiDeltaChunk(errorText, null)),
              );
              closeWithDone();
              return;
            }

            if (payload.done) {
              closeWithDone();
              return;
            }

            separator = findSseSeparator(buffer);
          }
        }
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
      }
    },
  });

  return new Response(stream, {
    status: upstream.status,
    headers: SSE_HEADERS,
  });
}
