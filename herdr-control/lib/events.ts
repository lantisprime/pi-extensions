// herdr-control: herdr socket event subscription (event-based triggers).
//
// herdr exposes a newline-delimited JSON socket API (see `herdr api schema`):
// requests are {"method","params","id"} lines; `events.subscribe` takes
// per-pane subscriptions {type, pane_id} and streams events back as JSON
// lines. The watchdog uses this instead of blind polling:
//   pane.agent_status_changed → immediate re-classify of that pane
//   pane.exited / pane.closed → immediate "gone" handling
// A slow reconcile pass remains as a safety net (event bursts surface
// `events_lost` per the 0.9.2 changelog; a dropped socket reconnects here).
//
// Verified live against herdr 0.9.3 (protocol 22): subscribe with pane ids
// returns {"result":{"type":"subscription_started"}} on the same socket.

import { connect, type Socket } from "node:net";
import { homedir } from "node:os";

export const DEFAULT_SOCKET_PATH = `${homedir()}/.config/herdr/herdr.sock`;

export type PaneEventKind =
	| "pane.agent_status_changed"
	| "pane.agent_detected"
	| "pane.exited"
	| "pane.closed";

export interface PaneEvent {
	kind: PaneEventKind;
	paneId: string;
	/** New status for pane.agent_status_changed, when present. */
	agentStatus?: string;
	raw: unknown;
}

export interface PaneEventSubscriber {
	close(): void;
	isActive(): boolean;
}

const SOCKET_CONNECT_TIMEOUT_MS = 5_000;
const RECONNECT_BACKOFF_MS = 2_000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;

/**
 * Subscribe to pane lifecycle events on the herdr socket. Reconnects with
 * backoff while `paneIds` is non-empty; call `close()` to stop for good.
 * `onEvent` is invoked per parsed event; `onDown`/`onUp` report connection
 * health transitions (the reconcile loop reacts to onDown by resubscribing).
 */
export function subscribePaneEvents(
	socketPath: string,
	paneIds: string[],
	onEvent: (event: PaneEvent) => void,
	opts: { onDown?: (error: string) => void; onUp?: () => void } = {},
): PaneEventSubscriber {
	let closed = false;
	let socket: Socket | null = null;
	let backoff = RECONNECT_BACKOFF_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let buffer = "";

	const wanted = new Set(paneIds);

	function send(sub: Socket, id: string): void {
		const subscriptions = [...wanted].map((pane_id) => ({
			type: "pane.agent_status_changed",
			pane_id,
		}));
		sub.write(JSON.stringify({ method: "events.subscribe", params: { subscriptions }, id }) + "\n");
	}

	function handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return; // not JSON — ignore
		}
		const record = parsed as { id?: string; result?: { type?: string }; error?: unknown; event?: string; pane_id?: string; agent_status?: string };
		if (record.error) {
			opts.onDown?.(`subscribe error: ${JSON.stringify(record.error).slice(0, 160)}`);
			return;
		}
		if (record.result?.type === "subscription_started") {
			backoff = RECONNECT_BACKOFF_MS;
			opts.onUp?.();
			return;
		}
		// Event envelopes carry {event, pane_id, ...} (schema: SubscriptionEventEnvelope).
		const kind = record.event as PaneEventKind | undefined;
		if (!kind || !record.pane_id) return;
		if (kind === "pane.agent_status_changed") {
			onEvent({ kind, paneId: record.pane_id, agentStatus: record.agent_status, raw: parsed });
		} else if (kind === "pane.exited" || kind === "pane.closed") {
			onEvent({ kind, paneId: record.pane_id, raw: parsed });
		}
		// pane.output_matched etc. are not consumed here.
	}

	function open(): void {
		if (closed || wanted.size === 0) return;
		const sub = connect({ path: socketPath });
		socket = sub;
		// Stale-socket guard (review BLOCKER): once a newer connection exists,
		// an OLD socket's close/error handlers must not tear the new one down
		// or schedule duplicate reconnects.
		const isCurrent = () => socket === sub;
		sub.setTimeout(SOCKET_CONNECT_TIMEOUT_MS, () => {
			sub.destroy();
		});
		sub.on("connect", () => {
			if (closed || !isCurrent()) return;
			send(sub, `events-sub-${Date.now()}`);
		});
		sub.on("data", (chunk) => {
			if (!isCurrent()) return;
			buffer += chunk.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		const down = (why: string) => {
			if (closed || !isCurrent()) return;
			socket = null;
			opts.onDown?.(why);
			if (reconnectTimer) clearTimeout(reconnectTimer); // error+close double-fire guard
			if (wanted.size > 0) {
				reconnectTimer = setTimeout(() => {
					backoff = Math.min(backoff * 2, MAX_RECONNECT_BACKOFF_MS);
					open();
				}, backoff);
				(reconnectTimer as { unref?: () => void }).unref?.();
			}
		};
		sub.on("close", () => down("socket closed"));
		sub.on("error", (err) => down(`socket error: ${err.message}`));
		sub.on("timeout", () => down("socket timeout"));
	}

	open();

	return {
		close() {
			closed = true;
			if (reconnectTimer) clearTimeout(reconnectTimer);
			socket?.destroy();
			socket = null;
		},
		isActive() {
			return !closed && socket !== null;
		},
	};
}
