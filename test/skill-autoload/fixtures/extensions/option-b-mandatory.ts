import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Option B: Forceful MANDATORY instruction injection via before_agent_start.
// Scott Spence's pattern: a forceful reminder appended to the system prompt
// every turn, telling the LLM to check available skills and read SKILL.md
// when matched.

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const reminder = `

# MANDATORY SKILL CHECK
Before producing your response, scan the skills listed in <available_skills>
above. If ANY skill's description matches the user's request, IMMEDIATELY use
the read tool to load that skill's SKILL.md before responding. Do not skip
this step.`;
    return {
      systemPrompt: event.systemPrompt + reminder,
    };
  });
}
