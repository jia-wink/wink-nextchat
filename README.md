# Wink NextChat

Wink NextChat is a browser chat UI wired to a private OpenClaw gateway. It keeps the normal multi-provider chat flow for visitors who bring their own API keys, and adds a protected OpenClaw mode for talking to local OpenClaw agents without exposing the gateway directly.

## What Is Included

- Next.js chat application with multi-provider model settings.
- OpenClaw bridge APIs under `app/api/openclaw`.
- OpenClaw client provider under `app/client/platforms/openclaw.ts`.
- OpenClaw channel plugin source under `openclaw-plugin/nextchat`.
- Server-side file upload bridge for OpenClaw context files under `app/api/files`.
- OpenClaw login gate with per-agent authorization.

## OpenClaw Access Model

Normal visitors can use the app in guest mode and configure their own API keys. OpenClaw mode requires login. Configure OpenClaw UI accounts with `OPENCLAW_AUTH_USERS`; no real username or password is stored in the source code.

Example account mapping:

| Username | Password | Access |
| --- | --- | --- |
| `admin` | `replace-me` | all OpenClaw agents |
| `tarot` | `replace-me-too` | `tarot` agent only |
| `chat` | `replace-me-three` | `chat` agent only |

Set them with `OPENCLAW_AUTH_USERS`:

```bash
OPENCLAW_AUTH_USERS='[
  {"username":"admin","password":"replace-me","agents":["*"]},
  {"username":"tarot","password":"replace-me-too","agents":["tarot"]},
  {"username":"chat","password":"replace-me-three","agents":["chat"]}
]'
```

## Quick Start

```bash
yarn install
cp .env.openclaw.production.template .env.local
yarn dev
```

Edit `.env.local` before starting if your OpenClaw gateway is not running on the defaults. Add `OPENCLAW_AUTH_USERS` locally before logging in to OpenClaw.

## Important Environment Variables

```bash
OPENCLAW_ENABLED=1
OPENCLAW_BRIDGE_URL=/api/openclaw
OPENCLAW_GATEWAY_URL=http://127.0.0.1:18789
OPENCLAW_AUTH_TOKEN=replace-with-your-openclaw-gateway-token
OPENCLAW_SHARED_SECRET=replace-with-your-nextchat-shared-secret
OPENCLAW_DEFAULT_AGENT_ID=main
NEXTCHAT_PUBLIC_BASE_URL=https://your-chat-domain.example.com
NEXTCHAT_UPLOAD_DIR=/var/lib/wink-nextchat/uploads
NEXTCHAT_OPENCLAW_PRESENCE_STORE=/var/lib/wink-nextchat/openclaw-presence.json
```

The real `.env.production`, `.env.local`, and other local environment files are intentionally ignored by git.

## OpenClaw Plugin

The plugin is stored in:

```text
openclaw-plugin/nextchat
```

It exposes the `nextchat` channel endpoints used by the Next.js bridge:

- `/api/channels/nextchat/agents`
- `/api/channels/nextchat/session`
- `/api/channels/nextchat/message`
- `/api/channels/nextchat/events`
- `/api/channels/nextchat/history`
- `/api/channels/nextchat/health`

Install or copy this plugin into your OpenClaw extension/plugin location according to your OpenClaw setup.

## Build And Test

```bash
yarn tsc --noEmit
node --no-warnings --experimental-vm-modules ./node_modules/.bin/jest --runInBand test/model-provider.test.ts test/model-available.test.ts
yarn build
```

## Before Publishing

Read [docs/PUBLISHING_CHECKLIST.md](docs/PUBLISHING_CHECKLIST.md) before pushing to GitHub. It lists secrets, local paths, domains, and account values that must be removed or rotated.

## Notes

- Do not expose your OpenClaw gateway directly to the public internet.
- Use a private network, reverse proxy, or Tailscale-like tunnel between the deployment server and OpenClaw.
- Rotate any token that has ever been committed, pasted into chat, or stored in a file that may be uploaded.
- Keep `OPENCLAW_AUTH_USERS` passwords unique and strong in production.
