import type { ChannelConfigSchema } from "openclaw/plugin-sdk/core";

export const NextChatConfigSchema: ChannelConfigSchema = {
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      enabled: { type: "boolean" },
      publicBaseUrl: { type: "string" },
      sharedSecret: { type: "string" },
      allowOrigins: {
        type: "array",
        items: { type: "string" },
      },
      streamMode: {
        type: "string",
        enum: ["sse"],
      },
      defaultAgentId: { type: "string" },
      sessionTtl: { type: "number" },
      historySyncLimit: { type: "number" },
      accounts: {
        type: "object",
        additionalProperties: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            sharedSecret: { type: "string" },
            allowOrigins: {
              type: "array",
              items: { type: "string" },
            },
            defaultAgentId: { type: "string" },
          },
        },
      },
    },
  },
  runtime: {
    safeParse(value) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return { success: true, data: value };
      }
      return {
        success: false,
        issues: [
          {
            path: [],
            message: "nextchat config must be an object",
          },
        ],
      };
    },
  },
};
