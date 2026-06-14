export type SearxngSearchPlan = {
	queries: string[];
	sites: string[];
};

export type SearchCandidate = {
	title: string;
	url: string;
	snippet: string;
	provider: string;
};

export type FetchText = (url: string, signal?: AbortSignal) => Promise<string>;

export const SEARXNG_PROVIDER = "searxng";

export function normalizeSearxngUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
		if (url.protocol !== "https:") return undefined;
		if (url.pathname === "/" || url.pathname === "") url.pathname = "/search";
		url.search = "";
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

export function buildSearxngSearchUrl(baseUrl: string, query: string) {
	const normalized = normalizeSearxngUrl(baseUrl);
	if (!normalized) throw new Error("SearXNG URL must be HTTPS");
	const url = new URL(normalized);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	return url.toString();
}

export function buildSearxngQueries(plan: SearxngSearchPlan): string[] {
	if (plan.sites.length === 0) return plan.queries;
	return plan.queries.flatMap((query) => [query, ...plan.sites.map((site) => `site:${site} ${query}`)]).slice(0, 12);
}

export async function searchSearxng(
	baseUrl: string,
	plan: SearxngSearchPlan,
	maxResults: number,
	fetchText: FetchText,
	signal?: AbortSignal,
): Promise<SearchCandidate[]> {
	const seen = new Set<string>();
	const results: SearchCandidate[] = [];
	const queries = buildSearxngQueries(plan);

	for (const query of queries) {
		if (results.length >= maxResults * 2) break;
		const url = buildSearxngSearchUrl(baseUrl, query);
		const json = await fetchText(url, signal);
		for (const result of parseSearxngResults(json)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			results.push(result);
			if (results.length >= maxResults * 2) break;
		}
	}
	return results;
}

export function parseSearxngResults(json: string): SearchCandidate[] {
	let parsed: { results?: Array<{ title?: unknown; url?: unknown; content?: unknown; engine?: unknown }> };
	try {
		parsed = JSON.parse(json) as typeof parsed;
	} catch {
		throw new Error("SearXNG returned invalid JSON");
	}

	const output: SearchCandidate[] = [];
	for (const item of parsed.results || []) {
		if (typeof item.url !== "string" || typeof item.title !== "string") continue;
		let url: string;
		try {
			url = new URL(item.url).toString();
		} catch {
			continue;
		}
		const engine = typeof item.engine === "string" && item.engine.trim() ? `:${item.engine.trim()}` : "";
		output.push({
			provider: `${SEARXNG_PROVIDER}${engine}`,
			title: stripHtml(item.title),
			url,
			snippet: stripHtml(typeof item.content === "string" ? item.content : ""),
		});
	}
	return output;
}

function stripHtml(html: string) {
	return decodeHtml(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();
}

function decodeHtml(value: string) {
	return value
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&#x2F;/g, "/");
}
