// context-used-status — show ACTUAL context-window tokens used in pi's footer.
//
// Adds a colored status item ("ctx 21% (42.3k/200k)") next to the default
// footer info (cwd/branch/model/cost/thinking). Data comes straight from
// ctx.getContextUsage() — never re-derived, never a setFooter replacement.
//
// Spec: .plans/FOOTER/spec.md@aac25319 (v1.1.0)
//   AC-1 format: percent first, tokens/window in parens
//   AC-2 fallback: dim "ctx –" when usage is unknown (right after compaction)
//   AC-3 whole-item color: dim <70%, warning 70–89.99%, error ≥90%, dim when null
//   AC-4 reactive on session_start / turn_end / session_compact / model_select,
//       plus /context-used toggle (default on)
//   AC-5 no regression: setStatus only; default footer untouched

import type { ContextUsage, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "context-used";
const WARN_PERCENT = 70;
const ERROR_PERCENT = 90;

/** Compact token rendering: 999 -> "999", 42300 -> "42.3k", 200000 -> "200k". */
function fmtTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = (n / 1000).toFixed(1);
	return `${k.endsWith(".0") ? k.slice(0, -2) : k}k`;
}

export default function (pi: ExtensionAPI) {
	let enabled = true;

	/** Render (or clear) the status item from live context usage. */
	function update(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const usage: ContextUsage | undefined = ctx.getContextUsage();
		if (!usage || usage.tokens === null || usage.percent === null) {
			// AC-2: unknown right after compaction / before next LLM response.
			ctx.ui.setStatus(STATUS_KEY, theme.fg("dim", "ctx –"));
			return;
		}
		// AC-1: percent first, tokens/window in parens.
		const text = `ctx ${Math.round(usage.percent)}% (${fmtTokens(usage.tokens)}/${fmtTokens(usage.contextWindow)})`;
		// AC-3: whole item carries the threshold color.
		const color: "dim" | "warning" | "error" =
			usage.percent >= ERROR_PERCENT ? "error" : usage.percent >= WARN_PERCENT ? "warning" : "dim";
		ctx.ui.setStatus(STATUS_KEY, theme.fg(color, text));
	}

	pi.on("session_start", (_event, ctx) => update(ctx));
	pi.on("turn_end", (_event, ctx) => update(ctx));
	pi.on("session_compact", (_event, ctx) => update(ctx));
	pi.on("model_select", (_event, ctx) => update(ctx));

	pi.registerCommand("context-used", {
		description: "Toggle the context-used footer status item",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			if (enabled) {
				update(ctx);
			} else if (ctx.hasUI) {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
			ctx.ui.notify(`context-used: ${enabled ? "on" : "off"}`, "info");
		},
	});
}
