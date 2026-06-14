import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildDuckDuckGoHtmlSearchUrl,
	buildDuckDuckGoQueries,
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
	await testSearchProviderDedupesAndUsesCanonicalUrls();
	console.log("web-search duckduckgo provider tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
