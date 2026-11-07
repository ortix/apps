# apps

Personal apps on `*.tsutsu.dev`. Each one is a Cloudflare Worker in `apps/<name>/`. They're behind Cloudflare Access, and GitHub Actions deploys them.

- **Build one from your phone:** open the Claude app › Code › repo `ortix/apps`, and say "build me …". The agent follows [CLAUDE.md](CLAUDE.md).
- **One-time setup:** tokens, Access, GitHub and the cloud environment are in [docs/SETUP.md](docs/SETUP.md).
- **Private apps on the Mac mini:** design only, in [docs/PHASE2.md](docs/PHASE2.md).

| Path | What |
|---|---|
| `apps/` | Live apps (`garmin-mcp`, …) |
| `templates/app`, `templates/mcp` | Starters for `npm run new-app -- <name> [--mcp]` |
| `scripts/` | Guard scripts: config checks, ship gate, deploy, smoke test |
| `.github/workflows/` | `ci.yml` (checks), `ship.yml` (gate and merge for `claude/*` PRs), `deploy.yml` (production) |

Run everything locally with `npm ci && npm run check`.
