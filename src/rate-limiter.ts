/**
 * Rate limiter + retry helper for the Granola MCP server.
 *
 * Per Granola's docs (https://docs.granola.ai/help-center/sharing/integrations/mcp),
 * rate limits average around 100 requests per minute across all tools and vary
 * by plan. We use a conservative sliding-window limiter and retry with
 * exponential backoff on rate-limit responses/errors.
 */

export interface RateLimiterOptions {
	maxRequests: number;
	windowMs: number;
}

export class RateLimiter {
	private readonly maxRequests: number;
	private readonly windowMs: number;
	private timestamps: number[] = [];
	private queue: Promise<void> = Promise.resolve();

	constructor(options: RateLimiterOptions) {
		this.maxRequests = options.maxRequests;
		this.windowMs = options.windowMs;
	}

	/**
	 * Wait until a slot is available in the sliding window, then consume it.
	 * Calls are serialized so the accounting stays accurate under concurrency.
	 */
	async acquire(): Promise<void> {
		const run = this.queue.then(async () => {
			for (;;) {
				const now = Date.now();
				this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs);
				if (this.timestamps.length < this.maxRequests) {
					this.timestamps.push(now);
					return;
				}
				const oldest = this.timestamps[0];
				const waitMs = this.windowMs - (now - oldest) + 25; // small buffer
				await sleep(waitMs);
			}
		});
		this.queue = run.catch(() => undefined);
		await run;
	}

	/**
	 * Called when we've observed a rate-limit error from the server — treat
	 * the window as saturated so callers back off naturally.
	 */
	markSaturated(): void {
		const now = Date.now();
		const needed = this.maxRequests - this.timestamps.length;
		for (let i = 0; i < needed; i++) {
			this.timestamps.push(now);
		}
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

const RATE_LIMIT_PATTERNS = [
	/rate[\s-]?limit(ed)?\s+(exceeded|reached|hit)/i,
	/please\s+slow\s+down/i,
	/too\s+many\s+requests/i,
	/\b429\b/,
];

/**
 * Heuristic check: does this text or error look like a rate-limit signal?
 */
export function isRateLimitSignal(input: unknown): boolean {
	const text = extractText(input);
	if (!text) return false;
	return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

function extractText(input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input;
	if (input instanceof Error) return input.message;
	if (typeof input === "object") {
		const obj = input as { message?: unknown; error?: unknown };
		if (typeof obj.message === "string") return obj.message;
		if (typeof obj.error === "string") return obj.error;
		try {
			return JSON.stringify(input);
		} catch {
			return "";
		}
	}
	try {
		return JSON.stringify(input);
	} catch {
		return "";
	}
}

export interface RetryOptions {
	maxAttempts: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

/**
 * Execute `fn` and retry on rate-limit signals with exponential backoff + jitter.
 * `fn` may either throw an error or return a string response; both are inspected.
 * Non-rate-limit errors are rethrown immediately.
 */
export async function withRateLimitRetry<T>(
	fn: () => Promise<T>,
	options: RetryOptions,
	onRateLimit?: (attempt: number, delayMs: number) => void,
): Promise<T> {
	let attempt = 0;
	for (;;) {
		attempt++;
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			if (isRateLimitSignal(error) && attempt < options.maxAttempts) {
				const delay = backoffDelay(attempt, options);
				onRateLimit?.(attempt, delay);
				await sleep(delay);
				continue;
			}
			throw error;
		}
		if (isRateLimitSignal(result) && attempt < options.maxAttempts) {
			const delay = backoffDelay(attempt, options);
			onRateLimit?.(attempt, delay);
			await sleep(delay);
			continue;
		}
		return result;
	}
}

function backoffDelay(attempt: number, options: RetryOptions): number {
	const exp = options.baseDelayMs * 2 ** (attempt - 1);
	const capped = Math.min(exp, options.maxDelayMs);
	const jitter = Math.random() * 0.3 * capped;
	return Math.round(capped + jitter);
}
