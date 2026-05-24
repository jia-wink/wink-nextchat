export type NextChatChannelConfig = {
  enabled?: boolean;
  publicBaseUrl?: string;
  sharedSecret?: string;
  allowOrigins?: string[];
  streamMode?: "sse";
  defaultAgentId?: string;
  sessionTtl?: number;
  historySyncLimit?: number;
  accounts?: Record<
    string,
    {
      enabled?: boolean;
      sharedSecret?: string;
      allowOrigins?: string[];
      defaultAgentId?: string;
    }
  >;
};

export type ResolvedNextChatAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  sharedSecret?: string;
  publicBaseUrl?: string;
  allowOrigins: string[];
  defaultAgentId?: string;
  streamMode: "sse";
  sessionTtl?: number;
  historySyncLimit?: number;
};

export type NextChatSessionRecord = {
  sessionId: string;
  sessionKey: string;
  conversationId: string;
  agentId: string;
  accountId: string;
  channel: "nextchat";
  title?: string;
  clientLabel?: string;
  model?: string;
  explicitAgentId?: boolean;
  createdAt: string;
  updatedAt?: string;
};

export type NextChatEvent = {
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

export type NextChatInboundAttachment = {
  url: string;
  mimeType?: string;
  name?: string;
};

export type NextChatInboundMessage = {
  role: string;
  content?: string | Array<{ type?: string; text?: string; image_url?: { url?: string } }>;
};

export type NextChatSessionRequest = {
  sessionId?: string;
  clientSessionId?: string;
  sessionKey?: string;
  accountId?: string;
  agentId?: string;
  defaultAgentId?: string;
  title?: string;
  clientLabel?: string;
  model?: string;
};

export type NextChatMessageRequest = NextChatSessionRequest & {
  stream?: boolean;
  clientMessageId?: string;
  messages?: NextChatInboundMessage[];
  attachments?: NextChatInboundAttachment[];
};
