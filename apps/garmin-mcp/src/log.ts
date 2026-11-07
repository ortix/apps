/**
 * The only logger in this Worker. Its fields are a closed set on purpose:
 * tokens, the API key and health or activity payloads have nowhere to go.
 */
export interface LogEntry {
	rid: string;
	event: "tool" | "auth";
	tool?: string;
	outcome: "ok" | "error" | "denied";
	status?: number;
	ms?: number;
}

export function log(entry: LogEntry): void {
	console.log(JSON.stringify(entry));
}

export const requestId = (): string => crypto.randomUUID().slice(0, 8);
