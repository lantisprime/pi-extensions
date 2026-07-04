// cmux-control: natural-language pattern matcher for cmux directives.
//
// Conservative patterns only: match explicit cmux requests or concrete cmux
// surface refs. These matches are advisory; callers may ignore them.

export interface NlpMatch {
	action: "list" | "capture" | "send" | "split";
	surfaceRef?: string;
	workspaceRef?: string;
	text?: string;
	direction?: "right" | "down";
}

const SURFACE_REF_RE = /surface:\d+/i;

const LIST_PATTERNS: RegExp[] = [
	/^list\s+cmux\s+workspaces\s*$/i,
	/^cmux\s+list\s*$/i,
];

const CAPTURE_PATTERNS: RegExp[] = [
	/^(?:tail|show|capture)\s+(surface:\d+)\s*$/i,
];

const SEND_PATTERNS: RegExp[] = [
	/^send\s+"([^"]*)"\s+to\s+(surface:\d+)\s*$/i,
	/^tell\s+(surface:\d+)\s+"([^"]*)"\s*$/i,
];

const SPLIT_PATTERNS: RegExp[] = [
	/^split\s+pane\s+(right|down)\s*$/i,
	/^split\s+(right|down)\s*$/i,
];

export function matchNlp(input: string): NlpMatch | null {
	const text = input.trim();
	if (!text || text.startsWith("/") || text.length > 500) return null;

	for (const re of LIST_PATTERNS) {
		if (re.test(text)) return { action: "list" };
	}

	for (const re of CAPTURE_PATTERNS) {
		const match = text.match(re);
		if (match) return { action: "capture", surfaceRef: match[1].toLowerCase() };
	}

	for (const re of SEND_PATTERNS) {
		const match = text.match(re);
		if (match) {
			const groups = match.slice(1);
			const surfaceRef = groups.find((group) => SURFACE_REF_RE.test(group));
			const sendText = groups.find((group) => !SURFACE_REF_RE.test(group));
			if (surfaceRef && sendText !== undefined) {
				return { action: "send", surfaceRef: surfaceRef.toLowerCase(), text: sendText };
			}
		}
	}

	for (const re of SPLIT_PATTERNS) {
		const match = text.match(re);
		if (match) return { action: "split", direction: match[1].toLowerCase() as "right" | "down" };
	}

	return null;
}
