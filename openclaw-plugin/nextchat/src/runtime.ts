import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { NextChatEvent, NextChatSessionRecord } from "./types.js";

const pluginRuntimeStore = createPluginRuntimeStore<PluginRuntime>(
  "NextChat runtime not initialized",
);

export const setNextChatRuntime = pluginRuntimeStore.setRuntime;

export function getNextChatRuntime() {
  return pluginRuntimeStore.getRuntime();
}

function resolveRawConfigPath(): string {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) {
    return explicit;
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) {
    return path.join(stateDir, "openclaw.json");
  }
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

export function loadNextChatConfigSnapshot(): OpenClawConfig {
  const configPath = resolveRawConfigPath();
  const raw = readFileSync(configPath, "utf8");
  return JSON5.parse(raw) as OpenClawConfig;
}

type SessionState = {
  session: NextChatSessionRecord;
  events: NextChatEvent[];
};

type ActiveReplyState = {
  sessionKey: string;
  messageId: string;
  content: string;
  mediaUrls: string[];
};

const runtime = {
  sessionsByKey: new Map<string, SessionState>(),
  sessionKeyById: new Map<string, string>(),
  emitter: new EventEmitter(),
  activeReplies: new Map<string, ActiveReplyState>(),
  lastEventAt: undefined as string | undefined,
};

function createReplyKey(input: { sessionKey: string; messageId: string }): string {
  return `${input.sessionKey}\u0000${input.messageId}`;
}

function resolveActiveReply(input: {
  sessionKey: string;
  messageId?: string;
}): ActiveReplyState | undefined {
  if (input.messageId) {
    return runtime.activeReplies.get(createReplyKey({
      sessionKey: input.sessionKey,
      messageId: input.messageId,
    }));
  }
  for (const reply of runtime.activeReplies.values()) {
    if (reply.sessionKey === input.sessionKey) {
      return reply;
    }
  }
  return undefined;
}

function deleteActiveReply(reply: ActiveReplyState | undefined): void {
  if (!reply) {
    return;
  }
  runtime.activeReplies.delete(createReplyKey({
    sessionKey: reply.sessionKey,
    messageId: reply.messageId,
  }));
}

function resolveSessionKey(input: { sessionKey?: string; sessionId?: string }): string | undefined {
  const explicit = input.sessionKey?.trim();
  if (explicit) {
    if (runtime.sessionsByKey.has(explicit)) {
      return explicit;
    }
    const lowered = explicit.toLowerCase();
    for (const key of runtime.sessionsByKey.keys()) {
      if (key.toLowerCase() === lowered) {
        return key;
      }
    }
    return explicit;
  }
  const sessionId = input.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const direct = runtime.sessionKeyById.get(sessionId);
  if (direct) {
    return direct;
  }
  const lowered = sessionId.toLowerCase();
  for (const [knownSessionId, key] of runtime.sessionKeyById.entries()) {
    if (knownSessionId.toLowerCase() === lowered) {
      return key;
    }
  }
  for (const [key, state] of runtime.sessionsByKey.entries()) {
    if (
      state.session.sessionId.toLowerCase() === lowered ||
      key.toLowerCase().endsWith(`:${lowered}`)
    ) {
      return key;
    }
  }
  return undefined;
}

export function upsertNextChatSession(session: NextChatSessionRecord): SessionState {
  const now = new Date().toISOString();
  const existing = runtime.sessionsByKey.get(session.sessionKey);
  const mergedSession: NextChatSessionRecord = {
    ...(existing?.session ?? {}),
    ...session,
    updatedAt: now,
  };
  const state: SessionState = existing ?? {
    session: mergedSession,
    events: [],
  };
  state.session = mergedSession;
  runtime.sessionsByKey.set(session.sessionKey, state);
  runtime.sessionKeyById.set(session.sessionId, session.sessionKey);
  runtime.sessionKeyById.set(session.sessionId.toLowerCase(), session.sessionKey);
  return state;
}

export function getNextChatSession(input: {
  sessionKey?: string;
  sessionId?: string;
}): NextChatSessionRecord | undefined {
  const sessionKey = resolveSessionKey(input);
  if (!sessionKey) {
    return undefined;
  }
  return runtime.sessionsByKey.get(sessionKey)?.session;
}

