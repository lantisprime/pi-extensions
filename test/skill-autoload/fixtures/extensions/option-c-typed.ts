import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Option C (real): scan TYPED thinking blocks emitted by a reasoning model,
// match trigger phrases, and inject the skill into the next turn.
//
// Tested against litellm/deepseek-reasoner, which emits:
//   { type: "thinking", thinking: "...", thinkingSignature: "..." }

// The runner sets SKILL_AUTOLOAD_SKILLS_DIR to the staged workspace. The
// fallback resolves to the fixture skill shipped beside this extension.
const SKILLS_DIR =
  process.env.SKILL_AUTOLOAD_SKILLS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "skill");

const TRIGGERS: Array<[RegExp, string]> = [
  // Fires when the model's own reasoning mentions the skill by name
  [/\bvague[- ]?task\b/i, "vague-task"],
  // Fires when reasoning indicates a structured research/study response is wanted
  [/\b(structured|three[- ]part|research response|skill)\b/i, "vague-task"],
];

export default function (pi: ExtensionAPI) {
  let injectedThisTurn = false;

  pi.on("before_agent_start", async () => {
    injectedThisTurn = false;
  });

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    if (injectedThisTurn) return;

    const thinkingBlocks = (event.message.content ?? []).filter(
      (b: any) => b?.type === "thinking",
    );
    if (thinkingBlocks.length === 0) return;

    const thinking = thinkingBlocks.map((b: any) => b.thinking ?? "").join("\n");
    if (!thinking.trim()) return;

    for (const [re, skill] of TRIGGERS) {
      if (!re.test(thinking)) continue;
      const body = await readFile(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      pi.sendMessage(
        {
          customType: "auto-skill-thinking",
          content:
            `[Auto-loaded: your reasoning matched /${re.source}/]\n\n` +
            `Apply this skill to your ongoing answer:\n\n${body}`,
          display: false,
        },
        { deliverAs: "steer", triggerTurn: false },
      );
      injectedThisTurn = true;
      return;
    }
  });
}
