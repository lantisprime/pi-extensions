import assert from "node:assert/strict";
import { chooseDnsConsistencyAddresses } from "../lib/dns-consistency";

function testUsesOverlapWhenAvailable() {
	assert.deepEqual(
		chooseDnsConsistencyAddresses(["192.0.2.10", "192.0.2.11"], ["192.0.2.11", "192.0.2.12"]),
		["192.0.2.11"],
	);
}

function testAllowsCdnGeoDnsDivergence() {
	assert.deepEqual(
		chooseDnsConsistencyAddresses(["64.239.109.193", "64.239.123.193"], ["64.239.109.129", "64.239.123.129"]),
		["64.239.109.193", "64.239.123.193"],
	);
}

function main() {
	testUsesOverlapWhenAvailable();
	testAllowsCdnGeoDnsDivergence();
	console.log("web-search DNS consistency tests passed");
}

main();
