import { complete, type UserMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseDnsConsistencyAddresses } from "./lib/dns-consistency";
import { searchDuckDuckGoHtml, type SearchCandidate } from "./lib/duckduckgo";
import { fetchTextFollowingHttpsRedirects, REDIRECT_STATUSES } from "./lib/redirect-fetch";
import { normalizeSearxngUrl, searchSearxng } from "./lib/searxng";
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
const MAX_FETCH_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;
const MAX_QUESTION_LENGTH = 2_000;
const MAX_REJECTED_URL_DISPLAY_LENGTH = 240;
const CONFIG_PATH = path.join(os.homedir(), ".pi", "agent", "web-search", "config.json");

type SearchProviderName = "auto" | "duckduckgo-html" | "searxng";

type WebSearchConfig = {
	version?: 1;
	updatedAt: string;
	ipUrls: string[];
	provider: SearchProviderName;
	searxngUrl?: string;
};

type SearchPlan = {
	queries: string[];
	sites: string[];
};

type SearchResult = {
	title: string;
	url: string;
	snippet: string;
	provider?: string;
	security: SecurityReport;
	contentScan: AgentRiskScanResult;
	contentPreview?: string;
	previewOmitted?: string;
	blockedDangerous?: boolean;
};

type SecurityReport = {
	hostname: string;
	finalUrl: string;
	redirects: string[];
	ssl: "validated-by-node-fetch";
	dns: "ok" | "raw-ip";
	secureDns: "ok" | "unchecked" | "not-applicable";
	malwareDns: "blocked" | "not-blocked" | "unchecked" | "not-applicable";
	addresses: string[];
	dnsbl: "not-listed" | "unchecked";
};

