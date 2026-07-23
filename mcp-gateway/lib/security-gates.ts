import { scanTextForAgentRisk, type AgentRiskScanResult } from "./security-scan";
import type { McpToolInfo } from "./mcp-client";

// R6-F2 / amendment 20: inbound scan DoS guard. The shared scanner is O(n^2)
// on long homogeneous input; the mcp_call inbound path can receive up to
// MAX_RESPONSE_BYTES (2 MB) of gateway-controlled text. Cap the scan input
// and short-circuit (return no scan, do NOT include content) when over cap.
// includeRiskyContent must NOT bypass — unscanned = unsafe.
export const SCAN_INPUT_CAP = 65_536;

export function scanInboundContent(allText: string): { scan: AgentRiskScanResult | null; overCap: boolean } {
	if (allText.length > SCAN_INPUT_CAP) {
		return { scan: null, overCap: true };
	}
	const scan = scanTextForAgentRisk(allText, { source: "extension", provenance: "external" });
	return { scan, overCap: false };
}

export type ScanFindings = {
	risk: string;
	score: number;
	findings: Array<{ category: string; reason: string; match: string }>;
};

export type ManifestEntry = {
	fingerprint: string;
	acceptedAt: string;
	status?: "ok" | "changed";
	pendingFingerprint?: string;
};

// Pure function: returns true if manifest blocks mcp_call
// (missing, no fingerprint, or status === "changed")
export function isManifestBlocked(manifest: ManifestEntry | undefined): boolean {
	if (!manifest) return true;
	if (!manifest.fingerprint) return true;
	if (manifest.status === "changed") return true;
	return false;
}

// Coerce mcp_call arguments to a usable object
// Models sometimes pass arguments as a JSON string (e.g. "{}")
export function coerceToolArguments(
	value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
	// undefined/null -> empty object
	if (value === undefined || value === null) {
		return { ok: true, value: {} };
	}

	// Plain object or array -> passthrough
	if (typeof value === "object" && !Array.isArray(value)) {
		return { ok: true, value };
	}
	if (Array.isArray(value)) {
		return { ok: true, value };
	}

	// String -> try JSON parse
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) {
			return { ok: true, value: {} };
		}
		try {
			const parsed = JSON.parse(trimmed);
			return { ok: true, value: parsed };
		} catch {
			return { ok: false, error: "arguments must be a JSON object (e.g. {\"key\": \"value\"})" };
		}
	}

	// Other primitives (number, boolean) -> error
	return { ok: false, error: "arguments must be a JSON object (e.g. {\"key\": \"value\"})" };
}

export function evaluateOutboundArgs(tool: string, args: unknown): { blocked: boolean; scan: ScanFindings } {
	const inputStr = JSON.stringify({ tool, arguments: args });
	const scan = scanTextForAgentRisk(inputStr, { source: "extension", provenance: "external" });
	// Block if risk is dangerous OR any finding has category starting with "secret-material"
	const hasSecretMaterial = scan.findings.some((f) => f.category.startsWith("secret-material"));
	const blocked = scan.risk === "dangerous" || hasSecretMaterial;
	return { blocked, scan: { risk: scan.risk, score: scan.score, findings: scan.findings } };
}

export function applyDescriptionPolicy(tool: McpToolInfo): McpToolInfo {
	const scan = scanTextForAgentRisk(tool.description, { source: "extension", provenance: "external" });
	if (scan.risk !== "safe") {
		return {
			...tool,
			description: `[description omitted: security scan ${scan.risk}, score ${scan.score}]`,
		};
	}
	return tool;
}

export function renderInboundResult(
	content: Array<{ type: string; text?: string }>,
	inboundScan: AgentRiskScanResult,
	includeRiskyContent: boolean,
): { text: string; included: boolean } {
	const allText = content.map((c) => c.text ?? "").join("\n");

	if (inboundScan.risk === "safe" || includeRiskyContent) {
		const prefix = inboundScan.risk !== "safe" ? `[included despite ${inboundScan.risk} scan] ` : "";
		return { text: prefix + allText, included: true };
	}

	const findings = inboundScan.findings
		.slice(0, 5)
		.map((f) => `- ${f.category}: ${f.reason} (${f.match})`)
		.join("\n");
	return {
		text: `result omitted: content scan was ${inboundScan.risk} (score ${inboundScan.score})\n${findings}\n\nHint: set includeRiskyContent=true to include for security research.`,
		included: false,
	};
}

