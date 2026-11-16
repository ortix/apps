#!/usr/bin/env node
// Lists the apps a push to main should deploy: apps whose directory changed and
// that still exist, minus apps that opt out with platform.autoDeploy = false. Apps set to "code"
// do deploy here: this path is the owner merging a held change by hand.
// Usage: node scripts/changed-apps.mjs <base-rev> <head-rev>   (prints a JSON array)
import { appOfPath, appsAt, changedFiles, deployMode, readAppAt } from "./lib/platform.mjs";

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
const deploy = [...apps].filter((name) => deployMode(readAppAt(head, name)?.pkg) !== "off").sort();
console.log(JSON.stringify(deploy));
