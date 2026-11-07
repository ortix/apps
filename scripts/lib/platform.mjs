// Shared, dependency-free helpers for the platform's guard scripts.
// These run in CI from the main branch, before any npm install, so they must
// not import packages.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ZONE = "tsutsu.dev";
export const PRIVATE_SUFFIX = `.home.${ZONE}`;

/** Names that are taken outside this repo, or would be confusing as apps. */
export const RESERVED_NAMES = new Set(["www", "home", "api", "mail", "auth", "login", "admin", "status", "app", "apps"]);

/** Paths an automatic merge must never touch: they define the guardrails themselves. */
export const SENSITIVE_PATHS = [/^\.github\//, /^\.claude\//, /^CLAUDE\.md$/, /^scripts\//, /^package\.json$/, /^\.npmrc$/, /^docs\/SETUP\.md$/];

/** Remove // and /* *\/ comments and trailing commas, leaving strings untouched. */
export function stripJsonc(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const char = text[i];
		const next = text[i + 1];
		if (inString) {
			out += char;
			if (char === "\\") {
				out += next ?? "";
				i++;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
			out += char;
		} else if (char === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i++;
			out += "\n";
		} else if (char === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
			i++;
		} else {
			out += char;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

export const parseJsonc = (text) => JSON.parse(stripJsonc(text));

export function git(args, options = {}) {
	return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options }).trim();
}

/** File content at a git revision, or undefined when it doesn't exist there. */
export function showAt(rev, path) {
	try {
		return execFileSync("git", ["show", `${rev}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return undefined;
	}
}

export function appsAt(rev) {
	if (rev === "WORKTREE") {
		return existsSync("apps") ? readdirSync("apps", { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join("apps", d.name, "wrangler.jsonc"))).map((d) => d.name) : [];
	}
	const listing = (() => {
		try {
			return git(["ls-tree", "-d", "--name-only", `${rev}:apps`]);
		} catch {
			return "";
		}
	})();
	return listing.split("\n").filter((name) => name && showAt(rev, `apps/${name}/wrangler.jsonc`) !== undefined);
}

export function readAppAt(rev, name) {
	const read = (path) => (rev === "WORKTREE" ? (existsSync(path) ? readFileSync(path, "utf8") : undefined) : showAt(rev, path));
	const wranglerText = read(`apps/${name}/wrangler.jsonc`);
	const packageText = read(`apps/${name}/package.json`);
	if (wranglerText === undefined) return undefined;
	return {
		name,
		wrangler: parseJsonc(wranglerText),
		pkg: packageText === undefined ? undefined : JSON.parse(packageText),
	};
}

/**
 * The fields that, once an app is live, must not change without the owner's
 * explicit approval: changing any of them breaks a URL, loses data or
 * disconnects a client.
 */
export function protectedFields(wrangler, protectedVars = []) {
	const pick = (list, keys) => (list ?? []).map((item) => Object.fromEntries(keys.map((key) => [key, item[key] ?? null]))).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return {
		name: wrangler.name ?? null,
		routes: (wrangler.routes ?? []).map((route) => (typeof route === "string" ? route : `${route.pattern}${route.custom_domain ? " [custom]" : ""}`)).sort(),
		workers_dev: wrangler.workers_dev ?? null,
		preview_urls: wrangler.preview_urls ?? null,
		kv_namespaces: pick(wrangler.kv_namespaces, ["binding", "id"]),
		d1_databases: pick(wrangler.d1_databases, ["binding", "database_id", "database_name"]),
		r2_buckets: pick(wrangler.r2_buckets, ["binding", "bucket_name"]),
		durable_objects: pick(wrangler.durable_objects?.bindings, ["name", "class_name"]),
		migrations: wrangler.migrations ?? [],
		// Only the vars the app's live version lists in platform.protectedVars,
		// such as an MCP server's public URL that tokens are bound to.
		vars: Object.fromEntries(protectedVars.map((key) => [key, wrangler.vars?.[key] ?? null])),
	};
}

/** Returns human-readable problems with one app's configuration. */
export function validateApp(app) {
	const problems = [];
	const { name, wrangler, pkg } = app;
	const host = `${name}.${ZONE}`;
	if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(name)) problems.push(`${name}: directory name must be 3-32 chars of a-z, 0-9 and "-"`);
	if (RESERVED_NAMES.has(name)) problems.push(`${name}: name is reserved`);
	if (wrangler.name !== name) problems.push(`${name}: wrangler name "${wrangler.name}" must equal the directory name`);
	if (wrangler.workers_dev !== false) problems.push(`${name}: workers_dev must be false`);
	if (wrangler.preview_urls !== false) problems.push(`${name}: preview_urls must be false`);
	const routes = wrangler.routes ?? [];
	if (routes.length !== 1 || typeof routes[0] !== "object" || routes[0].pattern !== host || routes[0].custom_domain !== true) {
		problems.push(`${name}: routes must be exactly [{ "pattern": "${host}", "custom_domain": true }]`);
	}
	if (wrangler.route) problems.push(`${name}: use "routes", not "route"`);
	// Both make `wrangler deploy` run commands, and deploy runs with the Cloudflare token.
	for (const key of ["build", "containers"]) if (key in wrangler) problems.push(`${name}: "${key}" isn't allowed in wrangler.jsonc`);
	if (wrangler.env) problems.push(`${name}: named environments aren't used on this platform`);
	if (JSON.stringify(wrangler).includes(PRIVATE_SUFFIX)) problems.push(`${name}: must not reference *${PRIVATE_SUFFIX}`);
	if (!pkg) {
		problems.push(`${name}: missing package.json`);
	} else {
		if (pkg.name !== name) problems.push(`${name}: package.json name must be "${name}"`);
		for (const script of ["typecheck", "test"]) if (!pkg.scripts?.[script]) problems.push(`${name}: package.json needs a "${script}" script`);
		const platform = pkg.platform;
		if (!platform || !["app", "mcp"].includes(platform.kind)) problems.push(`${name}: package.json needs "platform": { "kind": "app" | "mcp", ... }`);
		if (!Array.isArray(platform?.smoke) || platform.smoke.length === 0) problems.push(`${name}: package.json platform.smoke needs at least one { "path", "status" } check`);
	}
	return problems;
}

/** Files changed between two revisions, with git's status letter. */
export function changedFiles(base, head) {
	const out = git(["diff", "--name-status", "--no-renames", `${base}...${head}`]);
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split("\t");
			return { status, path };
		});
}

export function appOfPath(path) {
	const match = /^apps\/([^/]+)\//.exec(path);
	return match ? match[1] : undefined;
}
