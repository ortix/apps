# One-time setup

Everything here is done once, by the owner. Agents never see the values. They live in the GitHub `production` environment, which only `main` can use.

## 1. Cloudflare API token for deploys → `CLOUDFLARE_API_TOKEN`

In the Cloudflare dashboard, go to **Manage Account › Account API Tokens › Create Token › Custom token**. Name it `github-actions-apps-deploy`.

| Scope | Permission | Why |
|---|---|---|
| Account › Workers | **Admin** (legacy name: Workers Scripts › Edit) | Creating a new Worker needs product-level Admin. Editor can only deploy Workers that already exist. CI only ever runs `wrangler deploy --strict`, so the delete rights go unused. |
| Account › Workers KV Storage | Edit | The first deploy of an app with a KV binding creates its namespace. |
| Account › D1 | Edit | The same, for D1 databases. |
| Account › Workers R2 Storage | Edit | The same, for R2 buckets. |
| Account › Account Settings | Read | Wrangler checks the account before deploying. |
| Zone › Workers Routes, **tsutsu.dev only** | Edit | Attaches each app's Custom Domain, `<name>.tsutsu.dev`. Cloudflare creates the DNS record and certificate. |
| Zone › Zone, **tsutsu.dev only** | Read | Wrangler looks up the zone of a Custom Domain. |

- **Not granted:** DNS edit, Access/Zero Trust, other zones, billing, members. Set no IP filter, because GitHub runners change IPs. A one-year expiry is a good default; put a reminder in your calendar.
- **Store it:** in GitHub, go to `ortix/apps` › **Settings › Environments › production › Environment secrets**, and add `CLOUDFLARE_API_TOKEN`.
- **Also add:** under **Environment variables**, add `CLOUDFLARE_ACCOUNT_ID`. It's an id, not a secret.

## 2. Access service token for smoke tests → `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET`

In **Zero Trust › Access controls › Service credentials › Service tokens › Create**, name it `ci-smoke` with no expiry or a one-year expiry.

- It lets CI fetch each app's `/healthz` through Access after a deploy. It can't do anything a browser visit couldn't.
- Add both values as `production` environment secrets.

## 3. Cloudflare Access (Zero Trust)

Team `nicktsutsu` (`https://nicktsutsu.cloudflareaccess.com`), with GitHub as the only login method. Set up on 2026-11-07, as recorded here:

1. **Zero Trust organization** on the Free plan. Cloudflare asks for payment details, but doesn't charge.
2. **GitHub login:** a GitHub OAuth app with the callback `https://nicktsutsu.cloudflareaccess.com/cdn-cgi/access/callback`, added under **Integrations › Identity providers › GitHub**.
3. **`tsutsu.dev apps`** (Self-hosted, hostname `*.tsutsu.dev`). This covers every app, garmin-mcp included. There's no bypass.
   - Policy `owner`, action **Allow**: include **Emails** = the owner's email, and require **Login Methods** = GitHub. Access can't match a numeric GitHub id, so the email is the identity.
   - GitHub is the only login method, with **Instant authentication** on.
   - **Managed OAuth** is on, so Access is the OAuth server that claude.ai signs in to for MCP servers:
     - Allowed redirect URIs (dynamic client registration): `https://claude.ai/api/mcp/auth_callback`
     - Access token lifetime: 15 min
     - Grant session duration: 30 days
   - Browsers get the GitHub login (302). MCP clients get a 401 that points at Access's OAuth metadata.
4. **`health checks`** (Self-hosted, hostname `*.tsutsu.dev`, path `healthz`). Policy `ci-smoke`, action **Service Auth**, with the `ci-smoke` service token. It's more specific than the wildcard, so the token works on `/healthz` and nowhere else.
5. **Other subdomains:** the wildcard covers every public `*.tsutsu.dev` hostname, not just this repo's apps, unless a hostname gets its own more specific application. `*.home.tsutsu.dev` isn't affected, because it never goes through Cloudflare.
   - **Before creating or changing the wildcard, list the zone's DNS records** (`GET /zones/<id>/dns_records`) and decide for each hostname outside `apps/` whether it belongs behind the login. Skipping this on 2026-11-07 broke the Home Assistant connector, whose hostname had its own OAuth.
   - **Hostnames outside this repo today:**
     - `ha-mcp.tsutsu.dev`: the Home Assistant MCP server, running on the Mac mini through the Cloudflare Tunnel `ha-mcp`. Intentionally behind this wildcard: claude.ai signs in through Access, and the tunnel's cloudflared verifies the Access token again. Its setup is in the `ortix/homeserver` repo, `docs/runbooks/ha-mcp.md`.

**How to check:**
- `curl -s -o /dev/null -w "%{http_code}" https://<app>.tsutsu.dev/healthz` answers `403` without the service token.
- `curl -sI -X POST https://<app>.tsutsu.dev/mcp` answers `401`, with a `WWW-Authenticate` header pointing at `/.well-known/cloudflare-access-protected-resource/mcp`.

## 4. GitHub

Set up by the agent through the API, recorded here:
- **Public repo** `ortix/apps`. It holds no secrets: those live only in the `production` environment. Workflow runs from outside contributors need approval.
- **Environment `production`:** only the `main` branch can deploy to it.
- **Ruleset on `main`:**
  - A pull request is required, with no reviewers needed.
  - The `checks` and `secrets` CI jobs must pass.
  - No force pushes and no deletion.
  - Repository admins can bypass only by merging a PR, never by pushing directly. Use the Claude GitHub App for cloud sessions, not `/web-setup` with your own token.
- **Actions:** only GitHub's own actions are allowed, and they must be pinned to commit SHAs. gitleaks is downloaded with a checksum check instead.

For you to do: install the **Claude GitHub App** on `ortix/apps` only. It's offered when you first open the repo at claude.ai/code. Don't give cloud sessions a personal access token.

## 5. Claude Code cloud environment (for building from your phone)

At claude.ai/code, create an environment named `apps` for the repo `ortix/apps`:
- **Network access:**
  - **Trusted** is enough: npm and GitHub are on the default list.
  - Optional: pick **Custom**, keep "include default list", and add `*.tsutsu.dev`. Agents can then confirm that a deployed app redirects to the Access login.
- **Environment variables:** none. No tokens go here.
- **Setup script:** none. The repo's SessionStart hook runs `npm ci`.
- **Permission mode:** start sessions in **Auto**. Bypass isn't available in cloud sessions. The repo's `.claude/settings.json` pre-approves the build, test and git commands, and denies deploy, secret and delete commands.

## 6. Workers plan

- **Free:** 10 ms CPU per request, 50 outside requests per request, 100,000 requests a day.
- **Paid ($5/month):** 30 s CPU by default (up to 5 min), 10,000 outside requests, 10 million requests a month included, 250 scheduled triggers instead of 5.
- garmin-mcp's uncached FIT parsing needs Paid to be reliable. The templates themselves work on Free.

## MCP servers and Access

- **Every MCP server** on the platform, garmin-mcp included, has no auth code of its own. Access Managed OAuth signs claude.ai in, and the Worker refuses any request without `ctx.access`.
- **This works with claude.ai.** It was tested with a throwaway `mcp-hello` server on 2026-11-07 (since deleted), then garmin-mcp moved to it.
- **A new MCP app needs no Access change.** Add it in claude.ai as a custom connector at `https://<name>.tsutsu.dev/mcp`, and sign in with GitHub.
