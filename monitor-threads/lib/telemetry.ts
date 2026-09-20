// monitor-threads/lib/telemetry.ts — session telemetry + footer layout.
//
// Pure functions: aggregate session usage (docs/session-format.md Usage),
// pick severity color bands, and assemble the custom footer line
// (`project ⎇ branch │ model · think │ ctx % │ cache % │ $ │ ⛏ counts`).
// No IO — everything here is unit-testable.

export type UsageStats = {
	/** % of prompt tokens served from cache: cacheRead / (cacheRead+cacheWrite+input). null when the provider reports no cache tokens. */
	cacheHitPct: number | null;
	/** Session cost total in $. */
	costTotal: number;
};

type AnyRecord = Record<string, any>;

export function computeUsageStats(entries: AnyRecord[]): UsageStats {
	let read = 0, write = 0, input = 0, costTotal = 0;
	for (const entry of entries ?? []) {
		const msg = entry?.type === "message" ? entry.message : undefined;
		const u = msg?.role === "assistant" ? msg.usage : undefined;
		if (!u) continue;
		read += u.cacheRead ?? 0;
		write += u.cacheWrite ?? 0;
		input += u.input ?? 0;
		costTotal += u.cost?.total ?? 0;
	}
	return {
		cacheHitPct: read + write > 0 ? Math.round((100 * read) / (read + write + input)) : null,
		costTotal,
	};
}

/** Severity band for a percentage. `highIsBad` flips the direction (context
 *  filling up is bad; cache hit going down is bad). Only documented theme
 *  color names: success / accent / error. */
export function bandFor(pct: number, highIsBad: boolean): "success" | "accent" | "error" {
	if (highIsBad) {
		if (pct <= 50) return "success";
		if (pct <= 80) return "accent";
		return "error";
	}
	if (pct >= 80) return "success";
	if (pct >= 50) return "accent";
	return "error";
}

/** Short display name for a model id: drops the provider prefix
 *  ("anthropic/claude-x" → "claude-x"). Pass-through when no slash. */
export function shortModelName(modelId: string | undefined): string | undefined {
	if (!modelId) return undefined;
	const last = String(modelId).split("/").pop();
	return last || undefined;
}

/** Compact context-window label: 200000 → "200k", 1000000 → "1m". */
export function formatWindow(tokens: number | undefined): string | undefined {
	if (!tokens || tokens <= 0) return undefined;
	if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

export type FooterSegment = { text: string; color?: string };

export type FooterInput = {
	project?: string;
	branch?: string | null;
	modelId?: string;
	thinking?: string;
	ctxPercent?: number | null;
	/** Context window size in tokens; when known, ctx renders as `ctx N%/1m`. */
	contextWindow?: number;
	cacheHitPct?: number | null;
	costTotal?: number;
	monitorsRunning?: number;
	crons?: number;
	monitorErrors?: number;
};

/** Assemble the target status line (color names applied by the caller):
 *  `proj ⎇ branch │ model · think │ ctx N% │ cache N% │ $C │ ⛏ M mon · C cron`
 *  Missing optional values drop their segment; separators are dim. */
export function buildFooterSegments(input: FooterInput): FooterSegment[] {
	const seg: FooterSegment[] = [];
	const sep = (): FooterSegment => ({ text: " │ ", color: "dim" });

	const head: FooterSegment[] = [];
	if (input.project) head.push({ text: input.project });
	if (input.branch) head.push({ text: `⎇ ${input.branch}` });
	if (head.length > 0) {
		seg.push({ text: head.map((s2) => s2.text).join(" "), color: head[0]?.color });
	}

	if (input.modelId || input.thinking) {
		if (seg.length > 0) seg.push(sep());
		const model = shortModelName(input.modelId);
		const parts = [model ?? input.modelId, input.thinking].filter(Boolean);
		seg.push({ text: parts.join(" · ") });
	}

	const ctx = input.ctxPercent;
	if (ctx !== undefined && ctx !== null) {
		seg.push(sep());
		const total = formatWindow(input.contextWindow);
		seg.push({ text: `ctx ${ctx}%${total ? `/${total}` : ""}`, color: bandFor(ctx, true) });
	}
	const cache = input.cacheHitPct;
	if (cache !== undefined && cache !== null) {
		seg.push(sep());
		seg.push({ text: `cache ${cache}%`, color: bandFor(cache, false) });
	}
	if (input.costTotal !== undefined && input.costTotal > 0) {
		seg.push(sep());
		seg.push({ text: `$${input.costTotal.toFixed(2)}`, color: "dim" });
	}
	const mon = input.monitorsRunning ?? 0;
	const cron = input.crons ?? 0;
	const errs = input.monitorErrors ?? 0;
	if (seg.length > 0) seg.push(sep());
	seg.push({
		text: `⛏ ${mon} mon · ${cron} cron${errs > 0 ? ` · ✗ ${errs}` : ""}`,
		color: errs > 0 ? "error" : "accent",
	});
	return seg;
}
