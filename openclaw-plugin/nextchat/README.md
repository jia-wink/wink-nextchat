# OpenClaw NextChat Plugin

This plugin exposes OpenClaw agents through the `nextchat` channel used by Wink NextChat.

## Endpoints

- `/api/channels/nextchat/agents`
- `/api/channels/nextchat/session`
- `/api/channels/nextchat/message`
- `/api/channels/nextchat/events`
- `/api/channels/nextchat/history`
- `/api/channels/nextchat/health`

## Configuration

Add a `channels.nextchat` block to your OpenClaw config. Use strong production secrets and do not commit real values.

```json
{
  "channels": {
    "nextchat": {
      "sharedSecret": "replace-with-a-long-random-secret",
      "defaultAgentId": "main",
      "accounts": {
        "admin": {
          "agentId": "main"
        },
        "tarot": {
          "agentId": "tarot"
        }
      }
    }
  }
}
```

The Next.js app sends `x-nextchat-secret` and `x-nextchat-account-id` headers when talking to this plugin.
