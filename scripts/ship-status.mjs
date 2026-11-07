#!/usr/bin/env node
// Follows a pull request through CI, the ship gate, merge and deploy, using
// only GitHub's REST API (cloud sessions can't use GraphQL, so `gh pr` fails).
//
// Usage: node scripts/ship-status.mjs <pr-number> [--wait]
// Exit code: 0 deployed (or merged with nothing to deploy), 1 failed,
//            3 waiting for the owner, 4 still running (without --wait).
import { execFileSync } from "node:child_process";
import { git } from "./lib/platform.mjs";

const args = process.argv.slice(2);
const number = args.find((arg) => /^\d+$/.test(arg));
const wait = args.includes("--wait");
if (!number) {
	console.error("Usage: node scripts/ship-status.mjs <pr-number> [--wait]");
	process.exit(2);
}

const remote = git(["remote", "get-url", "origin"]);
const repo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(remote)?.[1];
if (!repo) {
	console.error(`Can't tell the GitHub repo from origin (${remote}).`);
	process.exit(2);
}

const api = (path) => JSON.parse(execFileSync("gh", ["api", `repos/${repo}/${path}`], { encoding: "utf8" }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function status() {
	const pr = api(`pulls/${number}`);
	const ci = api(`actions/runs?head_sha=${pr.head.sha}&event=pull_request`).workflow_runs.find((run) => run.name === "CI");
	if (!ci) return { state: "running", text: "CI hasn't started yet." };
	if (ci.status !== "completed") return { state: "running", text: `CI is ${ci.status}: ${ci.html_url}` };
	if (ci.conclusion !== "success") return { state: "failed", text: `CI ${ci.conclusion}: ${ci.html_url}` };

	// The Ship run that CI's completion triggered.
	const ship = api("actions/workflows/ship.yml/runs?per_page=30").workflow_runs
		.filter((run) => run.created_at >= ci.updated_at.slice(0, 19))
		.sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
	if (!ship) return { state: "running", text: "Waiting for the Ship workflow to start." };
	const jobs = api(`actions/runs/${ship.id}/jobs`).jobs;

	if (!pr.merged) {
		if (ship.status !== "completed") return { state: "running", text: `Ship is ${ship.status}: ${ship.html_url}` };
		const held = api(`issues/${number}/comments?per_page=100`).find((c) => c.body.includes(`ship-gate:${pr.head.sha}`));
		if (held) return { state: "held", text: `Waiting for the owner to review PR #${number}:\n${held.body.replace(/<!--.*?-->\n?/, "")}` };
		return { state: ship.conclusion === "success" ? "held" : "failed", text: `Not merged. Ship ${ship.conclusion}: ${ship.html_url}` };
	}

	const deployJobs = jobs.filter((job) => job.name.startsWith("deploy"));
	const deploy = deployJobs.find((job) => job.name.endsWith("/ deploy"));
	if (deployJobs.length === 0 || deployJobs.every((job) => job.conclusion === "skipped")) {
		if (ship.status !== "completed") return { state: "running", text: `Merged as ${pr.merge_commit_sha}; Ship is still running.` };
		return { state: "done", text: `Merged as ${pr.merge_commit_sha}. Nothing to deploy.` };
	}
	if (!deploy || deploy.status !== "completed") return { state: "running", text: `Merged as ${pr.merge_commit_sha}; deploying: ${ship.html_url}` };
	if (deploy.conclusion !== "success") return { state: "failed", text: `Deploy ${deploy.conclusion}: ${deploy.html_url}` };
	return { state: "done", text: `Merged as ${pr.merge_commit_sha}, deployed and smoke-tested: ${deploy.html_url}` };
}

const codes = { done: 0, failed: 1, held: 3, running: 4 };
const deadline = Date.now() + 30 * 60_000;
let last = "";
for (;;) {
	const { state, text } = status();
	if (text !== last) console.log(text);
	last = text;
	if (state !== "running" || !wait || Date.now() > deadline) process.exit(codes[state]);
	await sleep(20_000);
}
