import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/core";
import { NextChatConfigSchema } from "./config-schema.js";
import { nextchatOutboundAdapter } from "./outbound.js";
import { createNextChatSessionKey, normalizeNextChatTarget } from "./session-route.js";
import { nextchatSetupAdapter } from "./setup-core.js";
import type { NextChatChannelConfig, ResolvedNextChatAccount } from "./types.js";

function resolveConfig(cfg: OpenClawConfig): NextChatChannelConfig {
  return ((cfg.channels as Record<string, unknown> | undefined)?.nextchat ??
    {}) as NextChatChannelConfig;
}

function resolveNextChatAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedNextChatAccount {
  const accountKey = accountId?.trim() || "default";
  const config = resolveConfig(cfg);
  const accountConfig = config.accounts?.[accountKey];
  const sharedSecret = accountConfig?.sharedSecret ?? config.sharedSecret;
  return {
    accountId: accountKey,
    enabled: accountConfig?.enabled ?? config.enabled ?? true,
    configured: Boolean(sharedSecret || config.publicBaseUrl),
    sharedSecret,
    publicBaseUrl: config.publicBaseUrl,
    allowOrigins: accountConfig?.allowOrigins ?? config.allowOrigins ?? [],
    defaultAgentId: accountConfig?.defaultAgentId ?? config.defaultAgentId,
    streamMode: config.streamMode ?? "sse",
    sessionTtl: config.sessionTtl,
    historySyncLimit: config.historySyncLimit,
  };
}

export const nextchatPlugin: ChannelPlugin<ResolvedNextChatAccount> = createChatChannelPlugin({
  base: {
    id: "nextchat",
    meta: {
      id: "nextchat",
      label: "NextChat",
      selectionLabel: "NextChat",
      detailLabel: "NextChat Bridge",
      docsPath: "/channels/nextchat",
      docsLabel: "nextchat",
      blurb: "Expose OpenClaw agents through a NextChat bridge.",
      order: 20,
    },
    capabilities: {
      chatTypes: ["direct"],
      reactions: false,
      threads: true,
      media: false,
      nativeCommands: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: ["channels.nextchat"] },
    configSchema: NextChatConfigSchema,
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: resolveNextChatAccount,
      defaultAccountId: () => "default",
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.publicBaseUrl,
        tokenStatus: account.sharedSecret ? "available" : "missing",
        mode: account.streamMode,
      }),
    },
    setup: nextchatSetupAdapter,
    status: {
      defaultRuntime: {
        accountId: "default",
        enabled: true,
        configured: false,
      },
      buildAccountSnapshot: async ({ account }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.publicBaseUrl,
        tokenStatus: account.sharedSecret ? "available" : "missing",
        mode: account.streamMode,
      }),
    },
    messaging: {
      normalizeTarget: normalizeNextChatTarget,
      resolveOutboundSessionRoute: ({ cfg, agentId, to }) => {
        const target = normalizeNextChatTarget(to) ?? to;
        const accountId = "default";
        const resolvedAgentId = agentId || resolveNextChatAccount(cfg).defaultAgentId || "main";
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId: resolvedAgentId,
          channel: "nextchat",
          peer: { kind: "direct", id: target },
          chatType: "direct",
          from: "nextchat",
          to: createNextChatSessionKey({
            agentId: resolvedAgentId,
            sessionId: target,
            accountId: accountId ?? undefined,
          }),
        });
      },
      targetResolver: {
        looksLikeId: (id) => Boolean(normalizeNextChatTarget(id)),
        hint: "<nextchat-session-id>",
      },
    },
  },
  security: {
    dm: {
      channelKey: "nextchat",
      resolvePolicy: () => "open",
      resolveAllowFrom: () => [],
      defaultPolicy: "open",
    },
  },
  threading: { topLevelReplyToMode: "reply" },
  outbound: nextchatOutboundAdapter,
});
