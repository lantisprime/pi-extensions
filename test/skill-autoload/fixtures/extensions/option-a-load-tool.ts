import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Option A: register a custom load_skill tool + tell the LLM via system prompt
// to call it when it realizes during thinking that it needs a skill.
//
// Uses pi's TypeBox-based tool definition (parameters: Type.Object(...)).

// The runner sets SKILL_AUTOLOAD_SKILLS_DIR to the staged workspace. The
// fallback resolves to the fixture skill shipped beside this extension.
const SKILLS_DIR =
  process.env.SKILL_AUTOLOAD_SKILLS_DIR ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "skill");

export default function (pi: ExtensionAPI) {
  // 1. Tell the LLM how to load skills, via system prompt injection
  pi.on("before_agent_start", async (event) => {
    const instruction = `

# Skill loading
When you realize during your thinking that you need specialized guidance for
a task, call the \`load_skill\` tool with the skill's name BEFORE producing
your user-facing response. Available skills are listed in <available_skills>.
Use this whenever the skill description matches your current need.`;
    return { systemPrompt: event.systemPrompt + instruction };
  });

  // 2. Register the load_skill tool (correct TypeBox format)
  pi.registerTool({
    name: "load_skill",
    label: "Load Skill",
    description:
      "Load a skill's full instructions into your context. Call this when " +
      "you realize during your thinking that you need specialized guidance. " +
      "Args: skill_name (the skill folder name, e.g. 'vague-task').",
    parameters: Type.Object({
      skill_name: Type.String({ description: "The skill folder name" }),
    }),
    async execute(_toolCallId, params) {
      try {
        const path = join(SKILLS_DIR, params.skill_name, "SKILL.md");
        const body = await readFile(path, "utf8");
        return {
          content: [
            { type: "text", text: `# Skill loaded: ${params.skill_name}\n\n${body}` },
          ],
          details: {},
        };
      } catch (err: any) {
        throw new Error(
          `skill '${params.skill_name}' not found at ${SKILLS_DIR}/${params.skill_name}/SKILL.md`,
        );
      }
    },
  });
}
