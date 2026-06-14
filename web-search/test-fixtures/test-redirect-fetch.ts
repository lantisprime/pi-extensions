import assert from "node:assert/strict";
import { buildDuckDuckGoHtmlSearchUrl } from "../lib/duckduckgo";
import { fetchTextFollowingHttpsRedirects } from "../lib/redirect-fetch";

type FakeResponse = {
	status: number;
	body?: string;
	headers?: Record<string, string>;
};

function makeFetch(routes: Record<string, FakeResponse>) {
	const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
	const fetchWithTimeout = async (url: string, init?: RequestInit) => {
		calls.push({ url, redirect: init?.redirect });
		const route = routes[url];
		if (!route) throw new Error(`unexpected fetch: ${url}`);
		return new Response(route.body ?? "", {
			status: route.status,
			headers: route.headers,
		});
	};
	return { calls, fetchWithTimeout };
}

async function assertRejectsMessage(fn: () => Promise<unknown>, expected: string) {
	await assert.rejects(fn, (error) => {
		assert(error instanceof Error);
		assert.match(error.message, new RegExp(expected));
		return true;
	});
}

function testDuckDuckGoSearchUrlUsesCanonicalHtmlEndpoint() {
	const url = buildDuckDuckGoHtmlSearchUrl("agentic AI workplan");
	assert.equal(url, "https://html.duckduckgo.com/html/?q=agentic%20AI%20workplan");
	assert(!url.startsWith("https://duckduckgo.com/html/"), "should avoid the redirecting duckduckgo.com/html endpoint");
}

async function testDuckDuckGoHttpsRedirectIsCheckedAndFollowed() {
	const start = "https://duckduckgo.com/html/?q=agentic%20AI%20workplan";
	const redirected = "https://html.duckduckgo.com/html/?q=agentic%20AI%20workplan";
	const checked: string[] = [];
	const { calls, fetchWithTimeout } = makeFetch({
		[start]: { status: 302, headers: { location: redirected } },
		[redirected]: { status: 200, body: "<html>duckduckgo results</html>", headers: { "content-type": "text/html; charset=UTF-8" } },
	});

	const text = await fetchTextFollowingHttpsRedirects(start, {
		fetchWithTimeout,
		checkRedirectTarget: async (url) => checked.push(url.toString()),
		maxRedirects: 5,
		maxBytes: 1024,
	});

	assert.equal(text, "<html>duckduckgo results</html>");
	assert.deepEqual(calls.map((call) => call.url), [start, redirected]);
	assert.deepEqual(calls.map((call) => call.redirect), ["manual", "manual"]);
	assert.deepEqual(checked, [redirected]);
}

async function testRelativeDuckDuckGoRedirectIsResolvedAndChecked() {
	const start = "https://duckduckgo.com/?q=pi";
	const redirected = "https://duckduckgo.com/html/?q=pi";
	const checked: string[] = [];
	const { fetchWithTimeout } = makeFetch({
		[start]: { status: 302, headers: { location: "/html/?q=pi" } },
		[redirected]: { status: 200, body: "ok", headers: { "content-type": "text/plain" } },
	});

	const text = await fetchTextFollowingHttpsRedirects(start, {
		fetchWithTimeout,
		checkRedirectTarget: async (url) => checked.push(url.toString()),
		maxRedirects: 5,
		maxBytes: 1024,
	});

	assert.equal(text, "ok");
	assert.deepEqual(checked, [redirected]);
}

async function testNonHttpsRedirectIsBlockedBeforeCheckOrFetch() {
	const start = "https://httpbin.org/redirect-to?url=http%3A%2F%2Fexample.com";
	let checked = false;
	const { calls, fetchWithTimeout } = makeFetch({
		[start]: { status: 302, headers: { location: "http://example.com" } },
	});

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(start, {
			fetchWithTimeout,
			checkRedirectTarget: async () => { checked = true; },
			maxRedirects: 5,
			maxBytes: 1024,
		}),
		"blocked redirect to non-HTTPS URL",
	);

	assert.equal(checked, false);
	assert.deepEqual(calls.map((call) => call.url), [start]);
}

async function testMissingRedirectLocationIsRejected() {
	const start = "https://duckduckgo.com/html/?q=missing-location";
	const { fetchWithTimeout } = makeFetch({ [start]: { status: 302 } });

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(start, { fetchWithTimeout, maxRedirects: 5, maxBytes: 1024 }),
		"redirect without Location",
	);
}

async function testTooManyRedirectsIsRejected() {
	const a = "https://example.com/a";
	const b = "https://example.com/b";
	const c = "https://example.com/c";
	const { fetchWithTimeout } = makeFetch({
		[a]: { status: 302, headers: { location: b } },
		[b]: { status: 302, headers: { location: c } },
	});

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(a, { fetchWithTimeout, maxRedirects: 1, maxBytes: 1024 }),
		"too many redirects",
	);
}

async function testUnsupportedContentTypeIsRejected() {
	const url = "https://example.com/file.pdf";
	const { fetchWithTimeout } = makeFetch({
		[url]: { status: 200, body: "%PDF", headers: { "content-type": "application/pdf" } },
	});

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(url, { fetchWithTimeout, maxRedirects: 5, maxBytes: 1024 }),
		"unsupported content-type: application/pdf",
	);
}

async function testContentLengthLimitIsEnforcedBeforeBuffering() {
	const url = "https://example.com/large";
	const { fetchWithTimeout } = makeFetch({
		[url]: { status: 200, body: "small", headers: { "content-type": "text/plain", "content-length": "2048" } },
	});

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(url, { fetchWithTimeout, maxRedirects: 5, maxBytes: 1024 }),
		"response too large: 2048 bytes",
	);
}

async function testStreamingLimitIsEnforcedWithoutContentLength() {
	const url = "https://example.com/stream-large";
	const { fetchWithTimeout } = makeFetch({
		[url]: { status: 200, body: "x".repeat(2048), headers: { "content-type": "text/plain" } },
	});

	await assertRejectsMessage(
		() => fetchTextFollowingHttpsRedirects(url, { fetchWithTimeout, maxRedirects: 5, maxBytes: 1024 }),
		"response too large: >1024 bytes",
	);
}

async function main() {
	testDuckDuckGoSearchUrlUsesCanonicalHtmlEndpoint();

	for (const test of [
		testDuckDuckGoHttpsRedirectIsCheckedAndFollowed,
		testRelativeDuckDuckGoRedirectIsResolvedAndChecked,
		testNonHttpsRedirectIsBlockedBeforeCheckOrFetch,
		testMissingRedirectLocationIsRejected,
		testTooManyRedirectsIsRejected,
		testUnsupportedContentTypeIsRejected,
		testContentLengthLimitIsEnforcedBeforeBuffering,
		testStreamingLimitIsEnforcedWithoutContentLength,
	]) {
		await test();
	}

	console.log("web-search redirect-fetch tests passed");
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
