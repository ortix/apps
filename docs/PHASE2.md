# Phase 2 (design only): private apps on the Mac mini

**Goal:** the same "build me X" flow, ending at `https://<name>.home.tsutsu.dev`, served from the Mac mini (192.168.1.101). These names resolve only at home and over Tailscale.

## Pieces

1. **Where the code lives.** Same repo, in a separate tree: `private/<name>/`.
   - Each app is a container with `Dockerfile`, `compose.yaml`, tests and a `platform.json` (`port`, `healthz`).
   - A third template, `templates/private`, provides a small Node or Go HTTP server with SQLite in a mounted volume.
   - The ship gate treats `private/**` like `apps/**`, so new apps merge automatically and changes to ports, volumes or hostnames are held for the owner.
2. **Build.** GitHub Actions builds a multi-arch image for each changed app and pushes it to GHCR as a private package, tagged by commit SHA. No secrets are needed for this, beyond the built-in `GITHUB_TOKEN` with `packages: write`.
3. **How CI reaches the Mac mini.**
   - The deploy job joins the tailnet as an ephemeral node using `tailscale/github-action`, with an OAuth client tagged `tag:ci`.
   - A Tailscale ACL lets `tag:ci` reach only `tag:macmini:22`.
   - On the Mac mini, a dedicated `deploy` user has a forced SSH command that only runs `deploy-app <name> <sha>`.
   - The tokens live in a separate GitHub environment, `home`, also limited to `main`.
4. **Run.**
   - `deploy-app` pulls the image and runs `docker compose up -d` for that app on the shared `proxy` network.
   - It waits for `/healthz` to pass, and otherwise rolls back to the previous tag.
   - Each app's data lives under `/srv/apps/<name>/` and is included in the Mac mini's backups.
5. **Routing and TLS.** Each app adds a site block to the existing reverse proxy.
   - With Caddy, that's one generated file per app in `conf.d/`, followed by a reload.
   - With Traefik, labels on the container do the same.
   - The existing `*.home.tsutsu.dev` certificate covers every name, so no new DNS or certificates are needed per app. Split DNS already points the wildcard at 192.168.1.101.
6. **Auth.** The tailnet and home network are the outer boundary, which is the same as today. Apps that need a user identity read it from the reverse proxy: Tailscale `tailscale serve` identity headers, or forward-auth to the proxy's existing auth.
7. **Agent side.** Same playbook, with a "private" branch: the cloud session builds and tests the container in its VM, then pushes through CI exactly as now. The agent never needs Tailscale access itself.

## Open questions

- **Reverse proxy.** Which one runs on the Mac mini (Caddy, Traefik, nginx), and is its configuration in a repo? This decides whether routing is a generated file or container labels.
- **Container runtime.** Is it Docker Desktop, OrbStack or Colima? It affects auto-start after reboots and whether it runs as a dedicated user.
- **Images.** Is a private GHCR package acceptable, or should images be built on the Mac mini itself? Building there means pulling the source instead, which is slower but keeps images off GitHub.
- **Tailscale.** Are you OK adding a CI OAuth client and tags to the tailnet ACLs? Tailscale's free plan covers this.
- **Identity.** Should private apps get a user identity at all, or is "on my network" enough?
- **Backups and data.** Where should per-app volumes live, and how should a removed app's data be archived rather than deleted?
- **Remote Control.** Should the Mac mini also run `claude remote-control` for tasks that need the home network directly (deferred; see the earlier comparison)?
