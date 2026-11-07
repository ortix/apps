#!/usr/bin/env node
// Lists the apps a push to main should deploy: apps whose directory changed and
// that still exist, minus apps that opt out with platform.autoDeploy = false.
// Usage: node scripts/changed-apps.mjs <base-rev> <head-rev>   (prints a JSON array)
import { appOfPath, appsAt, changedFiles, readAppAt } from "./lib/platform.mjs";

const [base, head] = process.argv.slice(2);
if (!base || !head) {
	console.error("Usage: node scripts/changed-apps.mjs <base-rev> <head-rev>");
	process.exit(2);
}

const existing = new Set(appsAt(head));
const apps = new Set();
for (const { path } of changedFiles(base, head)) {
	const app = appOfPath(path);
	if (app && existing.has(app)) apps.add(app);
}
const deploy = [...apps].filter((name) => readAppAt(head, name)?.pkg?.platform?.autoDeploy !== false).sort();
console.log(JSON.stringify(deploy));
