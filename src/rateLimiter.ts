/** One second's worth of aggregated call activity, used to draw the throughput graph. */
export interface ThroughputSample {
	time: number;
	requests: number;
	tokens: number;
	/** Estimated request+response payload size, in bytes, for calls completed in this second. */
	bytes: number;
}

const RAMP_DURATION_MS = 30_000;
const MAX_SAMPLES = 120;

/**
 * Paces outgoing Gemini embedding calls so indexing never bursts a spike of simultaneous
 * requests. All callers `await acquire()` before making a request; a shared instance across the
 * standards/evidence/written-controls stores means the *aggregate* rate across all of them stays
 * under the configured ceiling, regardless of per-store concurrency.
 *
 * When gradual ramp-up is enabled, `reset()` (called at the start of each indexing run) restarts
 * the allowed rate at a slow pace and linearly increases it up to the configured max over
 * `RAMP_DURATION_MS`, instead of immediately allowing full-speed traffic.
 */
export class RateLimiter {
	private maxRequestsPerSecond: number;
	private gradualRampUp: boolean;
	private rampStartTime: number | null = null;
	private lastRequestTime = 0;
	private samples: ThroughputSample[] = [];
	private currentBucket: ThroughputSample | null = null;
	private listeners = new Set<() => void>();

	constructor(maxRequestsPerSecond: number, gradualRampUp: boolean) {
		this.maxRequestsPerSecond = maxRequestsPerSecond;
		this.gradualRampUp = gradualRampUp;
	}

	updateConfig(maxRequestsPerSecond: number, gradualRampUp: boolean): void {
		this.maxRequestsPerSecond = maxRequestsPerSecond;
		this.gradualRampUp = gradualRampUp;
	}

	/** Restarts the ramp-up window; call once at the start of each indexing run. */
	reset(): void {
		this.rampStartTime = Date.now();
	}

	private currentAllowedRate(): number {
		if (!this.gradualRampUp || this.rampStartTime === null) return this.maxRequestsPerSecond;
		const elapsed = Date.now() - this.rampStartTime;
		if (elapsed >= RAMP_DURATION_MS) return this.maxRequestsPerSecond;
		const minRate = Math.min(1, this.maxRequestsPerSecond);
		return minRate + (this.maxRequestsPerSecond - minRate) * (elapsed / RAMP_DURATION_MS);
	}

	/** Blocks until it is this caller's turn to make a request, per the current allowed rate. */
	async acquire(): Promise<void> {
		if (this.rampStartTime === null) this.rampStartTime = Date.now();
		const rate = Math.max(this.currentAllowedRate(), 0.1);
		const minInterval = 1000 / rate;
		const wait = this.lastRequestTime + minInterval - Date.now();
		if (wait > 0) await new Promise((resolve) => { window.setTimeout(resolve, wait); });
		this.lastRequestTime = Date.now();
	}

	/** Records a completed request (estimated token count, request+response byte size) into the current 1s bucket. */
	recordSample(tokens: number, bytes: number): void {
		const bucketTime = Math.floor(Date.now() / 1000) * 1000;
		if (!this.currentBucket || this.currentBucket.time !== bucketTime) {
			this.currentBucket = { time: bucketTime, requests: 0, tokens: 0, bytes: 0 };
			this.samples.push(this.currentBucket);
			if (this.samples.length > MAX_SAMPLES) this.samples.shift();
		}
		this.currentBucket.requests++;
		this.currentBucket.tokens += tokens;
		this.currentBucket.bytes += bytes;
		this.notify();
	}

	getSamples(): ThroughputSample[] {
		return this.samples;
	}

	/** Subscribes to sample updates; returns an unsubscribe function. */
	onChange(callback: () => void): () => void {
		this.listeners.add(callback);
		return () => this.listeners.delete(callback);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}
}

/** Cheap token estimate (~4 chars/token) — Gemini's embedContent response carries no usage field. */
export function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}
