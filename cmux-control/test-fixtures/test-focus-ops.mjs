// P5d-S2: cmux-control focus-op guard tests.
import assert from "node:assert/strict";
import { checkFocusOp } from "../lib/focus-ops.ts";

const allOps = ["select-workspace", "focus-pane", "focus-panel", "tab-action"];

// AllowedWithFlag
{
	assert.deepEqual(checkFocusOp("select-workspace", { iMeanFocus: true }), { allowed: true });
}

// NeedsConfirmation
{
	assert.deepEqual(checkFocusOp("focus-pane", { requireConfirmation: true }), {
		needsConfirmation: true,
		op: "focus-pane",
	});
}

// BlockedWithoutFlag
{
	const result = checkFocusOp("focus-panel");
	assert.equal(result.allowed, false);
	assert.match(result.reason, /iMeanFocus: true/);
}

// AllOpsSupported
{
	for (const op of allOps) {
		assert.deepEqual(checkFocusOp(op, { iMeanFocus: true }), { allowed: true });
		assert.deepEqual(checkFocusOp(op, { requireConfirmation: true }), { needsConfirmation: true, op });

		const blocked = checkFocusOp(op);
		assert.equal(blocked.allowed, false);
		assert.match(blocked.reason, new RegExp(op));
	}
}
