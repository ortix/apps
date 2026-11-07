#!/usr/bin/env bash
# Exercises the full OAuth flow and every tool with the MCP Inspector CLI.
# The first call opens your browser for consent and GitHub sign-in.
# Tool results are reduced to size and error status so no data is printed.
# Usage: scripts/inspector-oauth-check.sh [server-url]
set -uo pipefail

URL="${1:-http://localhost:8787/mcp}"
INSPECTOR="@modelcontextprotocol/inspector@2.14.0"
# Keep the Inspector's OAuth tokens out of ~/.mcp-inspector.
# Set KEEP_AUTH=1 to reuse the login across runs (stored under .wrangler/, gitignored).
if [ "${KEEP_AUTH:-0}" = 1 ]; then
	export MCP_STORAGE_DIR="$PWD/.wrangler/inspector-auth"
	mkdir -p "$MCP_STORAGE_DIR"
else
	export MCP_STORAGE_DIR="$(mktemp -d)"
	trap 'rm -rf "$MCP_STORAGE_DIR"' EXIT
fi
export MCP_INSPECTOR_OAUTH_STATE_PATH="$MCP_STORAGE_DIR/oauth.json"

inspect() { npx -y "$INSPECTOR" --cli --transport http --server-url "$URL" "$@" 2> >(grep -vE 'EBADENGINE|^npm warn' >&2); }

summarize() {
	node -e '
		let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
			try {
				const r = JSON.parse(s);
				const text = (r.content ?? []).map((c) => c.text ?? "").join("");
				console.log(r.isError ? `  ERROR: ${text}` : `  ok, ${text.length} chars`);
			} catch { console.log(`  unparseable output (${s.length} chars)`); }
		});'
}

day() { node -e "console.log(new Date(Date.now() - $1 * 864e5).toISOString().slice(0, 10))"; }

echo "== tools/list (starts OAuth in your browser)"
inspect --method tools/list | node -e '
	let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
		const { tools = [] } = JSON.parse(s);
		for (const t of tools) console.log(`  ${t.name}  readOnlyHint=${t.annotations?.readOnlyHint}  title="${t.title ?? t.annotations?.title ?? ""}"`);
	});' || { echo "tools/list failed"; exit 1; }

echo "== list_activities (last 30 days)"
ID=$(inspect --use-stored-auth --method tools/call --tool-name list_activities --tool-arg "start_date=$(day 30)" "end_date=$(day 0)" \
	| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const text=r.content?.[0]?.text??"";if(r.isError){console.error(`  ERROR: ${text}`);return}const t=JSON.parse(text);console.error(`  ok, ${t.count} activities`);console.log(t.activities?.[0]?.id ?? "")}catch{console.error(`  unparseable output (${s.length} chars)`)}})')

if [ -n "$ID" ]; then
	echo "== get_activity"
	inspect --use-stored-auth --method tools/call --tool-name get_activity --tool-arg "id=$ID" | summarize
	echo "== get_activity_streams"
	inspect --use-stored-auth --method tools/call --tool-name get_activity_streams --tool-arg "id=$ID" | summarize
fi

echo "== get_daily_health (last 7 days)"
inspect --use-stored-auth --method tools/call --tool-name get_daily_health --tool-arg "start_date=$(day 7)" "end_date=$(day 0)" | summarize

echo "== invalid input is rejected"
inspect --use-stored-auth --method tools/call --tool-name get_daily_health --tool-arg "start_date=2026-02-30" | summarize