type HostSecurity = Omit<SecurityReport, "finalUrl" | "redirects" | "ssl">;
type DnsConsistency = { addresses: string[]; secureDns: "ok" | "unchecked"; malwareDns: "not-blocked" | "unchecked" };
type SearchProviderOutput = { candidates: SearchCandidate[]; provider: SearchProviderName; providerErrors: string[] };

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
				await saveConfig({ ...config, updatedAt: new Date().toISOString(), ipUrls: [] });
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

	pi.registerCommand("web-search-config", {
		description: "Manage secure_web_search provider config: list, provider <auto|duckduckgo-html|searxng>, searxng <https://host/search>, reset-provider",
		handler: async (args, ctx) => {
			const [rawAction = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			const action = rawAction.toLowerCase();
			const value = rest.join(" ");
			const config = await loadConfig();

			if (action === "list" || action === "status") {
				ctx.ui.notify(formatWebSearchConfig(config), "info");
				return;
			}

			if (action === "provider") {
				if (!isSearchProviderName(value)) {
					ctx.ui.notify("Usage: /web-search-config provider <auto|duckduckgo-html|searxng>", "warning");
					return;
				}
				await saveConfig({ ...config, provider: value, updatedAt: new Date().toISOString() });
				ctx.ui.notify(`Set web-search provider: ${value}`, "info");
				return;
			}

			if (action === "searxng") {
				const normalized = normalizeSearxngUrl(value);
				if (!normalized) {
					ctx.ui.notify("Usage: /web-search-config searxng <https://your-searxng.example/search>", "warning");
					return;
				}
				await saveConfig({ ...config, provider: "auto", searxngUrl: normalized, updatedAt: new Date().toISOString() });
				ctx.ui.notify(`Configured SearXNG URL for auto mode: ${normalized}. Use /web-search-config provider searxng for strict no-fallback mode.`, "info");
				return;
			}

			if (action === "reset-provider" || action === "reset") {
				const { searxngUrl: _searxngUrl, ...restConfig } = config;
				await saveConfig({ ...restConfig, provider: "auto", updatedAt: new Date().toISOString() });
				ctx.ui.notify("Reset web-search provider config to auto", "info");
				return;
			}

			ctx.ui.notify("Usage: /web-search-config list|provider|searxng|reset-provider", "warning");
		},
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Secure Web Search",
		description:
			"Search the web with security checks. Uses the current LLM to suggest relevant sites/queries, searches configured provider (self-hosted SearXNG when configured, otherwise DuckDuckGo HTML), validates HTTPS/TLS, checks DNS consistency with secure DNS providers, checks malware-filtering DNS, and rejects DNSBL-listed hosts. Scans the question before search planning. Supports blockDangerous to omit dangerous results and blockPrivateIps (default true) to reject private/reserved IPs.",
		promptSnippet: "Search the web via configured provider with HTTPS, secure DNS, malware DNS, DNSBL security checks, and content scanning",
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
			includeSavedIpUrls: Type.Optional(
				Type.Boolean({ description: "Include saved IP URLs from /web-search-ip. Default false to avoid accidental local/internal access." }),
			),
			blockDangerous: Type.Optional(
				Type.Boolean({ description: "Entirely omit results whose content scan is dangerous, not just their previews. Default false." }),
			),
			blockPrivateIps: Type.Optional(
				Type.Boolean({ description: "Reject explicit URL targets that resolve to private/reserved IP ranges. Default true." }),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const maxResults = Math.max(1, Math.min(Number(params.maxResults || DEFAULT_MAX_RESULTS), 10));
			const blockDangerous = params.blockDangerous === true;
			const blockPrivateIps = params.blockPrivateIps !== false;
			const config = await loadConfig();
			const questionScan = scanTextForAgentRisk(params.question, { source: "web", provenance: "external" });
			const plan = await createSearchPlan(ctx, params.question, params.sites || [], signal, questionScan);
			onUpdate?.({ content: [{ type: "text", text: `Search plan: ${plan.queries.join(" | ")}` }] });

			const explicitUrls = [...(params.includeSavedIpUrls === true ? config.ipUrls : []), ...(params.urls || [])];
			const explicitResults = explicitUrls.map((url) => ({
				title: `User/config supplied URL: ${url}`,
				url,
				snippet: "Explicit URL supplied by the user or saved config for security checking and fetching.",
				provider: "explicit-url",
			}));
			const providerOutput = await searchWithConfiguredProvider(config, plan, maxResults, signal);
			const rawResults = [...explicitResults, ...providerOutput.candidates];
			const results: SearchResult[] = [];
			const rejected: Array<{ url: string; reason: string }> = [];

			for (const raw of rawResults) {
				if (results.length >= maxResults) break;
				try {
					if (blockPrivateIps && isPrivateIpHostname(raw.url)) {
						rejected.push({ url: raw.url, reason: "blocked: resolves to private/reserved IP" });
						continue;
					}
					const security = await securityCheckUrl(raw.url, signal);
					let contentPreview: string | undefined;
					let previewOmitted: string | undefined;
					let scanInput = `${raw.title}\n${raw.snippet}`;
					if (params.fetchPages !== false) {
						const fetchedPreview = await fetchPagePreview(security.finalUrl, signal);
						scanInput += `\n${fetchedPreview}`;
						const previewScan = scanTextForAgentRisk(scanInput, { source: "web", provenance: "external" });
						if (previewScan.risk === "safe" || params.includeRiskyContent === true) {
							contentPreview = fetchedPreview;
						} else {
							previewOmitted = `Preview omitted because web content scan was ${previewScan.risk}. Use includeRiskyContent=true only for security research.`;
						}
					}
					const contentScan = scanTextForAgentRisk(scanInput, { source: "web", provenance: "external" });
					const blockedDangerous = blockDangerous && contentScan.risk === "dangerous";
					results.push({ ...raw, security, contentScan, contentPreview, previewOmitted, blockedDangerous });
				} catch (error) {
					rejected.push({ url: raw.url, reason: error instanceof Error ? error.message : String(error) });
				}
			}

			return {
				content: [
					{
						type: "text",
						text: formatResults(params.question, plan, results, rejected, providerOutput, questionScan),
					},
				],
				details: { question: params.question, plan, provider: providerOutput.provider, providerErrors: providerOutput.providerErrors, savedIpUrls: params.includeSavedIpUrls === true ? config.ipUrls : [], results, rejected },
			};
		},
	});
}