export function listNextChatSessions(): NextChatSessionRecord[] {
  return [...runtime.sessionsByKey.values()].map((entry) => entry.session);
}

export function appendNextChatEvent(
  input: { sessionKey?: string; sessionId?: string },
  event: NextChatEvent,
): void {
  const sessionKey = resolveSessionKey(input);
  if (!sessionKey) {
    return;
  }
  const state = runtime.sessionsByKey.get(sessionKey);
  if (!state) {
    return;
  }
  const nextEvent = {
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  };
  state.events.push(nextEvent);
  if (state.events.length > 500) {
    state.events.splice(0, state.events.length - 500);
  }
  runtime.lastEventAt = nextEvent.timestamp;
  runtime.emitter.emit(sessionKey, nextEvent);
}

export function listNextChatEvents(input: {
  sessionKey?: string;
  sessionId?: string;
}): NextChatEvent[] {
  const sessionKey = resolveSessionKey(input);
  if (!sessionKey) {
    return [];
  }
  return [...(runtime.sessionsByKey.get(sessionKey)?.events ?? [])];
}

export function subscribeNextChatEvents(
  input: { sessionKey?: string; sessionId?: string },
  listener: (event: NextChatEvent) => void,
): () => void {
  const sessionKey = resolveSessionKey(input);
  if (!sessionKey) {
    return () => undefined;
  }
  runtime.emitter.on(sessionKey, listener);
  return () => runtime.emitter.off(sessionKey, listener);
}

export function startNextChatReply(input: {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
  meta?: Record<string, unknown>;
}): ActiveReplyState {
  const reply: ActiveReplyState = {
    sessionKey: input.sessionKey,
    messageId: input.messageId?.trim() || randomUUID(),
    content: "",
    mediaUrls: [],
  };
  runtime.activeReplies.set(createReplyKey(reply), reply);
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "message.accepted",
      sessionId: input.sessionId,
      messageId: reply.messageId,
      meta: input.meta,
    },
  );
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "typing.start",
      sessionId: input.sessionId,
      messageId: reply.messageId,
    },
  );
  return reply;
}

export function appendNextChatReplyDelta(input: {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
  delta?: string;
  mediaUrls?: string[];
}): ActiveReplyState | undefined {
  const reply = resolveActiveReply(input);
  if (!reply) {
    return undefined;
  }
  const delta = input.delta ?? "";
  if (delta) {
    reply.content += delta;
    appendNextChatEvent(
      { sessionKey: input.sessionKey },
      {
        type: "message.delta",
        sessionId: input.sessionId,
        messageId: reply.messageId,
        delta,
      },
    );
  }
  if (input.mediaUrls?.length) {
    for (const mediaUrl of input.mediaUrls) {
      if (!reply.mediaUrls.includes(mediaUrl)) {
        reply.mediaUrls.push(mediaUrl);
      }
    }
  }
  return reply;
}

export function failNextChatReply(input: {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
  error: string;
}): void {
  const reply = resolveActiveReply(input);
  const messageId = reply?.messageId ?? input.messageId ?? randomUUID();
  deleteActiveReply(reply);
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "typing.stop",
      sessionId: input.sessionId,
      messageId,
    },
  );
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "message.failed",
      sessionId: input.sessionId,
      messageId,
      error: input.error,
    },
  );
}

export function completeNextChatReply(input: {
  sessionKey: string;
  sessionId: string;
  messageId?: string;
}): ActiveReplyState | undefined {
  const reply = resolveActiveReply(input);
  if (!reply) {
    return undefined;
  }
  deleteActiveReply(reply);
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "typing.stop",
      sessionId: input.sessionId,
      messageId: reply.messageId,
    },
  );
  appendNextChatEvent(
    { sessionKey: input.sessionKey },
    {
      type: "message.completed",
      sessionId: input.sessionId,
      messageId: reply.messageId,
      content: reply.content,
      mediaUrls: reply.mediaUrls,
    },
  );
  return reply;
}

export function getNextChatRuntimeStats() {
  return {
    sessions: runtime.sessionsByKey.size,
    activeReplies: runtime.activeReplies.size,
    lastEventAt: runtime.lastEventAt,
  };
}
