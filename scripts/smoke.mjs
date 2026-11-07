#!/usr/bin/env node
// Checks that a deployed app answers as declared in its package.json:
//   "platform": { "smoke": [{ "path": "/healthz", "status": 200, "contains": "ok" }] }
// Requests carry the Access service token from CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET, so apps behind Access can be checked.
//
// Usage: node scripts/smoke.mjs <app> [<app> ...]
import { readAppAt } from "./lib/platform.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function smokeApp(app, { retries = 6, delayMs = 10_000 } = {}) {
	const host = app.wrangler.routes[0].pattern;
	const headers = {};
	if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
		headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
		headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
	}
	for (const check of app.pkg.platform.smoke) {
		const url = `https://${host}${check.path}`;
		let last = "";
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				const response = await fetch(url, { headers, redirect: "manual" });
				const text = await response.text();
				const statusOk = response.status === check.status;
				const bodyOk = !check.contains || text.includes(check.contains);
				if (statusOk && bodyOk) {
					console.log(`ok   ${url} -> ${response.status}`);
					last = "";
					break;
				}
				last = `${url} -> ${response.status}${bodyOk ? "" : ` (body lacks "${check.contains}")`}`;
			} catch (error) {
				// New Custom Domains take a minute or two to get DNS and a certificate.
				last = `${url} -> ${error.cause?.code ?? error.message}`;
			}
			if (attempt < retries) await sleep(delayMs);
		}
		if (last) throw new Error(`smoke test failed: ${last}, expected ${check.status}`);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	let failed = false;
	for (const name of process.argv.slice(2)) {
		const app = readAppAt("WORKTREE", name);
		try {
			await smokeApp(app, { retries: 1 });
		} catch (error) {
			failed = true;
			console.error(`${name}: ${error.message}`);
		}
	}
	process.exit(failed ? 1 : 0);
}