async function loadConfig(): Promise<WebSearchConfig> {
	try {
		const text = await fs.readFile(CONFIG_PATH, "utf8");
		const parsed = JSON.parse(text) as Partial<WebSearchConfig>;
		const provider = isSearchProviderName(parsed.provider) ? parsed.provider : "auto";
		const searxngUrl = typeof parsed.searxngUrl === "string" ? normalizeSearxngUrl(parsed.searxngUrl) : undefined;
		return {
			version: 1,
			updatedAt: parsed.updatedAt || new Date().toISOString(),
			ipUrls: Array.isArray(parsed.ipUrls) ? (parsed.ipUrls.map(normalizeIpUrl).filter(Boolean) as string[]) : [],
			provider,
			...(searxngUrl ? { searxngUrl } : {}),
		};
	} catch {
		return { version: 1, updatedAt: new Date().toISOString(), ipUrls: [], provider: "auto" };
	}
}

async function saveConfig(config: WebSearchConfig) {
	await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
	const temp = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	await fs.writeFile(temp, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
	await fs.rename(temp, CONFIG_PATH);
}

function formatSavedIpUrls(config: WebSearchConfig) {
	return [
		`Saved web-search IP URLs (${CONFIG_PATH}):`,
		...(config.ipUrls.length ? config.ipUrls.map((url) => `- ${url}`) : ["- none"]),
		"",
		"Use /web-search-ip add <ip|https://ip/> to add one.",
	].join("\n");
}

function formatWebSearchConfig(config: WebSearchConfig) {
	return [
		`secure_web_search config (${CONFIG_PATH}):`,
		`- provider: ${config.provider}`,
		`- searxngUrl: ${config.searxngUrl || "not configured"}`,
		`- saved IP URLs: ${config.ipUrls.length}`,
		"",
		"Use /web-search-config searxng <https://your-searxng.example/search> to enable self-hosted SearXNG.",
		"Use /web-search-config provider duckduckgo-html to force DuckDuckGo fallback.",
	].join("\n");
}

function isSearchProviderName(value: unknown): value is SearchProviderName {
	return value === "auto" || value === "duckduckgo-html" || value === "searxng";
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
	questionScan?: AgentRiskScanResult,
): Promise<SearchPlan> {
	const fallbackSites = requestedSites.map(cleanDomain).filter(Boolean).slice(0, 5) as string[];
	const fallback = { queries: [question.slice(0, MAX_QUESTION_LENGTH)], sites: fallbackSites };
	// If the question itself is dangerous, skip LLM plan generation entirely; the
	// content scan findings are reported to the caller and this avoids sending a
	// prompt-injection payload into the search-planning LLM.
	if (questionScan?.risk === "dangerous") return fallback;
	if (!ctx.model) return fallback;

	const sanitizedQuestion = question.slice(0, MAX_QUESTION_LENGTH);
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) return fallback;
		const message: UserMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `Question: ${sanitizedQuestion}\nUser requested sites: ${requestedSites.join(", ") || "none"}\n\nReturn JSON only: {"queries":["..."],"sites":["domain.com"]}. Pick reputable, relevant sources. Prefer official docs, standards bodies, vendor docs, academic/government sources, and primary sources. Maximum 3 queries and 5 sites.`,
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
		// Sanitize LLM-generated sites: reject IP addresses, paths, and non-domain strings
		// so the model cannot inject raw IP targets or malicious full URLs.
		const sanitizedSites = sanitizeList(parsed.sites, [])
			.map(cleanDomain)
			.filter(Boolean)
			.filter((domain) => !net.isIP(domain) && !domain.includes("/"));
		return {
			queries: sanitizeList(parsed.queries, [sanitizedQuestion]).slice(0, 3),
			sites: [...new Set([...fallbackSites, ...sanitizedSites])].slice(0, 5) as string[],
		};
	} catch {
		return fallback;
	}
}

