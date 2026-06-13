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
	{ regex: /(?:api[_-]?key|token|password|secret|private key|credential)/gi, severity: 3, category: "secret-access", reason: "Mentions secrets or credentials" },
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
	for (const pattern of PATTERNS) {
		pattern.regex.lastIndex = 0;
		for (const match of [...text.matchAll(pattern.regex)].slice(0, maxMatches)) {
			findings.push({
				severity: pattern.severity,
				category: pattern.category,
				match: (match[0] || "").slice(0, 160),
				reason: pattern.reason,
			});
		}
	}
	let score = findings.reduce((sum, finding) => sum + finding.severity, 0);
	if (options.provenance === "project" && score > 0) score += 1;
	if (options.provenance === "external" && score > 0) score += 1;
	return { risk: riskFromScore(score), score, findings };
}

export function riskFromScore(score: number): RiskLevel {
	if (score >= 8) return "dangerous";
	if (score >= 3) return "suspicious";
	return "safe";
}
