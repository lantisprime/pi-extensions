// Shared error types for the MCP client.

/** Raised when a server reports the HTTP session as expired (404). */
export class SessionExpiredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionExpiredError";
	}
}
