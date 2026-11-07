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

The order matters: the garmin-mcp bypass must exist **before** the wildcard, or claude.ai loses the connector.

1. **Zero Trust organization.** Open **Zero Trust** and choose a team name, for example `tsutsu`. Pick the **Free** plan. Cloudflare asks for payment details even for Free, but doesn't charge.
2. **GitHub login.**
   1. On GitHub, go to **Settings › Developer settings › OAuth Apps › New**.
      - Homepage: `https://<team>.cloudflareaccess.com`
      - Callback: `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`
   2. Then in **Zero Trust › Integrations › Identity providers › Add › GitHub**, paste its id and secret.
   3. Select **Test**.
3. **garmin-mcp bypass** (first). Go to **Access controls › Applications › Add › Self-hosted**.
   - Name `garmin-mcp (bypass)`, hostname `garmin-mcp.tsutsu.dev`.
   - Policy: action **Bypass**, include **Everyone**.
   - garmin-mcp runs its own OAuth with a numeric GitHub id allowlist, so it stays protected.
4. **Wildcard for all apps.** Add another **Self-hosted** application.
   - Name `tsutsu.dev apps`, hostname `*.tsutsu.dev`.
   - Policy `owner`, action **Allow**:
     - Include **Emails**: the primary email of your GitHub account.
     - Require **Login Methods**: GitHub.
     - Access can't match a numeric GitHub id. The email of your GitHub login is the closest stable identity.
   - Policy `ci-smoke`, action **Service Auth**: include **Service Token** `ci-smoke`.
   - Login methods: GitHub only, with **Instant authentication** on.
   - Leave **Managed OAuth** off for now. See "MCP servers and Access" below.
5. **Other subdomains.** Any other public `*.tsutsu.dev` hostname you already use, outside this repo, is now behind the login too. Give each one its own application with a Bypass policy if it must stay public. `*.home.tsutsu.dev` isn't affected, because it never goes through Cloudflare.

**How to check:**
- `curl -sI https://garmin-mcp.tsutsu.dev/mcp` should still answer `401` from the Worker, with a `WWW-Authenticate` header.
- A new app's URL should redirect to `<team>.cloudflareaccess.com`.

## 4. GitHub

Set up by the agent through the API, recorded here:
- **Private repo** `ortix/apps`.
- **Environment `production`:** only the `main` branch can deploy to it.
- **Ruleset on `main`:**
  - A pull request is required, with no reviewers needed.
  - The `checks` and `secrets` CI jobs must pass.
  - No force pushes and no deletion.
  - Repository admins can bypass, for emergencies.
- **Actions:** only GitHub's own actions and `gitleaks/gitleaks-action` are allowed. All are pinned to commit SHAs.

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

- **garmin-mcp:** keeps its own OAuth for now, behind the bypass.
- **New MCP servers** (from `templates/mcp`): these have no auth code and rely on Access **Managed OAuth**, which makes Access the OAuth server that claude.ai signs in to.
- **Before relying on it:** that path has to be tested once, by turning Managed OAuth on for one MCP app and connecting claude.ai. Until then, an MCP app built from the template returns 403 to claude.ai, because the wildcard sends it to the browser login.
