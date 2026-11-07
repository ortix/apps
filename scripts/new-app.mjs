#!/usr/bin/env node
// Scaffolds apps/<name> from a template.
// Usage: npm run new-app -- <name> [--mcp]
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESERVED_NAMES, ZONE } from "./lib/platform.mjs";

const args = process.argv.slice(2);
const kind = args.includes("--mcp") ? "mcp" : "app";
const name = args.find((arg) => !arg.startsWith("--"));

function fail(message) {
	console.error(message);
	process.exit(1);
}

if (!name) fail("Usage: npm run new-app -- <name> [--mcp]");
if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) fail(`"${name}" must be 3-32 characters of a-z, 0-9 and "-", starting with a letter.`);
if (RESERVED_NAMES.has(name)) fail(`"${name}" is reserved. Pick another name.`);
if (name.startsWith("template-")) fail(`"${name}" would clash with the templates.`);
const target = join("apps", name);
if (existsSync(target)) fail(`${target} already exists. Pick another name, or change that app instead.`);

const source = join("templates", kind);
const placeholder = `template-${kind}`;
cpSync(source, target, { recursive: true, filter: (path) => !/(^|\/)(node_modules|\.wrangler)(\/|$)/.test(path) });

const TEXT = /\.(json|jsonc|ts|tsx|css|html|md|txt)$/;
function rewrite(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) rewrite(path);
		else if (TEXT.test(entry)) {
			const before = readFileSync(path, "utf8");
			const after = before.replaceAll(placeholder, name);
			if (after !== before) writeFileSync(path, after);
		}
	}
}
rewrite(target);

console.log(`Created ${target} from templates/${kind}.
It will be served at https://${name}.${ZONE}.

Next:
  npm install
  npm run typecheck -w ${target} && npm test -w ${target}`);
