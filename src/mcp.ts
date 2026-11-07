import { insufficientScope, type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { isAllowedUser, SCOPE_READ } from "./auth";
import type { AppEnv, AuthProps } from "./env";
import { GarminAuthError } from "./garmin/token";
import { GarminClient, GarminApiError } from "./garmin/client";
import { FitParseError } from "./garmin/fit";
import { GarminTokenProvider } from "./garmin/token";
import { log, requestId } from "./log";
import { DEFAULT_RESOLUTION_S, type Deps, getActivity, getActivityStreams, getDailyHealth, getHeartRateZones, listActivities, MAX_HEALTH_RANGE_DAYS, ToolInputError } from "./service";

const date = z.iso.date();
const activityId = z.union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()]).describe("Activity id from list_activities.");

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const UNITS = "Units: SI (metres, seconds, m/s) plus pace. pace_min_km is decimal minutes per km (5.5 means 5:30/km); pace is the same as m:ss text.";

function deps(appEnv: AppEnv): Deps {
	const tokens = new GarminTokenProvider({ apiKey: appEnv.GARMIN_API_KEY, store: appEnv.GARMIN_CACHE });
	return { client: new GarminClient({ tokens }), cache: appEnv.GARMIN_CACHE };
}

/** Only messages written by this codebase reach the model; anything else is generic. */
function safeMessage(error: unknown): string {
	if (error instanceof ToolInputError || error instanceof GarminApiError || error instanceof GarminAuthError || error instanceof FitParseError) {
		return error.message;
	}
	return "Unexpected error while contacting Garmin. Try again shortly.";
}

async function run(tool: string, work: () => Promise<unknown>) {
	const rid = requestId();
	const started = Date.now();
	try {
		const result = await work();
		log({ rid, event: "tool", tool, outcome: "ok", ms: Date.now() - started });
		return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
	} catch (error) {
		const status = error instanceof GarminApiError || error instanceof GarminAuthError ? error.status : undefined;
		log({ rid, event: "tool", tool, outcome: "error", ...(status === undefined ? {} : { status }), ms: Date.now() - started });
		return { isError: true, content: [{ type: "text" as const, text: safeMessage(error) }] };
	}
}

