import type { IncomingMessage, ServerResponse } from "node:http";
import { loadNextChatConfigSnapshot } from "./runtime.js";

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  if (!res.headersSent) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
  }
  res.end(JSON.stringify(payload));
}

function resolveRequestAccountId(req: IncomingMessage): string {
  const url = new URL(req.url ?? "/", "http://localhost");
  const queryAccountId = url.searchParams.get("accountId")?.trim();
  const headerAccountId = String(req.headers["x-nextchat-account-id"] ?? "").trim();
  return queryAccountId || headerAccountId || "default";
}

export function authorizeNextChatRequest(req: IncomingMessage, res: ServerResponse) {
  const cfg = loadNextChatConfigSnapshot();
  const nextchat = (cfg.channels as Record<string, any> | undefined)?.nextchat ?? {};
  const accountId = resolveRequestAccountId(req);
  const accountConfig = nextchat.accounts?.[accountId] ?? {};
  const expected = String(
    accountConfig.sharedSecret ??
      nextchat.sharedSecret ??
      cfg.gateway?.auth?.token ??
      "",
  ).trim();
  const provided =
    String(req.headers["x-nextchat-secret"] ?? "").trim() ||
    String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();

  if (expected && provided !== expected) {
    sendJson(res, 401, {
      error: true,
      message: "Unauthorized",
    });
    return { ok: false as const };
  }

  const origin = String(req.headers.origin ?? "").trim();
  const allowOrigins = Array.isArray(accountConfig.allowOrigins)
    ? accountConfig.allowOrigins
    : Array.isArray(nextchat.allowOrigins)
      ? nextchat.allowOrigins
      : [];
  if (origin && allowOrigins.length > 0 && !allowOrigins.includes(origin)) {
    sendJson(res, 403, {
      error: true,
      message: "Origin not allowed",
    });
    return { ok: false as const };
  }

  return { ok: true as const, accountId };
}
