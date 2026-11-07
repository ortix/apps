#!/usr/bin/env node
// Decides whether a change can merge and deploy without the owner looking at it.
// CI runs the copy of this file from main, never the copy on the branch, and it
// only reads the branch's files through git; it never executes them.
//
// Usage: node scripts/ship-gate.mjs <base-rev> <head-rev>
// Prints JSON: { "ok": boolean, "reasons": string[], "apps": string[] }
import { appOfPath, appsAt, changedFiles, protectedFields, readAppAt, SENSITIVE_PATHS, validateApp } from "./lib/platform.mjs";

/** Paths an automatic merge may change at all. Everything else waits for the owner. */
const ALLOWED_PATHS = [/^apps\/[^/]+\//, /^templates\//, /^docs\//, /^package-lock\.json$/, /^README\.md$/];

export function gate(base, head) {
	const reasons = [];
	const files = changedFiles(base, head);
	const baseApps = new Set(appsAt(base));
	const touched = new Set();

	for (const { status, path } of files) {
		if (SENSITIVE_PATHS.some((re) => re.test(path))) {
			reasons.push(`${path} is part of the platform's guardrails`);
			continue;
		}
		if (!ALLOWED_PATHS.some((re) => re.test(path))) {
			reasons.push(`${path} is outside the paths an automatic merge may change`);
			continue;
		}
		const app = appOfPath(path);
		if (app) touched.add(app);
		if (status === "D" && app && baseApps.has(app) && path === `apps/${app}/wrangler.jsonc`) {
			reasons.push(`apps/${app} is a live app and would be deleted`);
		}
	}

	const deployable = [];
	for (const name of touched) {
		const before = baseApps.has(name) ? readAppAt(base, name) : undefined;
		const after = readAppAt(head, name);
		if (!after) continue;
		const problems = validateApp(after);
		reasons.push(...problems);
		if (before) {
			const protectedVars = before.pkg?.platform?.protectedVars ?? [];
			const was = JSON.stringify(protectedFields(before.wrangler, protectedVars));
			const now = JSON.stringify(protectedFields(after.wrangler, protectedVars));
			if (was !== now) reasons.push(`apps/${name}: changes its Worker name, domain, storage bindings or protected vars`);
			if (before.pkg?.platform?.autoDeploy === false && after.pkg?.platform?.autoDeploy !== false) {
				reasons.push(`apps/${name}: turns on automatic deploys, which needs the owner's go-ahead`);
			}
			if (JSON.stringify(before.pkg?.platform?.protectedVars ?? []) !== JSON.stringify(after.pkg?.platform?.protectedVars ?? [])) {
				reasons.push(`apps/${name}: changes platform.protectedVars`);
			}
		}
		if (after.pkg?.platform?.autoDeploy !== false && problems.length === 0) deployable.push(name);
	}

	return { ok: reasons.length === 0, reasons, apps: deployable.sort() };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [base, head] = process.argv.slice(2);
	if (!base || !head) {
		console.error("Usage: node scripts/ship-gate.mjs <base-rev> <head-rev>");
		process.exit(2);
	}
	console.log(JSON.stringify(gate(base, head)));
}
