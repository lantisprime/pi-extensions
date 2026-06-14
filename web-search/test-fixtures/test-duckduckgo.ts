import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildDuckDuckGoHtmlSearchUrl,
	buildDuckDuckGoQueries,
	decodeDuckDuckGoUrl,
	DUCKDUCKGO_HTML_PROVIDER,
	parseDuckDuckGoResults,
	searchDuckDuckGoHtml,
} from "../lib/duckduckgo";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

function testCanonicalSearchUrl() {
	assert.equal(
		buildDuckDuckGoHtmlSearchUrl("agentic AI workplan"),
		"https://html.duckduckgo.com/html/?q=agentic%20AI%20workplan",
	);
}

function testBuildQueriesWithSites() {
	assert.deepEqual(
		buildDuckDuckGoQueries({ queries: ["agentic AI"], sites: ["anthropic.com", "openai.com"] }),
		["agentic AI", "site:anthropic.com agentic AI", "site:openai.com agentic AI"],
	);
}

function testParserFixtureCompatibility() {
	const html = readFileSync(join(fixtureDir, "duckduckgo-results.html"), "utf8");
	const results = parseDuckDuckGoResults(html);

	assert.equal(results.length, 2);
	assert.deepEqual(results[0], {
		provider: DUCKDUCKGO_HTML_PROVIDER,
		title: "Alpha & Beta Result",
		url: "https://example.com/alpha?q=1&utm_source=ddg",
		snippet: "This is an example snippet & should decode entities.",
	});
	assert.deepEqual(results[1], {
		provider: DUCKDUCKGO_HTML_PROVIDER,
		title: "Docs Result",
		url: "https://docs.example.org/path",
		snippet: "Official docs snippet.",
	});
}

function testDuckDuckGoAdRedirectsAreIgnored() {
	const adUrl = "https://duckduckgo.com/y.js?ad_domain=udemy.com&ad_provider=bingv7aa&u3=https%3A%2F%2Fwww.bing.com%2Faclick%3Fu%3Dhttps%253A%252F%252Fwww.udemy.com%252Fcourse%252Ftypescript";
	assert.equal(decodeDuckDuckGoUrl(adUrl), undefined);
	assert.equal(decodeDuckDuckGoUrl("https://www.bing.com/aclick?u=https%3A%2F%2Fwww.udemy.com%2Fcourse%2Ftypescript"), undefined);

	const html = `
		<a class="result__a" href="${adUrl.replace(/&/g, "&amp;")}">Ad result</a>
		<a class="result__snippet">Sponsored result</a>
		<a class="result__a" href="https://example.com/organic">Organic result</a>
		<a class="result__snippet">Organic snippet.</a>
	`;
	const results = parseDuckDuckGoResults(html);
	assert.equal(results.length, 1);
	assert.equal(results[0]?.url, "https://example.com/organic");
}

async function testSearchProviderDedupesAndUsesCanonicalUrls() {
	const html = readFileSync(join(fixtureDir, "duckduckgo-results.html"), "utf8");
	const fetchedUrls: string[] = [];
	const results = await searchDuckDuckGoHtml(
		{ queries: ["agentic AI"], sites: ["example.com"] },
		2,
		async (url) => {
			fetchedUrls.push(url);
			return html;
		},
	);

	assert.equal(results.length, 2);
	assert.deepEqual(fetchedUrls, [
		"https://html.duckduckgo.com/html/?q=agentic%20AI",
		"https://html.duckduckgo.com/html/?q=site%3Aexample.com%20agentic%20AI",
	]);
}

async function main() {
	testCanonicalSearchUrl();
	testBuildQueriesWithSites();
	testParserFixtureCompatibility();
	testDuckDuckGoAdRedirectsAreIgnored();
	await testSearchProviderDedupesAndUsesCanonicalUrls();
	console.log("web-search duckduckgo provider tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
