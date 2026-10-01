import type { AuditorSettings } from '../settings';

/** Which model priced a step: the regular generation model, the optional "boosted" model (Burn Mode), or no model at all (a deterministic tool/bookkeeping step, which never gets a usage record). */
export type ModelTier = 'base' | 'boosted' | 'none';

/** Per-model-call token usage and its calculated cost — one record per completed model call, including retries (each retry is its own record, never merged into the one it retried). */
export interface StepUsage {
	/** The `PlanStep.id` this call was attributed to (whichever step was `in_progress` when the call was made), or `'_setup'` for calls made before the agent has posted its first plan. */
	stepId: string;
	modelTier: ModelTier;
	inputTokens: number;
	/** Tokens served from Gemini's context cache, if the provider reports any — billed (if at all) at the cached rate, not the regular input rate. */
	cachedInputTokens?: number;
	outputTokens: number;
	inputCost: number;
	outputCost: number;
	totalCost: number;
	/** Tags this record with the exact pricing it was computed under, so a later change to the price fields in settings never silently reprices a past record — see `pricingConfigVersion()`. */
	pricingConfigVersion: string;
}

export interface UsageTotals {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
	totalCost: number;
}

interface RawUsage {
	stepId: string;
	modelTier: ModelTier;
	inputTokens: number;
	cachedInputTokens?: number;
	outputTokens: number;
}

/**
 * A short, deterministic tag for the six price figures currently in settings. Two `StepUsage`
 * records carry the same `pricingConfigVersion` exactly when their cost was computed under the
 * same prices — so the UI (or a future reconciliation) can tell an "estimated under old pricing"
 * record apart from a current one without re-deriving it from settings each time.
 */
export function pricingConfigVersion(settings: AuditorSettings): string {
	return [
		settings.baseModelInputPricePerMtok,
		settings.baseModelCachedInputPricePerMtok,
		settings.baseModelOutputPricePerMtok,
		settings.boostedModelInputPricePerMtok,
		settings.boostedModelCachedInputPricePerMtok,
		settings.boostedModelOutputPricePerMtok,
	].join('.');
}

const mtokCost = (tokens: number, pricePerMillionTokens: number): number => (tokens / 1_000_000) * pricePerMillionTokens;

/**
 * Computes a `StepUsage` record from the raw token counts Gemini reports for one call. This is
 * the only place cost arithmetic happens, so every step/run/session total shown in the UI is
 * guaranteed to be an exact sum of these records — never a separately-estimated number. Pricing is
 * always a user-supplied estimate (Gemini's response carries token counts, never a confirmed
 * dollar cost), so the UI must present every figure derived from this as "estimated".
 */
export function computeStepUsage(raw: RawUsage, settings: AuditorSettings): StepUsage {
	const cached = raw.cachedInputTokens ?? 0;
	const billableInput = Math.max(0, raw.inputTokens - cached);
	const boosted = raw.modelTier === 'boosted';
	const inputPrice = raw.modelTier === 'none' ? 0 : boosted ? settings.boostedModelInputPricePerMtok : settings.baseModelInputPricePerMtok;
	const cachedPrice = raw.modelTier === 'none' ? 0 : boosted ? settings.boostedModelCachedInputPricePerMtok : settings.baseModelCachedInputPricePerMtok;
	const outputPrice = raw.modelTier === 'none' ? 0 : boosted ? settings.boostedModelOutputPricePerMtok : settings.baseModelOutputPricePerMtok;

	const inputCost = mtokCost(billableInput, inputPrice) + mtokCost(cached, cachedPrice);
	const outputCost = mtokCost(raw.outputTokens, outputPrice);

	return {
		stepId: raw.stepId,
		modelTier: raw.modelTier,
		inputTokens: raw.inputTokens,
		cachedInputTokens: raw.cachedInputTokens,
		outputTokens: raw.outputTokens,
		inputCost,
		outputCost,
		totalCost: inputCost + outputCost,
		pricingConfigVersion: pricingConfigVersion(settings),
	};
}

export function emptyTotals(): UsageTotals {
	return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalCost: 0 };
}

/** Sums a list of `StepUsage` records — the single source of every aggregate (per-step, per-run, per-session) shown in the UI, so they can never drift apart from "sum of the displayed step values". */
export function sumUsage(records: StepUsage[]): UsageTotals {
	const totals = emptyTotals();
	for (const r of records) {
		totals.inputTokens += r.inputTokens;
		totals.cachedInputTokens += r.cachedInputTokens ?? 0;
		totals.outputTokens += r.outputTokens;
		totals.totalCost += r.totalCost;
	}
	return totals;
}

export function formatTokens(n: number): string {
	if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
	return String(n);
}

/** Formats a cost in USD for display — four decimals (per-call costs are usually sub-cent), never hiding a genuinely zero figure behind rounding. */
export function formatCost(usd: number): string {
	if (usd === 0) return '$0.00';
	if (usd < 0.0001) return '<$0.0001';
	return `$${usd.toFixed(4)}`;
}

/** One compact line for a `UsageTotals`, e.g. "12.4k in · 2.1k out · $0.0183 (est.)". */
export function formatUsageLine(totals: UsageTotals): string {
	const cachedPart = totals.cachedInputTokens > 0 ? ` (${formatTokens(totals.cachedInputTokens)} cached)` : '';
	return `${formatTokens(totals.inputTokens)} in${cachedPart} · ${formatTokens(totals.outputTokens)} out · ${formatCost(totals.totalCost)} (est.)`;
}