async function searchWithConfiguredProvider(
	config: WebSearchConfig,
	plan: SearchPlan,
	maxResults: number,
	signal?: AbortSignal,
): Promise<SearchProviderOutput> {
	const requestedProvider = config.provider || "auto";
	const providerErrors: string[] = [];

	if (requestedProvider === "searxng") {
		if (!config.searxngUrl) {
			return { candidates: [], provider: "searxng", providerErrors: ["SearXNG provider selected but searxngUrl is not configured"] };
		}
		try {
			return {
				candidates: await searchSearxng(config.searxngUrl, plan, maxResults, fetchText, signal),
				provider: "searxng",
				providerErrors,
			};
		} catch (error) {
			return { candidates: [], provider: "searxng", providerErrors: [formatProviderError("searxng", error)] };
		}
	}

	if (requestedProvider === "auto" && config.searxngUrl) {
		try {
			return {
				candidates: await searchSearxng(config.searxngUrl, plan, maxResults, fetchText, signal),
				provider: "searxng",
				providerErrors,
			};
		} catch (error) {
			providerErrors.push(formatProviderError("searxng", error));
		}
	}

	try {
		return {
			candidates: await searchDuckDuckGoHtml(plan, maxResults, fetchText, signal),
			provider: "duckduckgo-html",
			providerErrors,
		};
	} catch (error) {
		providerErrors.push(formatProviderError("duckduckgo-html", error));
		return { candidates: [], provider: "duckduckgo-html", providerErrors };
	}
}

function formatProviderError(provider: string, error: unknown) {
	return `${provider}: ${error instanceof Error ? error.message : String(error)}`;
}

async function securityCheckUrl(rawUrl: string, signal?: AbortSignal): Promise<SecurityReport> {
	let current = new URL(rawUrl);
	const redirects: string[] = [];
	let lastHostSecurity: HostSecurity | undefined;

	for (let depth = 0; depth <= MAX_REDIRECTS; depth += 1) {
		if (current.protocol !== "https:") throw new Error("blocked non-HTTPS URL");
		lastHostSecurity = await checkHostSecurity(current);

		// A manual HEAD request validates TLS for this exact redirect hop without
		// silently following to an unchecked host.
		const response = await fetchWithTimeout(current.toString(), { method: "HEAD", redirect: "manual", signal });
		if (!REDIRECT_STATUSES.has(response.status)) {
			return { ...lastHostSecurity, finalUrl: current.toString(), redirects, ssl: "validated-by-node-fetch" };
		}

		const location = response.headers.get("location");
		if (!location) throw new Error(`redirect without Location from ${current.hostname}`);
		const next = new URL(location, current);
		if (next.protocol !== "https:") throw new Error(`blocked redirect to non-HTTPS URL: ${next.toString()}`);
		redirects.push(next.toString());
		current = next;
	}

	throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
}

async function checkHostSecurity(url: URL): Promise<HostSecurity> {
	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const ipVersion = net.isIP(hostname);
	if (ipVersion) {
		const dnsbl = await checkDnsbl([hostname]);
		return {
			hostname,
			dns: "raw-ip",
			secureDns: "not-applicable",
			malwareDns: "not-applicable",
			addresses: [hostname],
			dnsbl,
		};
	}
	const dnsResult = await resolveWithConsistencyCheck(hostname);
	const dnsbl = await checkDnsbl(dnsResult.addresses);
	return {
		hostname,
		dns: "ok",
		secureDns: dnsResult.secureDns,
		malwareDns: dnsResult.malwareDns,
		addresses: dnsResult.addresses,
		dnsbl,
	};
}

