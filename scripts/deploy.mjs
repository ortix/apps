#!/usr/bin/env node
// Deploys apps to production, then smoke-tests them. Runs only in the
// "production" GitHub Environment, from main.
//
// Usage: node scripts/deploy.mjs [--base <rev>] <app> [<app> ...]
//   --base: the last deployed revision. Apps that did not exist there are new,
//           and a new app may not take over a Worker or hostname that already exists.
//
// Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Never prints them, and
// never sets, changes or deletes Worker secrets: `wrangler deploy` leaves them as they are.
import { spawnSync } from "node:child_process";
import { appsAt, readAppAt, validateApp } from "./lib/platform.mjs";
import { smokeApp } from "./smoke.mjs";

const args = process.argv.slice(2);
let base;
const names = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--base") base = args[++i];
	else names.push(args[i]);
}

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) {
	console.error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set.");
	process.exit(2);
}

async function cf(path) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = await response.json().catch(() => ({}));
	return { status: response.status, body };
}

const existedAtBase = new Set(base ? appsAt(base) : []);
const failures = [];

for (const name of names) {
	console.log(`::group::Deploy ${name}`);
	try {
		const app = readAppAt("WORKTREE", name);
		if (!app) throw new Error(`apps/${name} does not exist`);
		const problems = validateApp(app);
		if (problems.length > 0) throw new Error(problems.join("; "));
		const host = app.wrangler.routes[0].pattern;

		// Never take over a hostname that another Worker already serves.
		const domains = await cf(`/workers/domains?hostname=${encodeURIComponent(host)}`);
		if (domains.status !== 200) throw new Error(`could not list Custom Domains (HTTP ${domains.status})`);
		const other = (domains.body.result ?? []).find((d) => d.hostname === host && d.service !== name);
		if (other) throw new Error(`${host} is already attached to Worker "${other.service}"; refusing to move it`);

		// A new app must not overwrite a Worker this repo didn't create.
		if (base && !existedAtBase.has(name)) {
			const existing = await cf(`/workers/scripts/${encodeURIComponent(name)}/settings`);
			if (existing.status === 200) throw new Error(`a Worker named "${name}" already exists in the account; pick another name`);
		}

		const result = spawnSync("npx", ["wrangler", "deploy", "--strict"], { cwd: `apps/${name}`, stdio: "inherit", env: process.env });
		if (result.status !== 0) throw new Error(`wrangler deploy exited with ${result.status}`);

		await smokeApp(app, { retries: existedAtBase.has(name) ? 6 : 30 });
		console.log(`Deployed and verified https://${host}`);
	} catch (error) {
		failures.push(name);
		console.log(`::error title=Deploy ${name} failed::${error.message}`);
	} finally {
		console.log("::endgroup::");
	}
}

if (failures.length > 0) {
	console.error(`Failed: ${failures.join(", ")}`);
	process.exit(1);
}
