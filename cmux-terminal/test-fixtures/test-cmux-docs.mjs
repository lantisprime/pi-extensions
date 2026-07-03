// P5b-1-S5: grep guards for cmux-terminal/README.md REQ-R1.
//
// These assertions pin the documented cmux limitations that must stay visible
// to users until the follow-up backend aggregation work lands.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// Test 1: ReadmeMentionsMacosOnly — README documents cmux's darwin-only scope.
{
	assert.match(readme, /macOS[- ]only/, "README.md must mention macOS-only or macOS only");
}

// Test 2: ReadmeMentionsSocketModeAllowAll — README documents socket mode.
{
	assert.match(readme, /CMUX_SOCKET_MODE=allowAll/, "README.md must mention CMUX_SOCKET_MODE=allowAll exactly");
}

// Test 3: ReadmeMentionsAgentNameGap — README documents the agentName gap.
{
	assert.match(readme, /agentName|agent name/, "README.md must mention agentName or agent name");
	assert.match(readme, /not persisted|not stored|gap/, "README.md must mention not persisted, not stored, or gap");
}

// Test 4: ReadmeMentionsDispatchBehavior — README documents dispatch/fallback.
{
	assert.match(
		readme,
		/cmux wins over tmux regardless of CLI load order/,
		"README.md must document that cmux prefers macOS regardless of load order",
	);
	assert.match(
		readme,
		/tmux is selected/,
		"README.md must document tmux fallback outside macOS",
	);
	assert.match(
		readme,
		/bg-status[\s\S]*bg-stop[\s\S]*select cmux[\s\S]*lose visibility/,
		"README.md must document the EC14/15 caveat: bg-status/bg-stop may select a different backend and lose visibility",
	);
}

console.log("P5b-1 cmux-docs tests passed");
