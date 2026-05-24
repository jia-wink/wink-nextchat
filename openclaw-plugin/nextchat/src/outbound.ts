import { randomUUID } from "node:crypto";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  appendNextChatReplyDelta,
  completeNextChatReply,
  getNextChatSession,
  startNextChatReply,
} from "./runtime.js";
import type { ResolvedNextChatAccount } from "./types.js";

function ensureReply(sessionKey: string) {
  const session = getNextChatSession({ sessionKey });
  if (!session) {
    return undefined;
  }
  startNextChatReply({
    sessionKey,
    sessionId: session.sessionId,
    meta: {
      agentId: session.agentId,
      accountId: session.accountId,
      source: "outbound",
    },
  });
  return session;
}

function finalizeReply(sessionKey: string, sessionId: string) {
  completeNextChatReply({ sessionKey, sessionId });
}

export const nextchatOutboundAdapter: NonNullable<
  ChannelPlugin<ResolvedNextChatAccount>["outbound"]
> = {
  deliveryMode: "direct",
  textChunkLimit: 4000,
  sendText: async ({ to, text }) => {
    const session = ensureReply(to);
    if (session) {
      appendNextChatReplyDelta({
        sessionKey: to,
        sessionId: session.sessionId,
        delta: text,
      });
      finalizeReply(to, session.sessionId);
    }
    return {
      channel: "nextchat",
      messageId: randomUUID(),
    };
  },
  sendMedia: async ({ to, text, mediaUrl }) => {
    const session = ensureReply(to);
    if (session) {
      appendNextChatReplyDelta({
        sessionKey: to,
        sessionId: session.sessionId,
        delta: text ? `${text}\n\n![](${mediaUrl})` : `![](${mediaUrl})`,
        mediaUrls: [mediaUrl],
      });
      finalizeReply(to, session.sessionId);
    }
    return {
      channel: "nextchat",
      messageId: randomUUID(),
    };
  },
  sendPayload: async ({ to, payload }) => {
    const session = ensureReply(to);
    if (session) {
      const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
      const delta = [
        payload.text?.trim() || "",
        ...mediaUrls.map((url) => `![](${url})`),
      ]
        .filter(Boolean)
        .join("\n\n");
      appendNextChatReplyDelta({
        sessionKey: to,
        sessionId: session.sessionId,
        delta,
        mediaUrls,
      });
      finalizeReply(to, session.sessionId);
    }
    return {
      channel: "nextchat",
      messageId: randomUUID(),
    };
  },
};
