import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GranolaAuthProvider } from "./auth";
import { nodeFetch } from "./fetch";
import {
	RateLimiter,
	isRateLimitSignal,
	withRateLimitRetry,
} from "./rate-limiter";

const MCP_SERVER_URL = "https://mcp.granola.ai/mcp";

// Granola's documented limit averages ~100 requests per minute across all
// tools (https://docs.granola.ai/help-center/sharing/integrations/mcp), but
// the server is noticeably stricter for expensive tools like
// get_meeting_transcript — likely because any other MCP clients the user has
// connected (Claude, ChatGPT, etc.) share the same budget. Stay well under
// the documented number so we keep a usable margin.
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Retry policy for a single API call. Capped at ~15s worst case so a bad
// minute doesn't stall the whole sync — the next cron tick will pick up
// anything we skipped.
const RETRY_OPTIONS = {
	maxAttempts: 3,
	baseDelayMs: 2_000,
	maxDelayMs: 20_000,
};

// Circuit breaker: after this many rate-limit events in the window, refuse
// further calls for `CIRCUIT_OPEN_MS` so we stop hammering the server and let
// the outer sync loop exit cleanly instead of flailing meeting-by-meeting.
const CIRCUIT_THRESHOLD_EVENTS = 3;
const CIRCUIT_WINDOW_MS = 60_000;
const CIRCUIT_OPEN_MS = 60_000;

export class RateLimitError extends Error {
	constructor(message = "Granola rate limit exceeded after retries") {
		super(message);
		this.name = "RateLimitError";
	}
}

export type SyncTimeRange = string;

/**
 * Sentinel meaning "fetch all meetings ever". The Granola MCP server's
 * `list_meetings.time_range` enum currently exposes
 *   this_week / last_week / last_30_days / custom
 * with a `last_30_days` default. To request unlimited history, we send
 * `time_range: "custom"` with a very early `custom_start` and a future
 * `custom_end` (see `listMeetings`).
 */
export const UNLIMITED_TIME_RANGE = "__all_time__";

// Floor for the "All time" custom range. Granola's product launched in 2024,
// so anything older than this can't possibly exist.
const UNLIMITED_RANGE_START = "2000-01-01";

export interface ToolParamEnum {
	name: string;
	values: string[];
}

export class GranolaMcpClient {
	private client: Client | null = null;
	private authProvider: GranolaAuthProvider;
	private toolSchemas: Record<string, Record<string, unknown>> = {};
	private rateLimiter = new RateLimiter({
		maxRequests: RATE_LIMIT_MAX_REQUESTS,
		windowMs: RATE_LIMIT_WINDOW_MS,
	});
	private rateLimitEventTimes: number[] = [];
	private circuitOpenUntil = 0;

	constructor(authProvider: GranolaAuthProvider) {
		this.authProvider = authProvider;
	}

	get isConnected(): boolean {
		return this.client !== null;
	}

	async connect(): Promise<void> {
		await this.disconnect();
		this.client = new Client({
			name: "obsidian-granola-sync",
			version: "2.0.0",
		});
		const transport = new StreamableHTTPClientTransport(
			new URL(MCP_SERVER_URL),
			{ authProvider: this.authProvider, fetch: nodeFetch },
		);
		try {
			await this.client.connect(transport);
			// Discover tool schemas (best-effort; not fatal)
			try {
				await this.refreshToolSchemas();
			} catch (e) {
				console.warn("Granola: failed to fetch tool schemas", e);
			}
		} catch (e) {
			this.client = null;
			throw e;
		}
	}

	async disconnect(): Promise<void> {
		if (this.client) {
			try {
				await this.client.close();
			} catch {
				// ignore close errors
			}
			this.client = null;
		}
	}

	async finishAuth(authorizationCode: string): Promise<void> {
		// Create a transport just for the token exchange.
		// It uses the same authProvider which has the code verifier from the auth flow.
		const transport = new StreamableHTTPClientTransport(
			new URL(MCP_SERVER_URL),
			{ authProvider: this.authProvider, fetch: nodeFetch },
		);
		await transport.finishAuth(authorizationCode);
	}

	private async refreshToolSchemas(): Promise<void> {
		if (!this.client) return;
		const res = await this.client.listTools();
		this.toolSchemas = {};
		for (const tool of res.tools) {
			this.toolSchemas[tool.name] = tool.inputSchema as Record<string, unknown>;
		}
	}

	/**
	 * Return the list of allowed enum values for a tool's input parameter,
	 * or null if unknown. Useful for building setting dropdowns dynamically.
	 */
	getParamEnum(toolName: string, paramName: string): string[] | null {
		const schema = this.toolSchemas[toolName];
		if (!schema) return null;
		const properties = schema.properties as Record<string, unknown> | undefined;
		if (!properties) return null;
		const prop = properties[paramName] as Record<string, unknown> | undefined;
		if (!prop) return null;
		const enumValues = prop.enum;
		if (Array.isArray(enumValues)) {
			return enumValues.filter((v): v is string => typeof v === "string");
		}
		return null;
	}

	hasTool(toolName: string): boolean {
		return toolName in this.toolSchemas;
	}

	hasToolParam(toolName: string, paramName: string): boolean {
		const schema = this.toolSchemas[toolName];
		if (!schema) return false;
		const properties = schema.properties as Record<string, unknown> | undefined;
		return Boolean(properties && paramName in properties);
	}

