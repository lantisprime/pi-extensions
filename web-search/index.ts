import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { scanTextForAgentRisk, type AgentRiskScanResult } from "./lib/security-scan";
import { Type } from "typebox";
import dns from "node:dns/promises";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const TOOL_NAME = "secure_web_search";
const USER_AGENT = "pi-secure-web-search/0.1 (+https://pi.dev)";
const DNSBL_ZONES = ["zen.spamhaus.org", "bl.spamcop.net"];
const SECURE_DNS_PROVIDERS = [
	{ name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query", blocksMalware: false },
	{ name: "Google", url: "https://dns.google/resolve", blocksMalware: false },
	{ name: "Quad9", url: "https://dns.quad9.net/dns-query", blocksMalware: true },
	{ name: "Cloudflare Family", url: "https://family.cloudflare-dns.com/dns-query", blocksMalware: true },
] as const;
const DEFAULT_MAX_RESULTS = 5;
const FETCH_TIMEOUT_MS = 12_000;
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "web-search", "config.json");

type WebSearchConfig = {
	updatedAt: string;
	ipUrls: string[];
};

type SearchPlan = {
	queries: string[];
	sites: string[];
};

type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	security: SecurityReport;
	contentScan: AgentRiskScanResult;
	contentPreview?: string;
	previewOmitted?: string;
};

type SecurityReport = {
	hostname: string;
	ssl: "validated-by-node-fetch";
	dns: "ok" | "raw-ip";
	secureDns: "ok" | "not-applicable";
	malwareDns: "not-blocked" | "not-applicable";
	addresses: string[];
	dnsbl: "not-listed";
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("web-search-ip", {
		description: "Manage secure_web_search saved IP URLs: add <ip|https://ip/>, remove <ip|https://ip/>, list, reset",
		handler: async (args, ctx) => {
			const [rawAction = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const action = rawAction.toLowerCase();
			const value = rest.join(" ");
			const config = await loadConfig();

			if (action === "list") {
				ctx.ui.notify(formatSavedIpUrls(config), "info");
				return;
			}

			if (action === "reset" || action === "clear") {
				await saveConfig({ updatedAt: new Date().toISOString(), ipUrls: [] });
				ctx.ui.notify("Cleared saved web-search IP URLs", "info");
				return;
			}

			if (action === "add") {
				const normalized = normalizeIpUrl(value);
				if (!normalized) {
					ctx.ui.notify("Usage: /web-search-ip add <ip|https://ip/>", "warning");
					return;
				}
				if (!config.ipUrls.includes(normalized)) config.ipUrls.push(normalized);
				config.updatedAt = new Date().toISOString();
				await saveConfig(config);
				ctx.ui.notify(`Saved web-search IP URL: ${normalized}`, "info");
				return;
			}

			if (action === "remove" || action === "delete") {
				const normalized = normalizeIpUrl(value);
				if (!normalized) {
					ctx.ui.notify("Usage: /web-search-ip remove <ip|https://ip/>", "warning");
					return;
				}
				config.ipUrls = config.ipUrls.filter((url) => url !== normalized);
				config.updatedAt = new Date().toISOString();
				await saveConfig(config);
				ctx.ui.notify(`Removed web-search IP URL: ${normalized}`, "info");
				return;
			}

			ctx.ui.notify("Usage: /web-search-ip add|remove|list|reset", "warning");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Secure Web Search",
		description:
			"Search the web with security checks. Uses the current LLM to suggest relevant sites/queries, validates HTTPS/TLS, checks DNS consistency with secure DNS providers, checks malware-filtering DNS, and rejects DNSBL-listed hosts.",
		promptSnippet: "Search the web with HTTPS, secure DNS, malware DNS, and DNSBL security checks",
		promptGuidelines: [
			"Use secure_web_search when the user asks for current external information or web research.",
			"secure_web_search returns URLs and previews; cite URLs when using its results.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Information to search for" }),
			sites: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional domains or IP addresses to prioritize in search, e.g. ['docs.python.org', 'github.com', '203.0.113.10']",
				}),
			),
			urls: Type.Optional(
				Type.Array(Type.String(), {
					description: "Optional explicit HTTPS URLs to security-check and fetch directly, including public or private/local IP URLs, e.g. ['https://192.168.1.1/']",
				}),
			),
			maxResults: Type.Optional(Type.Number({ description: "Maximum results to return", minimum: 1, maximum: 10 })),
			fetchPages: Type.Optional(
				Type.Boolean({ description: "Fetch result pages and include text previews after security checks" }),
			),
			includeRiskyContent: Type.Optional(
				Type.Boolean({ description: "Include suspicious/dangerous fetched content previews instead of omitting them. Default false." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const maxResults = Math.max(1, Math.min(Number(params.maxResults || DEFAULT_MAX_RESULTS), 10));
			const config = await loadConfig();
			const plan = await createSearchPlan(ctx, params.question, params.sites || [], signal);
			onUpdate?.({ content: [{ type: "text", text: `Search plan: ${plan.queries.join(" | ")}` }] });

			const explicitUrls = [...config.ipUrls, ...(params.urls || [])];
			const explicitResults = explicitUrls.map((url) => ({
				title: `User/config supplied URL: ${url}`,
				url,
				snippet: "Explicit URL supplied by the user or saved config for security checking and fetching.",
			}));
			const rawResults = [...explicitResults, ...(await searchDuckDuckGo(plan, maxResults, signal))];
			const results: SearchResult[] = [];
			const rejected: Array<{ url: string; reason: string }> = [];

			for (const raw of rawResults) {
				if (results.length >= maxResults) break;
				try {
					const security = await securityCheckUrl(raw.url, signal);
					let contentPreview: string | undefined;
					let previewOmitted: string | undefined;
					let scanInput = `${raw.title}\n${raw.snippet}`;
					if (params.fetchPages !== false) {
						const fetchedPreview = await fetchPagePreview(raw.url, signal);
						scanInput += `\n${fetchedPreview}`;
						const previewScan = scanTextForAgentRisk(scanInput, { source: "web", provenance: "external" });
						if (previewScan.risk === "safe" || params.includeRiskyContent === true) {
							contentPreview = fetchedPreview;
						} else {
							previewOmitted = `Preview omitted because web content scan was ${previewScan.risk}. Use includeRiskyContent=true only for security research.`;
						}
					}
					const contentScan = scanTextForAgentRisk(scanInput, { source: "web", provenance: "external" });
					results.push({ ...raw, security, contentScan, contentPreview, previewOmitted });
				} catch (error) {
					rejected.push({ url: raw.url, reason: error instanceof Error ? error.message : String(error) });
				}
			}

			return {
				content: [
					{
						type: "text",
						text: formatResults(params.question, plan, results, rejected),
					},
				],
				details: { question: params.question, plan, savedIpUrls: config.ipUrls, results, rejected },
			};
		},
	});
}

