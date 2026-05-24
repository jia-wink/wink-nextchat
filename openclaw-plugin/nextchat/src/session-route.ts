export function normalizeNextChatTarget(target: string): string | undefined {
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^nextchat:/i, "");
}

export function createNextChatSessionKey(params: {
  agentId: string;
  sessionId: string;
  accountId?: string;
}): string {
  const safeSessionId = params.sessionId.replace(/[^a-zA-Z0-9:_-]/g, "-");
  const safeAccountId = (params.accountId ?? "default").replace(/[^a-zA-Z0-9:_-]/g, "-");
  return `agent:${params.agentId}:nextchat:${safeAccountId}:${safeSessionId}`;
}
