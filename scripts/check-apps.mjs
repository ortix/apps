#!/usr/bin/env node
// Validates every app's configuration against the platform rules.
// Usage: node scripts/check-apps.mjs
import { appsAt, readAppAt, validateApp } from "./lib/platform.mjs";

const problems = [];
const hosts = new Map();
for (const name of appsAt("WORKTREE")) {
	const app = readAppAt("WORKTREE", name);
	problems.push(...validateApp(app));
	const host = app.wrangler.routes?.[0]?.pattern;
	if (host && hosts.has(host)) problems.push(`${name}: host ${host} is also used by ${hosts.get(host)}`);
	if (host) hosts.set(host, name);
}

if (problems.length > 0) {
	console.error(`App configuration problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
	process.exit(1);
}
console.log(`All ${hosts.size} app(s) follow the platform rules.`);