async function loadConfig(): Promise<WebSearchConfig> {
	try {
		const text = await fs.readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(text) as Partial<WebSearchConfig>;
		return {
			updatedAt: parsed.updatedAt || new Date().toISOString(),
			ipUrls: Array.isArray(parsed.ipUrls) ? (parsed.ipUrls.map(normalizeIpUrl).filter(Boolean) as string[]) : [],
		};
	} catch {
		return { updatedAt: new Date().toISOString(), ipUrls: [] };
	}
}

async function saveConfig(config: WebSearchConfig) {
	await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	await fs.writeFile(CONFIG_PATH, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

function formatSavedIpUrls(config: WebSearchConfig) {
	return [
		`Saved web-search IP URLs (${CONFIG_PATH}):`,
		...(config.ipUrls.length ? config.ipUrls.map((url) => `- ${url}`) : ["- none"]),
		"",
		"Use /web-search-ip add <ip|https://ip/> to add one.",
	].join("\n");
}

function normalizeIpUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	try {
		const ipVersion = net.isIP(trimmed);
		if (ipVersion === 4) return `https://${trimmed}/`;
		if (ipVersion === 6) return `https://[${trimmed}]/`;
		const url = new URL(trimmed);
		if (url.protocol !== "https:") return undefined;
		const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
		if (!net.isIP(hostname)) return undefined;
		return url.toString();
	} catch {
		return undefined;
	}
}

async function createSearchPlan(
	ctx: ExtensionContext,
	question: string,
	requestedSites: string[],
	signal?: AbortSignal,
): Promise<SearchPlan> {
	const fallbackSites = requestedSites.map(cleanDomain).filter(Boolean).slice(0, 5) as string[];
	const fallback = { queries: [question], sites: fallbackSites };
	if (!ctx.model) return fallback;

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return fallback;
		const message: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Question: ${question}\nUser requested sites: ${requestedSites.join(", ") || "none"}\n\nReturn JSON only: {"queries":["..."],"sites":["domain.com"]}. Pick reputable, relevant sources. Prefer official docs, standards bodies, vendor docs, academic/government sources, and primary sources. Maximum 3 queries and 5 sites.`,
				},
			],
			timestamp: Date.now(),
		};
		const response = await complete(
			ctx.model,
			{
				systemPrompt:
					"You plan web searches. Return strict JSON only. Do not include markdown. Do not invent obscure domains; choose reputable relevant websites.",
				messages: [message],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n")
			.trim();
		const parsed = JSON.parse(text) as Partial<SearchPlan>;
		return {
			queries: sanitizeList(parsed.queries, [question]).slice(0, 3),
			sites: [...new Set([...fallbackSites, ...sanitizeList(parsed.sites, []).map(cleanDomain).filter(Boolean)])].slice(
				0,
				5,
			) as string[],
		};
	} catch {
		return fallback;
	}
}

async function searchDuckDuckGo(plan: SearchPlan, maxResults: number, signal?: AbortSignal) {
	const seen = new Set<string>();
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const queries = buildQueries(plan);

	for (const query of queries) {
		if (results.length >= maxResults * 2) break;
		const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
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

function buildQueries(plan: SearchPlan): string[] {
	if (plan.sites.length === 0) return plan.queries;
	return plan.queries.flatMap((query) => [query, ...plan.sites.map((site) => `site:${site} ${query}`)]).slice(0, 12);
}

function parseDuckDuckGoResults(html: string) {
	const results: Array<{ title: string; url: string; snippet: string }> = [];
	const resultRegex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;
	while ((match = resultRegex.exec(html))) {
		const url = decodeDuckDuckGoUrl(decodeHtml(match[1]));
		if (!url) continue;
		results.push({ title: stripHtml(match[2]), url, snippet: stripHtml(match[3]) });
	}
	return results;
}

async function securityCheckUrl(rawUrl: string, signal?: AbortSignal): Promise<SecurityReport> {
	const url = new URL(rawUrl);
	if (url.protocol !== "https:") throw new Error("blocked non-HTTPS URL");
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const ipVersion = net.isIP(hostname);
	if (ipVersion) {
		await checkDnsbl([hostname]);
		// A HEAD request still forces Node/fetch TLS certificate validation. Many raw-IP HTTPS
		// endpoints will fail here unless the certificate is valid for the IP address.
		await fetchWithTimeout(url.toString(), { method: "HEAD", redirect: "manual", signal });
		return {
			hostname,
			ssl: "validated-by-node-fetch",
			dns: "raw-ip",
			secureDns: "not-applicable",
			malwareDns: "not-applicable",
			addresses: [hostname],
			dnsbl: "not-listed",
		};
	}
	const addresses = await resolveWithConsistencyCheck(hostname);
	await checkDnsbl(addresses);
	// A HEAD request forces Node/fetch TLS certificate and hostname validation.
	await fetchWithTimeout(url.toString(), { method: "HEAD", redirect: "manual", signal });
	return {
		hostname,
		ssl: "validated-by-node-fetch",
		dns: "ok",
		secureDns: "ok",
		malwareDns: "not-blocked",
		addresses,
		dnsbl: "not-listed",
	};
}

async function resolveWithConsistencyCheck(hostname: string): Promise<string[]> {
	const system = await resolveHost(hostname);
	if (system.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);

	const providerResults = await Promise.all(
		SECURE_DNS_PROVIDERS.map(async (provider) => ({
			provider,
			addresses: await resolveDoh(hostname, provider.url).catch(() => []),
		})),
	);

	const trustedAddresses = providerResults
		.filter((result) => !result.provider.blocksMalware)
		.flatMap((result) => result.addresses);
	const overlap = system.filter((address) => trustedAddresses.includes(address));
	if (overlap.length === 0) {
		throw new Error(`secure DNS consistency check failed for ${hostname}`);
	}

	const malwareBlocks = providerResults.filter(
		(result) => result.provider.blocksMalware && result.addresses.length === 0,
	);
	if (malwareBlocks.length > 0) {
		throw new Error(
			`blocked by malware-filtering DNS: ${malwareBlocks.map((result) => result.provider.name).join(", ")}`,
		);
	}

	return overlap;
}

async function resolveHost(hostname: string): Promise<string[]> {
	const records = await dns.lookup(hostname, { all: true, verbatim: false });
	return records.map((record) => record.address).filter((address) => net.isIP(address));
}

async function resolveDoh(hostname: string, endpoint: string): Promise<string[]> {
	const answers = await Promise.all([resolveDohType(hostname, endpoint, "A"), resolveDohType(hostname, endpoint, "AAAA")]);
	return [...new Set(answers.flat())].filter((address) => net.isIP(address));
}

async function resolveDohType(hostname: string, endpoint: string, type: "A" | "AAAA"): Promise<string[]> {
	const url = new URL(endpoint);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetchWithTimeout(url.toString(), {
		headers: { accept: "application/dns-json", "user-agent": USER_AGENT },
	});
	const data = (await response.json()) as { Status?: number; Answer?: Array<{ data?: string; type?: number }> };
	if (data.Status !== 0) return [];
	const expectedType = type === "A" ? 1 : 28;
	return (data.Answer || [])
		.filter((answer) => answer.type === expectedType && answer.data)
		.map((answer) => answer.data as string);
}

async function checkDnsbl(addresses: string[]) {
	for (const address of addresses) {
		if (net.isIP(address) !== 4) continue;
		const reversed = address.split(".").reverse().join(".");
		for (const zone of DNSBL_ZONES) {
			try {
				await dns.resolve4(`${reversed}.${zone}`);
				throw new Error(`DNSBL listed: ${address} in ${zone}`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("DNSBL listed")) throw error;
			}
		}
	}
}

async function fetchPagePreview(url: string, signal?: AbortSignal) {
	const html = await fetchText(url, signal);
	return stripHtml(html).replace(/\s+/g, " ").slice(0, 2000);
}

async function fetchText(url: string, signal?: AbortSignal) {
	const response = await fetchWithTimeout(url, {
		headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
		signal,
	});
	const contentType = response.headers.get("content-type") || "";
	if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
		throw new Error(`unsupported content-type: ${contentType || "unknown"}`);
	}
	return response.text();
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	const parentSignal = init.signal;
	const abort = () => controller.abort();
	parentSignal?.addEventListener("abort", abort, { once: true });
	try {
		const response = await fetch(url, { ...init, signal: controller.signal, redirect: init.redirect || "follow" });
		if (!response.ok && response.status >= 400) throw new Error(`HTTP ${response.status}`);
		return response;
	} finally {
		clearTimeout(timeout);
		parentSignal?.removeEventListener("abort", abort);
	}
}

function formatResults(question: string, plan: SearchPlan, results: SearchResult[], rejected: Array<{ url: string; reason: string }>) {
	const lines = [`Secure web search for: ${question}`, "", `Queries: ${plan.queries.join(" | ")}`];
	if (plan.sites.length) lines.push(`Preferred sites: ${plan.sites.join(", ")}`);
	lines.push("", "Results:");
	if (!results.length) lines.push("No results passed security checks.");
	for (const [index, result] of results.entries()) {
		const dnsText = result.security.dns === "raw-ip"
			? `raw IP checked (${result.security.addresses.join(", ")}), DNSBL not listed`
			: `secure DNS ok (${result.security.addresses.join(", ")}), malware DNS not blocked, DNSBL not listed`;
		lines.push(
			`\n${index + 1}. ${result.title}`,
			`URL: ${result.url}`,
			`Security: HTTPS validated, ${dnsText}, content scan: ${result.contentScan.risk}`,
			`Snippet: ${result.snippet}`,
		);
		if (result.contentScan.risk !== "safe") {
			lines.push("Content scan findings:");
			for (const finding of result.contentScan.findings.slice(0, 5)) {
				lines.push(`- ${finding.category}: ${finding.reason} (${finding.match})`);
			}
		}
		if (result.previewOmitted) lines.push(result.previewOmitted);
		if (result.contentPreview) lines.push(`Preview: ${result.contentPreview}`);
	}
	if (rejected.length) {
		lines.push("", "Rejected by security checks:");
		for (const item of rejected.slice(0, 10)) lines.push(`- ${item.url}: ${item.reason}`);
	}
	return lines.join("\n");
}

function decodeDuckDuckGoUrl(raw: string) {
	try {
		const parsed = new URL(raw, "https://duckduckgo.com");
		const uddg = parsed.searchParams.get("uddg");
		const url = uddg || parsed.toString();
		return new URL(url).toString();
	} catch {
		return undefined;
	}
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

function sanitizeList(value: unknown, fallback: string[]) {
	if (!Array.isArray(value)) return fallback;
	return value.map((item) => String(item).trim()).filter(Boolean);
}

function cleanDomain(value: string) {
	try {
		const withProtocol = value.includes("://") ? value : `https://${value}`;
		return new URL(withProtocol).hostname.toLowerCase().replace(/^www\./, "");
	} catch {
		return "";
	}
}
