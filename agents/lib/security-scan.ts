declare const Buffer: { from(input: string, encoding: "base64"): { toString(encoding: "utf8"): string } };

export type RiskLevel = "safe" | "suspicious" | "dangerous";
export type ScanSource = "skill" | "prompt" | "extension" | "web";
export type ScanProvenance = "project" | "global" | "external";

export type Finding = {
	severity: number;
	category: string;
	match: string;
	reason: string;
};

export type AgentRiskScanResult = {
	risk: RiskLevel;
	score: number;
	findings: Finding[];
};

export type AgentRiskScanOptions = {
	source?: ScanSource;
	provenance?: ScanProvenance;
	maxMatchesPerPattern?: number;
};

const PATTERNS: Array<{ regex: RegExp; severity: number; category: string; reason: string }> = [
	{ regex: /ignore (all )?(previous|prior|above|system|developer) instructions/gi, severity: 5, category: "instruction-override", reason: "Attempts to override higher-priority instructions" },
	{ regex: /forget (all )?(previous|prior|above) instructions/gi, severity: 5, category: "instruction-override", reason: "Attempts to reset instructions" },
	{ regex: /do not (tell|inform|notify|ask) (the )?user/gi, severity: 4, category: "concealment", reason: "Attempts to hide behavior from user" },
	{ regex: /(?:system|developer|assistant|tool)\s*:/gi, severity: 2, category: "role-simulation", reason: "May be simulating chat roles" },
	{ regex: /<\/?(?:system|developer|assistant|tool)>/gi, severity: 3, category: "role-simulation", reason: "May be simulating privileged messages" },
	{ regex: /(?:api[\s_-]?keys?|tokens?|passwords?|secrets?|private keys?|credentials?)/gi, severity: 0, category: "secret-reference", reason: "Mentions secrets or credentials" },
	{ regex: /(?:steal|extract|harvest|collect|dump).{0,80}(?:api[\s_-]?keys?|tokens?|passwords?|secrets?|private keys?|credentials?)/gi, severity: 4, category: "secret-access", reason: "Requests access to secrets or credentials" },
	{ regex: /(?:read|cat|print|show).{0,80}(?:your|user'?s?|local|actual|real|private|environment|env)\s+.{0,30}(?:api[\s_-]?keys?|tokens?|passwords?|secrets?|private keys?|credentials?)/gi, severity: 4, category: "secret-access", reason: "Requests access to secrets or credentials" },
	{ regex: /(?:~\/\.ssh|~\/\.aws|~\/\.config\/gh|\.env\b|\.npmrc|\.pypirc)/gi, severity: 4, category: "sensitive-path", reason: "Mentions sensitive credential paths" },
	{ regex: /(?:exfiltrate|upload|send|post).{0,120}(?:secret|token|password|key|\.env|ssh)/gi, severity: 7, category: "exfiltration", reason: "Potential secret exfiltration instruction" },
	{ regex: /\b(?:curl|wget|nc|netcat|scp|rsync|ssh)\b/gi, severity: 3, category: "network", reason: "Network-capable command" },
	{ regex: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)/gi, severity: 7, category: "remote-code", reason: "Pipes downloaded content into shell" },
	{ regex: /\b(?:eval|exec)\s*\(/gi, severity: 5, category: "remote-code", reason: "Dynamic code execution pattern" },
	{ regex: /\b(?:npm|pnpm|yarn)\s+(?:install|add)\s+-g\b/gi, severity: 4, category: "global-install", reason: "Global package installation" },
	{ regex: /\b(?:pip|pipx)\s+install\b/gi, severity: 3, category: "package-install", reason: "Package installation instruction" },
	{ regex: /\brm\s+-rf\s+(?:\/|~|\$HOME|\.\.)/gi, severity: 8, category: "destructive", reason: "Dangerous recursive deletion" },
	{ regex: /\b(?:sudo|chmod\s+777|chown|git\s+push|git\s+reset\s+--hard)\b/gi, severity: 4, category: "privileged-or-mutating", reason: "Privileged or destructive command" },
	{ regex: /(?:\.\.\/|\/etc\/|\/Users\/|\/home\/|~\/)/gi, severity: 2, category: "outside-project", reason: "References paths outside project" },
	{ regex: /[A-Za-z0-9+/]{200,}={0,2}/g, severity: 3, category: "obfuscation", reason: "Long base64-like blob" },
	{ regex: /<!--[\s\S]{0,500}?(?:ignore|system|developer|secret|token)[\s\S]{0,500}?-->/gi, severity: 4, category: "hidden-html", reason: "Suspicious hidden HTML comment" },
	{ regex: /[\u200B-\u200D\uFEFF]/g, severity: 3, category: "hidden-text", reason: "Zero-width hidden characters" },
];

export function scanTextForAgentRisk(text: string, options: AgentRiskScanOptions = {}): AgentRiskScanResult {
	const maxMatches = options.maxMatchesPerPattern ?? 5;
	const findings: Finding[] = [];
	for (const input of buildScanInputs(text)) {
		for (const pattern of PATTERNS) {
			pattern.regex.lastIndex = 0;
			for (const match of [...input.text.matchAll(pattern.regex)].slice(0, maxMatches)) {
				findings.push({
					severity: input.label === "raw" || pattern.severity === 0 ? pattern.severity : Math.max(pattern.severity, 4),
					category: input.label === "raw" ? pattern.category : `${pattern.category}:${input.label}`,
					match: (match[0] || "").slice(0, 160),
					reason: input.label === "raw" ? pattern.reason : `${pattern.reason} in ${input.label} decoded text`,
				});
			}
		}
	}
	const deduped = dedupeFindings(findings);
	let score = deduped.reduce((sum, finding) => sum + finding.severity, 0);
	if (options.provenance === "project" && score > 0) score += 1;
	if (options.provenance === "external" && score > 0) score += 1;
	return { risk: riskFromScore(score), score, findings: deduped };
}

function buildScanInputs(text: string): Array<{ label: string; text: string }> {
	const inputs = [{ label: "raw", text }];
	for (const decoded of decodePercentEncoded(text)) inputs.push({ label: "url", text: decoded });
	for (const decoded of decodeBase64Blobs(text)) inputs.push({ label: "base64", text: decoded });
	return inputs;
}

function decodePercentEncoded(text: string): string[] {
	const matches = text.match(/(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-f]{2})*%[0-9a-f]{2}(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|%[0-9a-f]{2})*/gi) || [];
	return [...new Set(matches.slice(0, 20).map((match) => {
		try { return decodeURIComponent(match); } catch { return ""; }
	}).filter((value) => value.length >= 8 && value !== text))];
}

function decodeBase64Blobs(text: string): string[] {
	const matches = text.match(/[A-Za-z0-9+/]{24,}={0,2}/g) || [];
	return [...new Set(matches.slice(0, 20).map((match) => {
		try {
			const decoded = Buffer.from(match, "base64").toString("utf8");
			return /[\x09\x0A\x0D\x20-\x7E]{8,}/.test(decoded) ? decoded : "";
		} catch { return ""; }
	}).filter(Boolean))];
}

function dedupeFindings(findings: Finding[]) {
	const seen = new Set<string>();
	return findings.filter((finding) => {
		const key = `${finding.category}\0${finding.match}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

export function riskFromScore(score: number): RiskLevel {
	if (score >= 8) return "dangerous";
	if (score >= 3) return "suspicious";
	return "safe";
}