export function createServer(appEnv: AppEnv = env as unknown as AppEnv): McpServer {
	const server = new McpServer(
		{ name: "garmin-personal", title: "Garmin", version: "0.1.0" },
		{
			instructions:
				"Read-only access to the user's own Garmin Connect data. Typical flow: list_activities to find ids, get_activity for the summary and laps, get_activity_streams for detailed analysis, get_daily_health for sleep and recovery context.",
		},
	);
	const garmin = deps(appEnv);

	server.registerTool(
		"list_activities",
		{
			title: "List activities",
			description: `Find the user's workouts between two dates, newest first. Use this first whenever a question refers to activities by date ("my runs last week", "my last ride") or across a period, since it returns the ids the other activity tools need. Returns one compact summary per activity: id, name, type, start time (local and UTC), distance, duration, pace, heart rate, elevation, power and training load. ${UNITS}`,
			inputSchema: {
				start_date: date.describe("First date to include, YYYY-MM-DD, by the activity's local start time."),
				end_date: date.describe("Last date to include, YYYY-MM-DD, inclusive."),
				type: z
					.string()
					.regex(/^[a-z0-9_]+$/)
					.optional()
					.describe('Parent activity type key, such as "running", "cycling", "swimming", "walking", "hiking" or "fitness_equipment". Subtypes such as "trail_running" are rejected by Garmin; omit this and filter the results instead.'),
			},
			annotations: READ_ONLY,
		},
		(input) => run("list_activities", () => listActivities(garmin, input)),
	);

	server.registerTool(
		"get_activity",
		{
			title: "Get activity details",
			description: `Get one activity's full summary, its laps and, when one was used, the planned structured workout. Use it to review a specific workout: lap-by-lap pace and heart rate, interval structure, planned vs actual, training effect, temperature. planned_workout lists each step's duration (seconds, metres or an end condition) and target (a zone number, or a decoded range in bpm, % of max HR, watts, % of FTP or pace); repeat steps say which step to repeat from and how many times. For how a metric changed within a lap or over time, use get_activity_streams instead. ${UNITS}`,
			inputSchema: { id: activityId },
			annotations: READ_ONLY,
		},
		({ id }) => run("get_activity", () => getActivity(garmin, String(id))),
	);

	server.registerTool(
		"get_activity_streams",
		{
			title: "Get activity time series",
			description: `Get an activity's time series as columns and rows: time, distance, speed, pace, heart rate, cadence, elevation, and power if recorded. GPS position is never included. Use it for analysis the lap data can't answer, such as pacing drift, heart-rate decoupling, or effort on a climb. Use get_activity for ordinary workout questions, because this response is much larger. Each row covers one time bucket starting at t_s (seconds since the start, including pauses): distance_m is the cumulative distance at t_s, and the other columns are averages over the bucket. Cadence units are given in cadence_unit. If the requested resolution would be too large to return, a coarser one is used and a note says so. ${UNITS}`,
			inputSchema: {
				id: activityId,
				resolution: z
					.number()
					.int()
					.min(1)
					.max(3600)
					.optional()
					.describe(`Seconds per data point. Defaults to ${DEFAULT_RESOLUTION_S}. Use 1 to 5 only for short efforts such as strides; use 30 or more for long activities.`),
			},
			annotations: READ_ONLY,
		},
		({ id, resolution }) => run("get_activity_streams", () => getActivityStreams(garmin, String(id), resolution)),
	);

	server.registerTool(
		"get_heart_rate_zones",
		{
			title: "Get heart rate zones",
			description:
				"Get the user's heart-rate zones as configured in Garmin Connect: one zone set per sport (\"default\" applies when a sport has none), with the method used (such as lactate threshold or % of max HR) and the max, resting and lactate-threshold heart rates behind it. Each zone runs from from_bpm up to to_bpm; zone 5 ends at max HR. Use it to judge time in zone or effort from heart-rate data in get_activity_streams or get_activity, and to read workout targets given as zone numbers.",
			inputSchema: {},
			annotations: READ_ONLY,
		},
		() => run("get_heart_rate_zones", () => getHeartRateZones(garmin)),
	);

	server.registerTool(
		"get_daily_health",
		{
			title: "Get daily health",
			description: `Get daily health and recovery metrics for one date or a date range of up to ${MAX_HEALTH_RANGE_DAYS} days: sleep (duration, stages, score), HRV (overnight average, weekly average, status, balanced range), resting heart rate, stress, Body Battery, steps, intensity minutes, respiration and SpO2. Use it for questions about sleep, recovery, readiness or trends, and to put a workout in context. A day's sleep and HRV belong to the night ending on that date. Fields Garmin has no data for are omitted, and today's values may still be incomplete. Durations are in seconds, HRV in milliseconds.`,
			inputSchema: {
				start_date: date.describe("The date, or the first date of a range, YYYY-MM-DD."),
				end_date: date.optional().describe("Last date of the range, inclusive. Omit for a single day."),
			},
			annotations: READ_ONLY,
		},
		(input) => run("get_daily_health", () => getDailyHealth(garmin, input)),
	);

	return server;
}

const mcpHandler = createMcpHandler(() => createServer());

/**
 * Reached only with a valid token. The allowlist is re-checked on each request,
 * so changing ALLOWED_GITHUB_USER_ID cuts off grants that were already issued.
 */
export const mcpApiHandler = {
	fetch(request: Request, appEnv: AppEnv, executionContext: ExecutionContext): Promise<Response> | Response {
		const ctx = executionContext as OAuthResourceContext<AuthProps>;
		if (!isAllowedUser(ctx.props?.githubUserId, appEnv.ALLOWED_GITHUB_USER_ID)) {
			log({ rid: requestId(), event: "auth", outcome: "denied", status: 403 });
			return new Response("Forbidden\n", { status: 403 });
		}
		if (!ctx.auth.scope.includes(SCOPE_READ)) return insufficientScope(ctx.auth, [SCOPE_READ]);
		return mcpHandler(request, appEnv, ctx);
	},
};
