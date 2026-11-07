import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseJsonc, validateApp } from "../lib/platform.mjs";

describe("parseJsonc", () => {
	it("keeps URLs inside strings and drops comments and trailing commas", () => {
		const parsed = parseJsonc(`{
			// a comment
			"url": "https://example.com/mcp", /* block */
			"list": [1, 2,],
		}`);
		assert.deepEqual(parsed, { url: "https://example.com/mcp", list: [1, 2] });
	});

	it("handles escaped quotes", () => {
		assert.deepEqual(parseJsonc(`{"a": "say \\"hi\\" // not a comment"}`), { a: 'say "hi" // not a comment' });
	});
});

const goodWrangler = (name, extra = {}) => ({
	name,
	routes: [{ pattern: `${name}.tsutsu.dev`, custom_domain: true }],
	workers_dev: false,
	preview_urls: false,
	...extra,
});
const goodPkg = (name, platform = {}) => ({
	name,
	scripts: { typecheck: "tsc", test: "vitest" },
	platform: { kind: "app", smoke: [{ path: "/healthz", status: 200 }], ...platform },
});

describe("validateApp", () => {
	it("accepts a well-formed app", () => {
		assert.deepEqual(validateApp({ name: "habits", wrangler: goodWrangler("habits"), pkg: goodPkg("habits") }), []);
	});

	it("rejects workers.dev, a private host, a mismatched name and a reserved name", () => {
		const problems = validateApp({ name: "www", wrangler: { ...goodWrangler("www"), workers_dev: true, name: "other", vars: { X: "a.home.tsutsu.dev" } }, pkg: goodPkg("www") });
		const text = problems.join("\n");
		for (const expected of ["reserved", "workers_dev", "must equal the directory", "home.tsutsu.dev"]) assert.match(text, new RegExp(expected));
	});
});

describe("ship gate", () => {
	let repo;
	let gate;
	const write = (path, content) => {
		mkdirSync(dirname(join(repo, path)), { recursive: true });
		writeFileSync(join(repo, path), typeof content === "string" ? content : JSON.stringify(content, null, 2));
	};
	const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
	const commit = (message) => {
		run("add", "-A");
		run("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", message);
		return run("rev-parse", "HEAD");
	};
	const branch = (name) => run("checkout", "-qb", name, "main");
	const check = (head) => {
		const cwd = process.cwd();
		process.chdir(repo);
		try {
			return gate("main", head);
		} finally {
			process.chdir(cwd);
		}
	};

	before(async () => {
		({ gate } = await import("../ship-gate.mjs"));
		repo = mkdtempSync(join(tmpdir(), "gate-"));
		run("init", "-qb", "main");
		write("CLAUDE.md", "rules");
		write("apps/garmin-mcp/wrangler.jsonc", { ...goodWrangler("garmin-mcp"), kv_namespaces: [{ binding: "OAUTH_KV", id: "abc" }], vars: { MCP_SERVER_URL: "https://garmin-mcp.tsutsu.dev/mcp" } });
		write("apps/garmin-mcp/package.json", goodPkg("garmin-mcp", { kind: "mcp", autoDeploy: false, protectedVars: ["MCP_SERVER_URL"] }));
		write("apps/garmin-mcp/src/index.ts", "export {}");
		commit("base");
	});
	after(() => rmSync(repo, { recursive: true, force: true }));

	it("ships a new, well-formed app", () => {
		branch("claude/habits");
		write("apps/habits/wrangler.jsonc", goodWrangler("habits"));
		write("apps/habits/package.json", goodPkg("habits"));
		write("package-lock.json", "{}");
		const result = check(commit("habits"));
		assert.deepEqual(result, { ok: true, reasons: [], apps: ["habits"] });
	});

	it("holds changes to the guardrails", () => {
		branch("claude/sneaky");
		write("CLAUDE.md", "no rules");
		write(".github/workflows/ship.yml", "on: push");
		const result = check(commit("sneaky"));
		assert.equal(result.ok, false);
		assert.equal(result.reasons.length, 2);
	});

	it("holds a change to a live app's storage ids or protected vars", () => {
		branch("claude/kv");
		write("apps/garmin-mcp/wrangler.jsonc", { ...goodWrangler("garmin-mcp"), kv_namespaces: [{ binding: "OAUTH_KV", id: "new" }], vars: { MCP_SERVER_URL: "https://elsewhere/mcp" } });
		const result = check(commit("kv"));
		assert.equal(result.ok, false);
		assert.match(result.reasons.join("\n"), /storage bindings or protected vars/);
	});

	it("lets code changes to an app through, but doesn't deploy an app with autoDeploy off", () => {
		branch("claude/code");
		write("apps/garmin-mcp/src/index.ts", "export const x = 1;");
		const result = check(commit("code"));
		assert.deepEqual(result, { ok: true, reasons: [], apps: [] });
	});

	it("holds turning on automatic deploys", () => {
		branch("claude/auto");
		write("apps/garmin-mcp/package.json", goodPkg("garmin-mcp", { kind: "mcp", protectedVars: ["MCP_SERVER_URL"] }));
		const result = check(commit("auto"));
		assert.equal(result.ok, false);
		assert.match(result.reasons.join("\n"), /automatic deploys/);
	});

	it("holds deleting a live app", () => {
		branch("claude/delete");
		run("rm", "-rq", "apps/garmin-mcp");
		const result = check(commit("delete"));
		assert.equal(result.ok, false);
		assert.match(result.reasons.join("\n"), /would be deleted/);
	});

	it("holds files outside the allowed paths", () => {
		branch("claude/root");
		write("tsconfig.base.json", "{}");
		const result = check(commit("root"));
		assert.equal(result.ok, false);
	});
});