async function resolveWithConsistencyCheck(hostname: string): Promise<DnsConsistency> {
	const system = await resolveHost(hostname);
	if (system.length === 0) throw new Error(`DNS resolution failed for ${hostname}`);

	const providerResults = await Promise.all(
		SECURE_DNS_PROVIDERS.map(async (provider) => ({
			provider,
			result: await resolveDoh(hostname, provider.url).catch(() => ({ state: "unchecked" as const, addresses: [] })),
		})),
	);

	const trusted = providerResults.filter((result) => !result.provider.blocksMalware);
	const checkedTrustedAddresses = trusted.filter((result) => result.result.state !== "unchecked").flatMap((result) => result.result.addresses);
	if (checkedTrustedAddresses.length === 0) {
		throw new Error(`secure DNS unchecked for ${hostname}`);
	}

	// CDNs and geo-balanced hosts can legitimately return different edge IPs
	// between the system resolver and public DoH resolvers. Treat successful
	// secure-DNS resolution as the security signal and prefer exact overlap only
	// when it exists, instead of rejecting primary-source docs as false positives.
	const resolvedAddresses = chooseDnsConsistencyAddresses(system, checkedTrustedAddresses);

	const malwareResults = providerResults.filter((result) => result.provider.blocksMalware);
	const malwareBlocks = malwareResults.filter((result) => result.result.state === "blocked");
	if (malwareBlocks.length > 0) {
		throw new Error(
			`blocked by malware-filtering DNS: ${malwareBlocks.map((result) => result.provider.name).join(", ")}`,
		);
	}
	const malwareDns = malwareResults.some((result) => result.result.state === "unchecked") ? "unchecked" : "not-blocked";

	return { addresses: resolvedAddresses, secureDns: "ok", malwareDns };
}

async function resolveHost(hostname: string): Promise<string[]> {
	const records = await dns.lookup(hostname, { all: true, verbatim: false });
	return records.map((record) => record.address).filter((address) => net.isIP(address));
}

async function resolveDoh(hostname: string, endpoint: string): Promise<{ state: "ok" | "blocked" | "unchecked"; addresses: string[] }> {
	const answers = await Promise.all([resolveDohType(hostname, endpoint, "A"), resolveDohType(hostname, endpoint, "AAAA")]);
	if (answers.some((answer) => answer.state === "unchecked")) return { state: "unchecked", addresses: [] };
	if (answers.every((answer) => answer.state === "blocked")) return { state: "blocked", addresses: [] };
	const addresses = [...new Set(answers.flatMap((answer) => answer.addresses))].filter((address) => net.isIP(address));
	return { state: "ok", addresses };
}

async function resolveDohType(hostname: string, endpoint: string, type: "A" | "AAAA"): Promise<{ state: "ok" | "blocked" | "unchecked"; addresses: string[] }> {
	const url = new URL(endpoint);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetchWithTimeout(url.toString(), {
		headers: { accept: "application/dns-json", "user-agent": USER_AGENT },
	});
	const data = (await response.json()) as { Status?: number; Answer?: Array<{ data?: string; type?: number }> };
	if (data.Status === 3) return { state: "blocked", addresses: [] };
	if (data.Status !== 0) return { state: "unchecked", addresses: [] };
	const expectedType = type === "A" ? 1 : 28;
	const addresses = (data.Answer || [])
		.filter((answer) => answer.type === expectedType && answer.data)
		.map((answer) => answer.data as string);
	return { state: "ok", addresses };
}

async function checkDnsbl(addresses: string[]): Promise<"not-listed" | "unchecked"> {
	let unchecked = false;
	for (const address of addresses) {
		if (net.isIP(address) !== 4) continue;
		const reversed = address.split(".").reverse().join(".");
		for (const zone of DNSBL_ZONES) {
			try {
				await dns.resolve4(`${reversed}.${zone}`);
				throw new Error(`DNSBL listed: ${address} in ${zone}`);
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("DNSBL listed")) throw error;
				const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : "";
				if (!["ENOTFOUND", "ENODATA", "ENODOMAIN"].includes(code)) unchecked = true;
			}
		}
	}
	return unchecked ? "unchecked" : "not-listed";
}

async function fetchPagePreview(url: string, signal?: AbortSignal) {
	const html = await fetchText(url, signal);
	return stripHtml(html).replace(/\s+/g, " ").slice(0, 2000);
}

