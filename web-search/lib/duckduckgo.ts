export type DuckDuckGoSearchPlan = {
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

export const DUCKDUCKGO_HTML_PROVIDER = "duckduckgo-html";

export function buildDuckDuckGoHtmlSearchUrl(query: string) {
	return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
}

export function buildDuckDuckGoQueries(plan: DuckDuckGoSearchPlan): string[] {
	if (plan.sites.length === 0) return plan.queries;
	return plan.queries.flatMap((query) => [query, ...plan.sites.map((site) => `site:${site} ${query}`)]).slice(0, 12);
}

export async function searchDuckDuckGoHtml(
	plan: DuckDuckGoSearchPlan,
	maxResults: number,
	fetchText: FetchText,
	signal?: AbortSignal,
): Promise<SearchCandidate[]> {
	const seen = new Set<string>();
	const results: SearchCandidate[] = [];
	const queries = buildDuckDuckGoQueries(plan);

	for (const query of queries) {
		if (results.length >= maxResults * 2) break;
		const url = buildDuckDuckGoHtmlSearchUrl(query);
		const html = await fetchText(url, signal);
		for (const result of parseDuckDuckGoResults(html)) {
			if (seen.has(result.url)) continue;
			seen.add(result.url);
			results.push(result);
			if (results.length >= maxResults * 2) break;
		}
	}
	return results;
}

export function parseDuckDuckGoResults(html: string): SearchCandidate[] {
	const results: SearchCandidate[] = [];
	const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = resultRegex.exec(html))) {
		const url = decodeDuckDuckGoUrl(decodeHtml(match[1]));
		if (!url) continue;
		results.push({
			provider: DUCKDUCKGO_HTML_PROVIDER,
			title: stripHtml(match[2]),
			url,
			snippet: stripHtml(match[3]),
		});
	}
	return results;
}

export function decodeDuckDuckGoUrl(raw: string) {
	try {
		const parsed = new URL(raw, "https://duckduckgo.com");
		if (isKnownAdOrTrackingUrl(parsed)) return undefined;
		const uddg = parsed.searchParams.get("uddg");
		const candidate = new URL(uddg || parsed.toString());
		if (isKnownAdOrTrackingUrl(candidate)) return undefined;
		return candidate.toString();
	} catch {
		return undefined;
	}
}

function isKnownAdOrTrackingUrl(url: URL) {
	const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
	const pathname = url.pathname.toLowerCase();
	if (hostname === "duckduckgo.com" && pathname === "/y.js") return true;
	if ((hostname === "bing.com" || hostname.endsWith(".bing.com")) && pathname === "/aclick") return true;
	if (url.searchParams.has("ad_domain") || url.searchParams.has("ad_provider") || url.searchParams.has("ad_type")) {
		return true;
	}
	return false;
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
