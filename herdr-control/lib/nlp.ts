// herdr-control: conservative natural-language matcher for the input hook.
// Only high-confidence phrases are handled (>= 0.8); everything else passes
// through to skill/template expansion untouched. Mirrors cmux-control/nlp.

export type HerdrNlpMatch =
	| { action: "list"; confidence: number }
	| { action: "spawn"; confidence: number; rest: string }
	| null;

export function matchHerdrNlp(text: string): HerdrNlpMatch {
	const trimmed = text.trim();

	if (/^(?:list\s+)?herdr\s+agents?\s*[?.!]*$/i.test(trimmed)) {
		return { action: "list", confidence: 0.95 };
	}

	const spawn = /^herdr\s+spawn\s+([a-z][a-z0-9_-]*)\s+([\s\S]+)$/i.exec(trimmed);
	if (spawn) {
		return { action: "spawn", confidence: 0.85, rest: `${spawn[1]} ${spawn[2]}` };
	}

	return null;
}
