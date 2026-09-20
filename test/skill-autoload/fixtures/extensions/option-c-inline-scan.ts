import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Option C (fallback): scan the assistant's text content (which includes
// inline <think>...</think> reasoning on models without typed thinking blocks)
// for trigger phrases, then inject the skill content as a follow-up message.
//
// On a model with typed thinking blocks (e.g., openai-codex), swap the
// scanning source from the inline text to the typed thinking blocks.

// The runner sets SKILL_AUTOLOAD_SKILLS_DIR to the staged workspace. The
// fallback resolves to the fixture skill shipped beside this extension.
const SKILLS_DIR =
  process.env.SKILL_AUTOLOAD_SKILLS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "skill");
const TRIGGERS: Array<[RegExp, string]> = [
  [/\bvague[- ]?task\b/i, "vague-task"],
  [/\bvague\b/i, "vague-task"],
];

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;

    // Concatenate all text content from the assistant message (includes
    // inline reasoning on models without typed thinking blocks)
    const text = (event.message.content ?? [])
      .filter((b: any) => b?.type === "text")
      .map((b: any) => b.text ?? "")
      .join("\n");

    if (!text) return;

    for (const [re, skill] of TRIGGERS) {
      if (!re.test(text)) continue;
      try {
        const body = await readFile(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
        pi.sendMessage(
          {
            customType: "auto-skill-fallback",
            content: `[Auto-loaded after reasoning matched /${re.source}/]\n\n${body}`,
            display: false,
          },
          { deliverAs: "steer", triggerTurn: false },
        );
        return;
      } catch {
        continue;
      }
    }
  });
}
