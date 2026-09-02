// Transport interface plus newline-delimited JSON-RPC transport over a spawned
// child process (the MCP "stdio" transport).
//
// MCP stdio framing: each message is a single line of JSON on the child's
// stdout, terminated by \n. Messages must not contain embedded newlines.

import { spawn, type ChildProcess } from "node:child_process";

export interface Transport {
	/** Start the underlying channel. Idempotent. */
	start(): Promise<void>;
	/** Hand a JSON-RPC message to the peer. Resolves once handed off. */
	send(message: unknown): Promise<void>;
	/** Register callback for incoming messages (responses, requests, notifications). */
	onMessage(handler: (message: unknown) => void): void;
	/** Register callback for transport-level failure. */
	onError(handler: (error: Error) => void): void;
	/** Register callback for transport close. */
	onClose(handler: (error?: Error) => void): void;
	/** Record the negotiated protocol version, if the transport needs it on the wire. */
	setProtocolVersion?(version: string | null): void;
	/** Close the transport and release resources. Idempotent. */
	close(): Promise<void>;
	/** Human-readable description for logs/UI. */
	describe(): string;
}

export interface StdioTransportOptions {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Bytes of stderr kept in the ring buffer for error reporting. */
	stderrBufferSize?: number;
}

const DEFAULT_STDERR_BUFFER = 16 * 1024;

export class StdioTransport implements Transport {
	private options: StdioTransportOptions;
	private child: ChildProcess | null = null;
	private buffer = "";
	private stderrTail = "";
	private stderrBufferSize: number;
	private messageHandler: ((message: unknown) => void) | null = null;
	private errorHandler: ((error: Error) => void) | null = null;
	private closeHandler: ((error?: Error) => void) | null = null;
	private closedByUs = false;
	private closePromise: Promise<void> | null = null;
	private stderrLines: string[] = [];

	constructor(options: StdioTransportOptions) {
		this.options = options;
		this.stderrBufferSize = options.stderrBufferSize ?? DEFAULT_STDERR_BUFFER;
	}

	describe(): string {
		const args = this.options.args?.length ? ` ${this.options.args.join(" ")}` : "";
		return `stdio: ${this.options.command}${args}`;
	}

	onMessage(handler: (message: unknown) => void): void {
		this.messageHandler = handler;
	}

	onError(handler: (error: Error) => void): void {
		this.errorHandler = handler;
	}

	onClose(handler: (error?: Error) => void): void {
		this.closeHandler = handler;
	}

	async start(): Promise<void> {
		if (this.child) return;
		this.closedByUs = false;
		const env = { ...process.env, ...(this.options.env ?? {}) };
		this.child = spawn(this.options.command, this.options.args ?? [], {
			env,
			cwd: this.options.cwd,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (chunk: string) => this.handleStdout(chunk));

		this.child.stderr?.setEncoding("utf8");
		this.child.stderr?.on("data", (chunk: string) => this.handleStderr(chunk));

		this.child.on("error", (error: Error) => {
			this.errorHandler?.(new Error(`Failed to start "${this.options.command}": ${error.message}`));
		});

		this.child.on("exit", (code, signal) => {
			this.child = null;
			if (this.closedByUs) {
				this.closeHandler?.();
				return;
			}
			const detail = signal ? `signal ${signal}` : `exit code ${code}`;
			const stderrHint = this.stderrLines.length ? `\nlast stderr:\n${this.stderrLines.join("\n")}` : "";
			const error = new Error(`MCP server process terminated unexpectedly (${detail}).${stderrHint}`);
			this.errorHandler?.(error);
			this.closeHandler?.(error);
		});
	}

	async send(message: unknown): Promise<void> {
		const child = this.child;
		if (!child || !child.stdin || this.closedByUs) {
			throw new Error(`MCP server "${this.options.command}" is not running`);
		}
		const line = JSON.stringify(message);
		if (line.includes("\n")) {
			throw new Error("JSON-RPC message must not contain embedded newlines");
		}
		await new Promise<void>((resolve, reject) => {
			child.stdin!.write(line + "\n", (error) => (error ? reject(error) : resolve()));
		});
	}

	async close(): Promise<void> {
		const child = this.child;
		if (!child) return;
		this.closedByUs = true;
		this.closePromise ??= new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				if (this.child && !this.child.killed) this.child.kill("SIGKILL");
			}, 2000);
			timer.unref?.();
			const cleanup = () => {
				clearTimeout(timer);
				resolve();
			};
			if (this.child) {
				this.child.once("exit", cleanup);
				this.child.kill("SIGTERM");
				try {
					this.child.stdin?.end();
				} catch {
					// stdin already gone
				}
			} else {
				cleanup();
			}
		});
		await this.closePromise;
		this.child = null;
	}

	private handleStdout(chunk: string): void {
		this.buffer += chunk;
		let newlineIndex: number;
		while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, "").trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (!line) continue;
			let message: unknown;
			try {
				message = JSON.parse(line);
			} catch (error) {
				this.errorHandler?.(new Error(`Invalid JSON from MCP server: ${(error as Error).message}`));
				continue;
			}
			this.messageHandler?.(message);
		}
		if (this.buffer.length > this.stderrBufferSize) {
			// Pathological unframed output; drop the head so the buffer stays bounded.
			this.buffer = this.buffer.slice(-this.stderrBufferSize);
		}
	}

	private handleStderr(chunk: string): void {
		this.stderrTail = (this.stderrTail + chunk).slice(-this.stderrBufferSize);
		this.stderrLines = this.stderrTail
			.split("\n")
			.map((line) => line.trimEnd())
			.filter(Boolean)
			.slice(-8);
	}
}
