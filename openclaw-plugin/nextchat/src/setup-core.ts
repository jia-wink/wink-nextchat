import type { ChannelSetupAdapter, OpenClawConfig } from "openclaw/plugin-sdk/core";

export const nextchatSetupAdapter: ChannelSetupAdapter = {
  applyAccountConfig(params): OpenClawConfig {
    const channels = (params.cfg.channels ?? {}) as Record<string, unknown>;
    const nextchat = (channels.nextchat ?? {}) as Record<string, unknown>;
    return {
      ...params.cfg,
      channels: {
        ...channels,
        nextchat: {
          ...nextchat,
          enabled: true,
          ...(params.input.httpUrl ? { publicBaseUrl: params.input.httpUrl } : {}),
          ...(params.input.token ? { sharedSecret: params.input.token } : {}),
          ...(params.input.name ? { defaultAgentId: params.input.name } : {}),
        },
      },
    };
  },
};
