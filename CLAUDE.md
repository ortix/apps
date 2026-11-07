# tsutsu.dev app platform

This repo holds Nick's personal apps. Each app is one Cloudflare Worker in `apps/<name>/`, served at `https://<name>.tsutsu.dev` behind Cloudflare Access (only Nick's GitHub login gets in). GitHub Actions deploys; you never deploy yourself.

When Nick says "build me X", follow **Build an app** below from start to finish without stopping to ask, except where a hard rule says to ask.

## Hard rules

1. **Never delete or overwrite anything you didn't create in this session.** That covers apps, Workers, domains, KV namespaces, D1 databases, R2 buckets, branches, PRs and files.
2. **Never change an existing app's Worker name, domain, storage bindings or ids, secrets, or `platform.protectedVars` without asking Nick first.** The ship gate holds such changes for Nick anyway.
3. **Never touch `*.home.tsutsu.dev`** or anything for the Mac mini.
4. **Never print, log or commit a secret.** Before every commit, run `git diff --cached` and check that it has no tokens, keys, passwords or `.dev.vars` content. Secret values never go in `wrangler.jsonc` `vars`.
5. **Ask Nick before anything that costs money or needs a new third-party account or API key.** That includes paid Cloudflare features, Workers AI, and any outside API. Build what you can without it, and say what's missing.
6. **Deploy only through CI.** Never run `wrangler deploy`, `wrangler secret`, `wrangler delete`, or a manual workflow dispatch.
7. **Never edit `.github/`, `.claude/`, `scripts/`, `CLAUDE.md` or the root `package.json`** as part of building an app. If the platform itself needs a change, do it in a separate PR and tell Nick it needs review.

## Build an app

### 1. Decide what to build
- Turn the request into a short spec: what it does, what's stored, and what's left out of the first version. Pick sensible defaults rather than asking.
- Keep the first version small enough to finish, test and ship in one session.

### 2. Pick the name
- Lowercase kebab-case, 3 to 32 characters, and short and obvious: `habits`, `reading-list`, `strava-mcp`. The name is also the Worker name and the subdomain.
- It's taken if `apps/<name>/` exists, if it's in `RESERVED_NAMES` in `scripts/lib/platform.mjs`, or if it starts with `template-`. Then pick a more specific name, such as `habit-streaks` instead of `habits`, and say so in the report. Never reuse or replace an existing app.
- A Worker with the same name may exist outside this repo. The deploy refuses to overwrite it, and the run fails with "already exists in the account". If that happens, rename the app in a new commit on the same branch.

### 3. Pick the template
- **`--mcp`** when the request is for Claude to use: "an MCP server", "a connector", "tools for Claude", "let Claude read/do X".
- **app** for anything a person uses in a browser.
- If it's both, build two apps.

### 4. Pick storage (only what's needed)
| Need | Use | Binding |
|---|---|---|
| Records you query, filter or join (habits, entries, lists) | D1 (SQLite) | `"d1_databases": [{ "binding": "DB" }]` |
| Settings, cached API responses, small lookups by key | KV | `"kv_namespaces": [{ "binding": "KV" }]` |
| Files and uploads (images, exports) | R2 | `"r2_buckets": [{ "binding": "FILES" }]` |
| Nothing kept between requests | none | |

- Leave the ids out. The first deploy creates the resource, and later deploys reuse it.
- Add each binding's type to `src/env.d.ts`.
- For D1, keep the schema in `migrations/0001_init.sql`, and create the tables on first use (`CREATE TABLE IF NOT EXISTS`), because you can't run `wrangler d1 migrations apply` against production.

### 5. Scaffold
```bash
git checkout -b claude/<name> origin/main
npm run new-app -- <name>          # or: npm run new-app -- <name> --mcp
npm install
```
Then edit `apps/<name>/`:
- `src/`: the app. Pages are server-rendered Hono JSX in `src/index.tsx`, and static files go in `public/`. Use plain CSS and small inline scripts. Only add a front-end framework if the app really needs one.
- `package.json`: set `platform.description` to one line about what the app does. Keep `platform.smoke` pointing at `/healthz`, or add checks.
- `wrangler.jsonc`: add bindings only. Leave the name, routes, `workers_dev` and `preview_urls` as generated.
- Read the user from Access with `currentUser(c)` in `src/access.ts`. Don't add login code, and don't remove `requireAccess()`.

