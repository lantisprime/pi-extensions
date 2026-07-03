// P5d-S1: macOS cmux 0.64.17+ Unix socket client for direct cmux IPC.
// Defaults to /tmp/cmux.sock, or $CMUX_SOCKET_PATH when set.
import net from "node:net";

export const DEFAULT_CMUX_SOCKET_PATH = "/tmp/cmux.sock";
export const CMUX_SOCKET_TIMEOUT_MS = 5000;

export type CmuxSocketRequest = { id: string | number; [key: string]: unknown };
export type CmuxSocketResponse = { id?: string | number; [key: string]: unknown };

export interface CmuxSocketClient {
	send(request: CmuxSocketRequest): Promise<CmuxSocketResponse>;
	close(): void;
}

export type CmuxSocketFactory = (socketPath: string) => net.Socket;

export function createSocket(socketPath: string): net.Socket {
	return net.createConnection({ path: socketPath });
}

type PendingRequest = {
	resolve: (response: CmuxSocketResponse) => void;
	reject: (err: Error) => void;
	timer: NodeJS.Timeout;
};

export function createCmuxSocketClient(
	socketPath = process.env.CMUX_SOCKET_PATH || DEFAULT_CMUX_SOCKET_PATH,
	socketFactory: CmuxSocketFactory = createSocket,
): CmuxSocketClient {
	let socket: net.Socket | null = null;
	let connected = false;
	let connecting: Promise<void> | null = null;
	let buffer = "";
	const pending = new Map<string | number, PendingRequest>();

	function rejectPending(err: Error): void {
		for (const request of pending.values()) {
			clearTimeout(request.timer);
			request.reject(err);
		}
		pending.clear();
	}

	function disconnect(err?: Error): void {
		connected = false;
		connecting = null;
		if (socket) {
			socket.removeAllListeners();
			socket.destroy();
			socket = null;
		}
		if (err) rejectPending(err);
	}

	function handleResponse(response: CmuxSocketResponse): void {
		const id = response.id;
		if (id === undefined) return;
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		clearTimeout(request.timer);
		request.resolve(response);
	}

	function parseBuffer(): void {
		for (;;) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) break;
			const raw = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!raw) continue;
			try {
				handleResponse(JSON.parse(raw) as CmuxSocketResponse);
			} catch (err: any) {
				disconnect(err instanceof Error ? err : new Error(String(err)));
			}
		}

		const trimmed = buffer.trim();
		if (!trimmed) return;
		try {
			handleResponse(JSON.parse(trimmed) as CmuxSocketResponse);
			buffer = "";
		} catch {
			// Keep partial JSON buffered until the socket supplies the rest.
		}
	}

	async function ensureConnected(): Promise<net.Socket> {
		if (socket && connected) return socket;
		if (connecting && socket) {
			await connecting;
			return socket;
		}

		buffer = "";
		socket = socketFactory(socketPath);
		socket.setEncoding("utf8");
		connecting = new Promise<void>((resolve, reject) => {
			const onConnect = () => {
				connected = true;
				cleanup();
				resolve();
			};
			const onError = (err: Error) => {
				cleanup();
				disconnect(err);
				reject(err);
			};
			const cleanup = () => {
				socket?.off("connect", onConnect);
				socket?.off("error", onError);
			};
			socket?.once("connect", onConnect);
			socket?.once("error", onError);
		});
		socket.on("data", (chunk) => {
			buffer += String(chunk);
			parseBuffer();
		});
		socket.on("error", (err: NodeJS.ErrnoException) => {
			disconnect(err);
		});
		socket.on("close", () => {
			disconnect(new Error("cmux socket closed"));
		});
		socket.on("end", () => {
			disconnect(new Error("cmux socket ended"));
		});

		await connecting;
		return socket;
	}

	return {
		async send(request) {
			const activeSocket = await ensureConnected();
			const payload = JSON.stringify(request) + "\n";
			return await new Promise<CmuxSocketResponse>((resolve, reject) => {
				const timer = setTimeout(() => {
					pending.delete(request.id);
					reject(new Error("cmux socket request timed out after " + CMUX_SOCKET_TIMEOUT_MS + "ms"));
				}, CMUX_SOCKET_TIMEOUT_MS);
				pending.set(request.id, { resolve, reject, timer });
				activeSocket.write(payload, (err?: Error) => {
					if (!err) return;
					clearTimeout(timer);
					pending.delete(request.id);
					disconnect(err);
					reject(err);
				});
			});
		},
		close() {
			disconnect();
			rejectPending(new Error("cmux socket closed"));
		},
	};
}
