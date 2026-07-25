import { GoogleGenAI } from '@google/genai';
import type { EmbeddingsModel, EmbeddingsResponse } from 'vectra/browser';

const log = (...args: unknown[]) => console.debug('[Auditor]', ...args);

// Gemini's batchEmbedContents endpoint has been observed to silently return only a single
// embedding when a request batches multiple texts together (regardless of batch size), so each
// text is sent as its own single-content request. Concurrency is capped to avoid hammering the
// API with one request per chunk when re-indexing a large folder.
const CONCURRENCY = 5;

/** Adapts the Gemini embedContent API to vectra's `EmbeddingsModel` interface. */
export class GeminiEmbeddings implements EmbeddingsModel {
	readonly maxTokens = 2048;
	private ai: GoogleGenAI;
	private model: string;

	constructor(apiKey: string, model: string) {
		this.ai = new GoogleGenAI({ apiKey });
		this.model = model;
	}

	private async embedOne(text: string): Promise<number[]> {
		const response = await this.ai.models.embedContent({
			model: this.model,
			contents: text,
		});
		const embedding = response.embeddings?.[0];
		if (!embedding?.values) throw new Error('Gemini returned no embedding values.');
		return embedding.values;
	}

	async createEmbeddings(inputs: string | string[]): Promise<EmbeddingsResponse> {
		const texts = Array.isArray(inputs) ? inputs : [inputs];
		if (texts.length === 0) return { status: 'success', output: [] };

		const output: number[][] = Array.from({ length: texts.length }, () => []);
		let cursor = 0;
		let failure: EmbeddingsResponse | null = null;

		const worker = async (): Promise<void> => {
			while (cursor < texts.length && !failure) {
				const i = cursor++;
				try {
					output[i] = await this.embedOne(texts[i]!);
				} catch (e) {
					const message = String(e);
					console.error('[Auditor] Gemini embedContent failed', e);
					failure = /429|rate.?limit/i.test(message)
						? { status: 'rate_limited', message }
						: { status: 'error', message };
				}
			}
		};

		log('createEmbeddings: embedding', { count: texts.length, model: this.model });
		await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, worker));

		if (failure) return failure;
		return { status: 'success', output, model: this.model };
	}
}
