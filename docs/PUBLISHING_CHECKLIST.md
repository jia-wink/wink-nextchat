# Publishing Checklist

Use this checklist before publishing the repository.

## Must Remove Or Rotate

- Real OpenClaw gateway tokens:
  - `OPENCLAW_AUTH_TOKEN`
  - `OPENCLAW_SHARED_SECRET`
- Real model provider API keys:
  - `OPENAI_API_KEY`
  - `GOOGLE_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `SILICONFLOW_API_KEY`
  - `AI302_API_KEY`
  - any other provider key
- Real UI login passwords in `OPENCLAW_AUTH_USERS`.
- Real deployment access code in `CODE`.
- Personal domains such as production chat domains.
- Private network hostnames, Tailscale MagicDNS names, private IP addresses, and server names.
- Local machine paths such as `/Users/...`, `/www/wwwroot/...`, or personal upload directories.
- Private build artifacts such as `.next`, `out`, zip archives, screenshots with secrets, or local database/cache files.

If any real token was ever included in a file that may have been committed, pasted into a prompt, or shared, rotate it before publishing.

## Files That Should Stay Untracked

- `.env`
- `.env.local`
- `.env.production`
- `.env.development`
- `.env.test`
- `app/mcp/mcp_config.json`
- `masks.json`
- generated archives such as `*.zip`, `*.tar`, and `*.tar.gz`

## Recommended Checks

```bash
git status --short
rg -n "OPENCLAW_AUTH_TOKEN=|OPENCLAW_SHARED_SECRET=|sk-|ghp_|/Users/|taila|jiawink|83b54|chat\\.jiawink|mac-mini|100\\." .
yarn tsc --noEmit
node --no-warnings --experimental-vm-modules ./node_modules/.bin/jest --runInBand test/model-provider.test.ts test/model-available.test.ts
```

## GitHub Notes

- Create a new repository under your own GitHub account.
- Push only after checking `git diff --cached`.
- Do not enable old upstream sync workflows unless you intentionally maintain a fork.
- If you publish Docker images, update `.github/workflows/docker.yml` or keep it deleted.
- Keep production secrets in GitHub Actions/Vercel/your server environment variables, never in git.