// Scan a transport-layer error message (fully gateway-controlled). Safe ->
// include verbatim. Otherwise replace with omission marker + findings list.
// Used by the callTool-throw path in index.ts; inbound scan of the throw text
// is mandatory (amendment 11).
export function renderTransportError(message: string): { text: string; scan: AgentRiskScanResult } {
	const scan = scanTextForAgentRisk(message, { source: "extension", provenance: "external" });
	if (scan.risk === "safe") {
		return { text: message, scan };
	}
	const findings = scan.findings
		.slice(0, 5)
		.map((f) => `- ${f.category}: ${f.reason} (${f.match})`)
		.join("\n");
	return {
		text: `[transport error message omitted: security scan ${scan.risk}, score ${scan.score}]\n${findings}`,
		scan,
	};
}

// Normalize a /mcp-gateway set-gateway URL. Enforces https BEFORE
// normalization; returns just the origin so userinfo/path/query never leak
// into persisted config or status output (amendment 17).
export function normalizeGatewayUrl(value: string): { ok: true; origin: string } | { ok: false; error: string } {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, error: "Invalid URL" };
	}
	if (url.protocol !== "https:") {
		return { ok: false, error: "Gateway URL must be https" };
	}
	if (!url.origin || url.origin === "null") {
		return { ok: false, error: "Invalid URL origin" };
	}
	return { ok: true, origin: url.origin };
}

// Render an isError tool result. Bundles inbound scan + the `tool error: `
// prefix + included-despite-risk findings + the security summary line. The
// outbound risk comes from the upstream evaluateOutboundArgs call so the
// summary reflects both gates (amendment 7 + 12). Short-circuits on the
// inbound DoS guard (R6-F2 / amendment 20) — content is NOT included even
// with includeRiskyContent=true (unscanned = unsafe).
export function renderIsErrorToolResult(
	content: Array<{ type: string; text?: string }>,
	includeRiskyContent: boolean,
	outboundRisk: string,
): { text: string; scan: AgentRiskScanResult | null; included: boolean; overCap: boolean } {
	const allText = content.map((c) => c.text ?? "").join("\n");
	const { scan, overCap } = scanInboundContent(allText);
	if (overCap || !scan) {
		return {
			text: `tool error: ${overCapOmission(allText.length)}\n\nsecurity: outbound ${outboundRisk}, inbound not-scanned`,
			scan: null,
			included: false,
			overCap: true,
		};
	}
	const rendered = renderInboundResult(content, scan, includeRiskyContent);
	let text = `tool error: ${rendered.text}`;
	if (rendered.included && scan.risk !== "safe") {
		const findings = scan.findings
			.slice(0, 5)
			.map((f) => `- ${f.category}: ${f.reason} (${f.match})`)
			.join("\n");
		text += `\n\nFindings:\n${findings}`;
	}
	text += `\n\nsecurity: outbound ${outboundRisk}, inbound ${scan.risk}`;
	return { text, scan, included: rendered.included, overCap: false };
}

// Build the standardized over-cap omission line. Used by both inbound paths
// (isError and normal-success) in index.ts.
export function overCapOmission(byteLength: number): string {
	return `result omitted: content is ${byteLength} bytes, exceeds the ${SCAN_INPUT_CAP}-byte inbound scan limit (DoS guard); not scanned`;
}

// Classify a tool for the mcp_list_tools output. Scan NAME; risky name =>
// omit the tool from the listing entirely (amendment 14). Safe name => keep,
// apply description policy, and only show the input-schema line when the
// compact JSON string scans safe. Returns the display shape + findings so the
// caller can both render and report scanFindings in details.
export type ToolListingDecision =
	| { kind: "kept"; tool: McpToolInfo; showSchema: boolean; findings: string[] }
	| { kind: "omitted"; risk: string; score: number; findings: string[] };

export function classifyToolForListing(tool: McpToolInfo): ToolListingDecision {
	const nameScan = scanTextForAgentRisk(tool.name, { source: "extension", provenance: "external" });
	if (nameScan.risk !== "safe") {
		return {
			kind: "omitted",
			risk: nameScan.risk,
			score: nameScan.score,
			findings: nameScan.findings.map((f) => `${f.category}: ${f.reason}`),
		};
	}

	const described = applyDescriptionPolicy(tool);
	const findings: string[] = [];
	let showSchema = true;
	if (tool.inputSchema) {
		const schemaStr = JSON.stringify(tool.inputSchema);
		if (schemaStr.length <= 400) {
			const schemaScan = scanTextForAgentRisk(schemaStr, { source: "extension", provenance: "external" });
			if (schemaScan.risk !== "safe") {
				showSchema = false;
				findings.push(`schema: ${schemaScan.risk} (${schemaScan.score})`);
			}
		}
	}
	if (described.description !== tool.description) {
		findings.push("description: omitted");
	}
	return { kind: "kept", tool: described, showSchema, findings };
}