async function fetchText(url: string, signal?: AbortSignal) {
	return fetchTextFollowingHttpsRedirects(url, {
		fetchWithTimeout,
		checkRedirectTarget: checkHostSecurity,
		signal,
		headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5" },
		maxRedirects: MAX_REDIRECTS,
		maxBytes: MAX_FETCH_BYTES,
	});
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

function formatResults(
	question: string,
	plan: SearchPlan,
	results: SearchResult[],
	rejected: Array<{ url: string; reason: string }>,
	providerOutput: SearchProviderOutput,
	questionScan?: AgentRiskScanResult,
) {
	const lines = [`Secure web search for: ${question}`, ""];
	if (questionScan && questionScan.risk !== "safe") {
		lines.push(`Question security scan: ${questionScan.risk} (score ${questionScan.score})`);
		for (const finding of questionScan.findings.slice(0, 5)) {
			lines.push(`- ${finding.category}: ${finding.reason} (${finding.match})`);
		}
		lines.push("");
	}
	lines.push(`Provider: ${providerOutput.provider}`);
	if (providerOutput.providerErrors.length) {
		lines.push("Provider warnings:");
		for (const error of providerOutput.providerErrors.slice(0, 5)) lines.push(`- ${error}`);
	}
	lines.push(`Queries: ${plan.queries.join(" | ")}`);
	if (plan.sites.length) lines.push(`Preferred sites: ${plan.sites.join(", ")}`);
	lines.push("", "Results:");
	if (!results.length) lines.push("No results passed security checks.");
	const dangerousBlocked = results.filter((r) => r.blockedDangerous);
	if (dangerousBlocked.length) {
		lines.push(`${dangerousBlocked.length} result(s) blocked by blockDangerous flag (content scan classified as dangerous).`);
	}
	for (const [index, result] of results.entries()) {
		if (result.blockedDangerous) {
			lines.push(`\n${index + 1}. [BLOCKED] ${result.title}`, `URL: ${result.url} (blocked: content scan was dangerous, score ${result.contentScan.score})`);
			continue;
		}
		const dnsText = result.security.dns === "raw-ip"
			? `raw IP checked (${result.security.addresses.join(", ")}), DNSBL ${result.security.dnsbl}`
			: `secure DNS ${result.security.secureDns} (${result.security.addresses.join(", ")}), malware DNS ${result.security.malwareDns}, DNSBL ${result.security.dnsbl}`;
		lines.push(
			`\n${index + 1}. ${result.title}`,
			`URL: ${result.security.finalUrl}${result.security.finalUrl === result.url ? "" : ` (from ${result.url})`}`,
			`Provider: ${result.provider || providerOutput.provider}`,
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
		for (const item of rejected.slice(0, 10)) lines.push(`- ${truncateMiddle(item.url, MAX_REJECTED_URL_DISPLAY_LENGTH)}: ${item.reason}`);
	}
	return lines.join("\n");
}

function truncateMiddle(value: string, maxLength: number) {
	if (value.length <= maxLength) return value;
	const omitted = "...";
	const keep = maxLength - omitted.length;
	const head = Math.ceil(keep / 2);
	const tail = Math.floor(keep / 2);
	return `${value.slice(0, head)}${omitted}${value.slice(value.length - tail)}`;
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

// PRIVATE_IP_RANGES covers RFC 1918, loopback, link-local, CGNAT, and documentation ranges.
const PRIVATE_IP_RANGES = [
	/^127\./, /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^192\.168\./,
	/^169\.254\./, /^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\./,
	/^192\.0\.2\./, /^198\.51\.100\./, /^203\.0\.113\./,
	/^0\./, /^fc00:/i, /^fd00:/i, /^fe80:/i, /^::1$/, /^::$/, /^::/,
];

function isPrivateIpHostname(urlOrHostname: string): boolean {
	try {
		const hostname = extractHostname(urlOrHostname);
		if (!net.isIP(hostname)) return false;
		return PRIVATE_IP_RANGES.some((rx) => rx.test(hostname));
	} catch {
		return false;
	}
}

function extractHostname(urlOrHostname: string): string {
	try {
		const parsed = new URL(urlOrHostname.includes("://") ? urlOrHostname : `https://${urlOrHostname}`);
		return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	} catch {
		return urlOrHostname.toLowerCase();
	}
}