### 6. Test
- Write tests in `apps/<name>/test/` for the main behaviour, not just that a page loads. Tests run in the real Workers runtime, with local D1, KV and R2.
- Run `npm run check` from the repo root. It checks app config, typechecks and tests everything, and must pass before you push.
- Try it locally if it helps: `npm run dev -w apps/<name>`. Access is simulated there.

### 7. Ship (through CI only)
```bash
git add apps/<name> package-lock.json
git diff --cached          # check for secrets (hard rule 4)
git commit -m "Add <name>: <one line>"
git push -u origin claude/<name>
gh api repos/ortix/apps/pulls -f head=claude/<name> -f base=main -f title="Add <name>" -f body="<what it does>" --jq .number
node scripts/ship-status.mjs <pr-number> --wait
```
- Use `gh api` for everything on GitHub. `gh pr` and `gh repo` don't work in cloud sessions.
- What happens next:
  1. CI typechecks and tests everything, and scans for secrets.
  2. The ship gate checks the PR against the rules. If it passes, the PR is merged.
  3. The deploy job tests the app again, deploys it to `https://<name>.tsutsu.dev` and smoke-tests it.
- `ship-status.mjs` reports each step. It exits 0 when deployed, 1 on failure, and 3 when the PR waits for Nick.
- **If CI fails:** fix it on the same branch and push again, then re-run `ship-status.mjs`.
- **If the gate holds the PR:** stop and include its reasons in the report. Nick reviews and merges it.
- **If the deploy fails:** read the job log with `gh api repos/ortix/apps/actions/jobs/<job-id>/logs`. Fix it in a new PR on a new `claude/<name>-fix` branch, since the old branch was merged.

### 8. Verify the live app
- The deploy job's smoke test passing means the Worker is live on its domain and answers through Access. You can't log in through Access yourself.
- Check what you can: the deploy log, and that `curl -sI https://<name>.tsutsu.dev` answers with a redirect to `cloudflareaccess.com`. That shows Access is protecting it.
- Don't call it verified beyond what you actually checked.
- **For an MCP server:** the smoke test covers `/healthz` only. Nick checks the tools from claude.ai.

### 9. Report
End with exactly this, and nothing after it:

```
**<name>** — https://<name>.tsutsu.dev
<One or two sentences: what it does.>

Verified: <what you checked, e.g. "deployed by CI run <url>; smoke test passed; 12 tests pass">
Not done: <what's missing or left out of v1, or "nothing">
<For an MCP server, add: Add it in claude.ai → Settings → Connectors → Add custom connector → https://<name>.tsutsu.dev/mcp>
```

## Changing an existing app
- Branch `claude/<name>-<change>`, then follow steps 6–9.
- Changes to code, tests and `public/` ship automatically.
- The gate holds anything that touches the name, domain, storage bindings, protected vars, `autoDeploy`, or deletes an app.
- Apps with `"autoDeploy": false` in `package.json` (such as `garmin-mcp`) merge but don't deploy. Tell Nick to deploy them from the Actions tab.
- `garmin-mcp` has its own README. Don't rewrite its logic unless asked.

## Reference
- Layout:
  - `apps/<name>/`: live apps
  - `templates/app`, `templates/mcp`: starters, typechecked and tested in CI, never deployed
  - `scripts/`: guard scripts used by CI
  - `docs/`: setup and design notes
- Toolchain: TypeScript 7, Hono 4, Wrangler 4, Vitest 5 with `@cloudflare/vitest-plugin`. Versions are pinned. Don't upgrade them as part of building an app.
- Workflows:
  - `ci.yml`: checks on every PR
  - `ship.yml`: gate and merge for `claude/*` PRs. It always runs as it is on main.
  - `deploy.yml`: deploys from main using the `production` environment
- Secrets an app needs: list them in `wrangler.jsonc` as `"secrets": { "required": ["NAME"] }` and add a `.dev.vars.example`. Nick sets the values, and deploys fail clearly until they are set. Ask Nick first (hard rule 5).
