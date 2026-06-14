export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type FetchWithTimeout = (url: string, init?: RequestInit) => Promise<Response>;
type CheckRedirectTarget = (url: URL) => Promise<unknown>;

export type RedirectFetchOptions = {
	fetchWithTimeout: FetchWithTimeout;
	checkRedirectTarget?: CheckRedirectTarget;
	signal?: AbortSignal;
	headers?: HeadersInit;
	maxRedirects: number;
	maxBytes: number;
};

export async function fetchTextFollowingHttpsRedirects(url: string, options: RedirectFetchOptions) {
	let current = new URL(url);

	for (let depth = 0; depth <= options.maxRedirects; depth += 1) {
		if (current.protocol !== "https:") throw new Error("blocked non-HTTPS URL");
		const response = await options.fetchWithTimeout(current.toString(), {
			headers: options.headers,
			redirect: "manual",
			signal: options.signal,
		});

		if (REDIRECT_STATUSES.has(response.status)) {
			const location = response.headers.get("location");
			if (!location) throw new Error(`redirect without Location from ${current.hostname}`);
			const next = new URL(location, current);
			if (next.protocol !== "https:") throw new Error(`blocked redirect to non-HTTPS URL: ${next.toString()}`);
			await options.checkRedirectTarget?.(next);
			current = next;
			continue;
		}

		const contentType = response.headers.get("content-type") || "";
		if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
			throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
		}
		return readResponseTextWithLimit(response, options.maxBytes);
	}

	throw new Error(`too many redirects (>${options.maxRedirects}) from ${url}`);
}

export async function readResponseTextWithLimit(response: Response, maxBytes: number) {
	const length = Number(response.headers.get("content-length") || "0");
	if (length > maxBytes) throw new Error(`response too large: ${length} bytes`);
	if (!response.body) return response.text();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new Error(`response too large: >${maxBytes} bytes`);
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}
