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
import { readdirSync } from "node:fs";
import { appsAt, readAppAt, validateApp } from "./lib/platform.mjs";
import { smokeApp } from "./smoke.mjs";

const args = process.argv.slice(2);
let base;
const names = [];
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--base") base = args[++i];
	else names.push(args[i]);
}

const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, WRANGLER_BIN: wranglerBin } = process.env;
if (!token || !account || !wranglerBin) {
	console.error("CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID and WRANGLER_BIN must be set.");
	process.exit(2);
}

// Wrangler reads .env files from the project directory into its own
// environment, which could redirect its API calls and the token with them.
// Explicit values win over .env, and committed env files are refused outright.
const wranglerEnv = {
	...process.env,
	CLOUDFLARE_API_BASE_URL: "https://api.cloudflare.com/client/v4",
	CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
	WRANGLER_SEND_METRICS: "false",
};
const ENV_FILE = /^\.(env|dev\.vars)(\..*)?$/;
const envFiles = (dir) => readdirSync(dir).filter((file) => ENV_FILE.test(file) && !file.endsWith(".example"));

/** Every Worker this pipeline deploys carries this tag, so a retried deploy can tell its own Workers from anyone else's. */
const PLATFORM_TAG = "ortix-apps";

async function cf(path, init = {}) {
	const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${path}`, {
		...init,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
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

		// A new app must not overwrite a Worker this repo didn't create. A Worker
		// carrying the platform tag was created by an earlier attempt of this
		// pipeline (for example a deploy cancelled after upload), so it may be updated.
		const settingsPath = `/workers/scripts/${encodeURIComponent(name)}/script-settings`;
		const existing = await cf(settingsPath);
		const tags = existing.status === 200 ? (existing.body.result?.tags ?? []) : [];
		if (base && !existedAtBase.has(name) && existing.status === 200 && !tags.includes(PLATFORM_TAG)) {
			throw new Error(`a Worker named "${name}" already exists in the account and wasn't created by this repo; pick another name`);
		}

		const stray = [...envFiles("."), ...envFiles(`apps/${name}`)];
		if (stray.length > 0) throw new Error(`refusing to deploy with env files present: ${stray.join(", ")}`);

		const result = spawnSync(process.execPath, [wranglerBin, "deploy", "--strict"], { cwd: `apps/${name}`, stdio: "inherit", env: wranglerEnv });
		if (result.status !== 0) throw new Error(`wrangler deploy exited with ${result.status}`);

		const after = await cf(settingsPath);
		const currentTags = after.body.result?.tags ?? [];
		if (!currentTags.includes(PLATFORM_TAG)) {
			const tagged = await cf(settingsPath, { method: "PATCH", body: JSON.stringify({ tags: [...currentTags, PLATFORM_TAG] }) });
			if (tagged.status !== 200) console.log(`::warning::Could not tag ${name} as platform-managed (HTTP ${tagged.status})`);
		}

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
