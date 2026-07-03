// cmux-control: explicit guard for GUI focus-stealing operations.

export type FocusOp = "select-workspace" | "focus-pane" | "focus-panel" | "tab-action";

export interface FocusOpts {
	/** Explicit opt-in: "I know this will change what the user sees." */
	iMeanFocus?: boolean;
	/** If set, ask the caller for confirmation instead of refusing. */
	requireConfirmation?: boolean;
}

/** Returns whether the operation can proceed or how the caller must handle it. */
export function checkFocusOp(
	op: FocusOp,
	opts: FocusOpts = {},
):
	| { allowed: true }
	| { allowed: false; reason: string }
	| { needsConfirmation: true; op: FocusOp } {
	if (opts.iMeanFocus === true) return { allowed: true };
	if (opts.requireConfirmation) return { needsConfirmation: true, op };
	return {
		allowed: false,
		reason: `Focus operation "${op}" changes what the user sees; pass iMeanFocus: true to opt in.`,
	};
}
