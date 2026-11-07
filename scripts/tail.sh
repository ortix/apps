#!/usr/bin/env bash
# Live production logs, reduced to method, path (no query string), status and
# the Worker's own structured log lines. Query strings can carry OAuth codes.
npx wrangler tail --format json | node -e '
const rl = require("readline").createInterface({ input: process.stdin });
let buf = "";
rl.on("line", (line) => {
	buf += line;
	let event;
	try { event = JSON.parse(buf); } catch { return; }
	buf = "";
	const req = event.event?.request;
	const path = req ? new URL(req.url).pathname : "";
	const status = event.event?.response?.status ?? event.outcome;
	const logs = (event.logs ?? []).map((l) => l.message.join(" ")).filter((m) => m.startsWith("{\"rid\""));
	console.log(`${new Date(event.eventTimestamp).toISOString().slice(11, 19)} ${req?.method ?? ""} ${path} ${status} ${logs.join(" ")}`);
	for (const e of event.exceptions ?? []) console.log(`  exception: ${e.name}`);
});'
