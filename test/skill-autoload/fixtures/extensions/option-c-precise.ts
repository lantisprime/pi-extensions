import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Option C (precise): fire only when the model's typed thinking expresses an
// INTENT to load/read/check a skill, rather than on any mention of "skill".

// The runner sets SKILL_AUTOLOAD_SKILLS_DIR to the staged workspace. The
// fallback resolves to the fixture skill shipped beside this extension.
const SKILLS_DIR =
  process.env.SKILL_AUTOLOAD_SKILLS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "skill");

const INTENT = [
  /\b(let me|i should|i'?ll|i will|i need to|need to|going to)\s+(read|load|check|consult|open)\b[^.]{0,60}\b(skill|vague-task)\b/i,
  /\b(read|load|check|consult)\s+the\s+(vague-task\s+)?skill\b/i,
  /\bvague-task\b/i,
];

export default function (pi: ExtensionAPI) {
  const fired = new Set<string>();

  pi.on("message_end", async (event) => {
    if (event.message.role !== "assistant") return;
    const id = (event.message as any).id ?? "anon";
    if (fired.has(id)) return;

    const thinking = (event.message.content ?? [])
      .filter((b: any) => b?.type === "thinking")
      .map((b: any) => b.thinking ?? "")
      .join("\n");
    if (!thinking.trim()) return;

    for (const re of INTENT) {
      if (!re.test(thinking)) continue;
      const body = await readFile(join(SKILLS_DIR, "vague-task", "SKILL.md"), "utf8");
      pi.sendMessage(
        {
          customType: "auto-skill-precise",
          content:
            `[Auto-loaded: your reasoning showed intent to load a skill ` +
            `(/${re.source}/)]\n\n${body}`,
          display: false,
        },
        { deliverAs: "steer", triggerTurn: false },
      );
      fired.add(id);
      return;
    }
  });
}
