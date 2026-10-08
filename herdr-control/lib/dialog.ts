// herdr blocked-state reporting for modal dialogs.
//
// herdr's pi integration (herdr-agent-state.ts) listens on "herdr:blocked" and
// marks the pane "blocked" while active, so supervisors waiting on
// `herdr agent wait` / `prompt --wait` can see the agent is stuck on a modal
// dialog instead of appearing to work. Emitting to a bus with no listener
// (plain pi, herdr integration absent) is a no-op that cannot throw. Same
// contract as permission-policy's emitPermissionDialogBlocked.
import type { EventBus, ExtensionContext } from "@earendil-works/pi-coding-agent";

export function emitDialogBlocked(events: EventBus | undefined, active: boolean, label?: string): void {
	if (!events) return;
	try {
		events.emit("herdr:blocked", active ? { active: true, label } : { active: false });
	} catch {
		// Never let blocked-state reporting break the dialog flow.
	}
}

// ctx.ui.confirm wrapped in herdr blocked-state reporting. ALWAYS clears the
// state, even when the dialog throws or is cancelled.
export async function confirmWithBlocked(
	ctx: ExtensionContext,
	events: EventBus | undefined,
	title: string,
	message: string,
	label: string,
): Promise<boolean> {
	emitDialogBlocked(events, true, label);
	try {
		return await ctx.ui.confirm(title, message);
	} finally {
		emitDialogBlocked(events, false);
	}
}