	async listMeetings(timeRange: SyncTimeRange, folderId?: string): Promise<string> {
		const args: Record<string, unknown> = {};
		if (timeRange === UNLIMITED_TIME_RANGE) {
			// Request unlimited history via the server's `custom` time range.
			// Fall back to last_30_days if the server doesn't advertise it.
			const supportsCustom = this.getParamEnum("list_meetings", "time_range")
				?.includes("custom") ?? false;
			if (supportsCustom) {
				args.time_range = "custom";
				args.custom_start = UNLIMITED_RANGE_START;
				args.custom_end = todayIsoDate(/* lookahead= */ 1);
			}
			// else: omit time_range and let the server default to last_30_days.
		} else if (timeRange) {
			args.time_range = timeRange;
		}
		if (folderId) args.folder_id = folderId;
		return this.callToolText("list_meetings", args);
	}

	/**
	 * Whether `time_range` is listed in the list_meetings tool's `required`
	 * array. When false, we can omit it to request unlimited history.
	 */
	isTimeRangeRequired(): boolean {
		const schema = this.toolSchemas["list_meetings"];
		if (!schema) return false;
		const required = schema.required;
		if (!Array.isArray(required)) return false;
		return required.includes("time_range");
	}

	getToolSchema(toolName: string): Record<string, unknown> | null {
		return this.toolSchemas[toolName] ?? null;
	}

	getAllToolSchemas(): Record<string, Record<string, unknown>> {
		return this.toolSchemas;
	}

	async listMeetingFolders(): Promise<string> {
		return this.callToolText("list_meeting_folders", {});
	}

	async getMeetings(meetingIds: string[]): Promise<string> {
		return this.callToolText("get_meetings", { meeting_ids: meetingIds });
	}

	async getTranscript(meetingId: string): Promise<string> {
		return this.callToolText("get_meeting_transcript", { meeting_id: meetingId });
	}

	/**
	 * Reset the circuit breaker and sampled event history. Call at the start
	 * of a new sync run so a previous sync's penalty doesn't carry over.
	 */
	resetRateLimitCircuit(): void {
		this.rateLimitEventTimes = [];
		this.circuitOpenUntil = 0;
	}

	get isCircuitOpen(): boolean {
		return Date.now() < this.circuitOpenUntil;
	}

	private recordRateLimitEvent(): void {
		const now = Date.now();
		this.rateLimitEventTimes = this.rateLimitEventTimes.filter(
			(t) => now - t < CIRCUIT_WINDOW_MS,
		);
		this.rateLimitEventTimes.push(now);
		if (this.rateLimitEventTimes.length >= CIRCUIT_THRESHOLD_EVENTS) {
			this.circuitOpenUntil = now + CIRCUIT_OPEN_MS;
			this.rateLimitEventTimes = [];
			console.warn(
				`Granola: rate-limit circuit opened for ${CIRCUIT_OPEN_MS}ms — aborting remaining API calls`,
			);
		}
	}

	private async ensureConnected(): Promise<void> {
		if (!this.client) {
			await this.connect();
		}
	}

	private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
		if (this.isCircuitOpen) {
			throw new RateLimitError(
				`Granola rate-limit circuit open; skipping ${name}`,
			);
		}
		await this.ensureConnected();

		const invoke = async (): Promise<string> => {
			const client = this.client;
			if (!client) {
				throw new Error("Not connected to Granola");
			}
			await this.rateLimiter.acquire();
			const result = await client.callTool({ name, arguments: args });
			return (result.content as Array<{ type: string; text?: string }>)
				.filter((c) => c.type === "text" && typeof c.text === "string")
				.map((c) => c.text!)
				.join("\n");
		};

		let triedReconnect = false;
		try {
			return await withRateLimitRetry(
				async () => {
					try {
						return await invoke();
					} catch (err) {
						// If the transport dropped mid-flight, reconnect once and
						// retry the call in-place. Don't count this as a rate-limit
						// event — it's a separate failure mode.
						if (!triedReconnect && isTransportDropped(err)) {
							triedReconnect = true;
							console.warn(`Granola: reconnecting for ${name} after transport drop`);
							await this.connect();
							return await invoke();
						}
						throw err;
					}
				},
				RETRY_OPTIONS,
				(attempt, delayMs) => {
					this.rateLimiter.markSaturated();
					this.recordRateLimitEvent();
					console.warn(
						`Granola: rate-limited on ${name} (attempt ${attempt}), backing off ${delayMs}ms`,
					);
				},
			);
		} catch (error) {
			if (isRateLimitSignal(error)) {
				this.recordRateLimitEvent();
				throw new RateLimitError(
					`Granola rate limit exceeded on ${name} after ${RETRY_OPTIONS.maxAttempts} attempts`,
				);
			}
			throw error;
		}
	}
}

function todayIsoDate(lookaheadDays = 0): string {
	const d = new Date(Date.now() + lookaheadDays * 24 * 60 * 60 * 1000);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function isTransportDropped(err: unknown): boolean {
	const msg =
		err instanceof Error ? err.message : typeof err === "string" ? err : "";
	if (!msg) return false;
	return /not connected|connection\s+(closed|reset|lost)|transport\s+closed|stream\s+closed/i.test(
		msg,
	);
}
