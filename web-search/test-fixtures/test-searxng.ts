import assert from "node:assert/strict";
import {
	buildSearxngQueries,
	buildSearxngSearchUrl,
	normalizeSearxngUrl,
	parseSearxngResults,
	searchSearxng,
	SEARXNG_PROVIDER,
} from "../lib/searxng";

function testNormalizeSearxngUrl() {
	assert.equal(normalizeSearxngUrl("search.example.com"), "https://search.example.com/search");
	assert.equal(normalizeSearxngUrl("https://search.example.com/"), "https://search.example.com/search");
	assert.equal(normalizeSearxngUrl("https://search.example.com/search?q=old#frag"), "https://search.example.com/search");
	assert.equal(normalizeSearxngUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/search");
	assert.equal(normalizeSearxngUrl("http://localhost:8080/search?q=old#frag"), "http://localhost:8080/search");
	assert.equal(normalizeSearxngUrl("http://search.example.com/search"), undefined);
	assert.equal(normalizeSearxngUrl("http://192.168.1.10:8080/search"), undefined);
}

function testBuildSearxngSearchUrl() {
	assert.equal(
		buildSearxngSearchUrl("https://search.example.com/search", "pi extensions"),
		"https://search.example.com/search?q=pi+extensions&format=json",
	);
	assert.equal(
		buildSearxngSearchUrl("http://127.0.0.1:8080/search", "pi extensions"),
		"http://127.0.0.1:8080/search?q=pi+extensions&format=json",
	);
}

function testBuildSearxngQueriesWithSites() {
	assert.deepEqual(
		buildSearxngQueries({ queries: ["agentic AI"], sites: ["anthropic.com", "openai.com"] }),
		["agentic AI", "site:anthropic.com agentic AI", "site:openai.com agentic AI"],
	);
}

function testParseSearxngResults() {
	const results = parseSearxngResults(JSON.stringify({
		results: [
			{ title: "Alpha <b>Result</b>", url: "https://example.com/alpha?q=1", content: "Snippet &amp; details", engine: "duckduckgo" },
			{ title: "Bad", url: "not a url", content: "ignored" },
		],
	}));

	assert.deepEqual(results, [{
		provider: `${SEARXNG_PROVIDER}:duckduckgo`,
		title: "Alpha Result",
		url: "https://example.com/alpha?q=1",
		snippet: "Snippet & details",
	}]);
}

async function testSearchSearxngDedupesAndUsesJsonFormat() {
	const fetchedUrls: string[] = [];
	const json = JSON.stringify({
		results: [
			{ title: "Docs", url: "https://docs.example.org/path", content: "Official docs", engine: "brave" },
			{ title: "Docs duplicate", url: "https://docs.example.org/path", content: "Duplicate", engine: "duckduckgo" },
		],
	});

	const results = await searchSearxng(
		"https://search.example.com/search",
		{ queries: ["pi"], sites: ["docs.example.org"] },
		2,
		async (url) => {
			fetchedUrls.push(url);
			return json;
		},
	);

	assert.equal(results.length, 1);
	assert.equal(results[0]?.url, "https://docs.example.org/path");
	assert.deepEqual(fetchedUrls, [
		"https://search.example.com/search?q=pi&format=json",
		"https://search.example.com/search?q=site%3Adocs.example.org+pi&format=json",
	]);
}

async function main() {
	testNormalizeSearxngUrl();
	testBuildSearxngSearchUrl();
	testBuildSearxngQueriesWithSites();
	testParseSearxngResults();
	await testSearchSearxngDedupesAndUsesJsonFormat();
	console.log("web-search SearXNG provider tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
