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
// tools (https://docs.granola.ai/help-center/sharing/integrations/mcp).
// We stay well under that to leave headroom for other clients the user may
// have connected (Claude, ChatGPT, etc.).
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;

const RETRY_OPTIONS = {
	maxAttempts: 5,
	baseDelayMs: 2_000,
	maxDelayMs: 60_000,
};

export class RateLimitError extends Error {
	constructor(message = "Granola rate limit exceeded after retries") {
		super(message);
		this.name = "RateLimitError";
	}
}

export type SyncTimeRange = string;

/**
 * Sentinel value we use to mean "call list_meetings without a time_range
 * parameter". The Granola MCP server's time_range enum is limited (currently
 * this_week / last_week / last_30_days), but on paid plans the server treats
 * an omitted time_range as unbounded history.
 */
export const UNLIMITED_TIME_RANGE = "__all_time__";

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
		if (timeRange && timeRange !== UNLIMITED_TIME_RANGE) {
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

	private async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this.client) {
			throw new Error("Not connected to Granola");
		}
		const client = this.client;

		try {
			return await withRateLimitRetry(
				async () => {
					await this.rateLimiter.acquire();
					const result = await client.callTool({ name, arguments: args });
					return (result.content as Array<{ type: string; text?: string }>)
						.filter((c) => c.type === "text" && typeof c.text === "string")
						.map((c) => c.text!)
						.join("\n");
				},
				RETRY_OPTIONS,
				(attempt, delayMs) => {
					this.rateLimiter.markSaturated();
					console.warn(
						`Granola: rate-limited on ${name} (attempt ${attempt}), backing off ${delayMs}ms`,
					);
				},
			);
		} catch (error) {
			if (isRateLimitSignal(error)) {
				throw new RateLimitError(
					`Granola rate limit exceeded on ${name} after ${RETRY_OPTIONS.maxAttempts} attempts`,
				);
			}
			throw error;
		}
	}
}
