// herdr-control: herdr data-structure schemas (single source of truth).
//
// Every JSON shape herdr-control reads out of herdr CLI output is defined
// here ONCE as a JSON-Schema-style object, validated at the parse boundary
// with the tiny built-in validator below, and consumed as a typed value.
// Do NOT hand-roll `asRecord`/`pickString`/inline casts at call sites —
// extend a schema here instead, so shapes cannot drift independently.
//
// Sources (verified against herdr 0.9.3, latest stable per CHANGELOG):
//   - `herdr --skill` + subcommand --help (control-command envelopes)
//   - `herdr status --json` (client/server version probe)
//   - docs: most control commands return JSON envelopes
//     {id, result, type}; server errors are JSON on stderr, exit 1.
//
// Schema objects intentionally avoid importing "typebox" directly: the test
// runner runs without node_modules (see string-enum.ts), so we emit plain
// JSON-Schema-compatible objects with the same builders. pi's tool-parameter
// schemas continue to come from string-enum.ts's Type re-export; the shapes
// HERE describe herdr's *responses*, not our tool inputs.

export interface JsonSchemaNode {
	type?: string;
	properties?: Record<string, JsonSchemaNode>;
	required?: string[];
	items?: JsonSchemaNode;
	enum?: string[];
	// `{}` (no type) matches anything — used for opaque/unknown payloads.
}

// -- Primitive builders ------------------------------------------------------

type Options = Record<string, unknown>;

export const S = {
	any: {} as JsonSchemaNode,
	string: (options: Options = {}) => ({ type: "string", ...options }) as JsonSchemaNode,
	boolean: (options: Options = {}) => ({ type: "boolean", ...options }) as JsonSchemaNode,
	number: (options: Options = {}) => ({ type: "number", ...options }) as JsonSchemaNode,
	integer: (options: Options = {}) => ({ type: "integer", ...options }) as JsonSchemaNode,
	array: (items: JsonSchemaNode, options: Options = {}) => ({ type: "array", items, ...options }) as JsonSchemaNode,
	object: (properties: Record<string, JsonSchemaNode>, required: string[] = [], options: Options = {}) =>
		({ type: "object", properties, required, ...options }) as JsonSchemaNode,
};

// -- herdr response schemas (0.9.x) ------------------------------------------

// Standard control-command envelope: {"id":"cli:...","result":{...},"type":"..."}
export const HerdrEnvelopeSchema = S.object(
	{
		id: S.string(),
		type: S.string(),
		result: S.any,
	},
	["id", "result"],
);

// `agent list` / `agent get` agent rows (lib/list.ts HerdrAgentInfo).
// LIVE FINDING (herdr 0.9.3): rows are NOT uniform — integration-backed rows
// (claude) key the name as `agent`, while path-sourced pi rows carry `name`
// and can omit `agent` entirely, plus `screen_detection_skipped: true` (herdr
// is NOT reading those panes' screens — it reports them `working` even mid-
// dialog). Both keys and the flag are consumed so the classifier can (a) find
// any row and (b) distrust herdr's status for skipped panes.
export const HerdrAgentSchema = S.object({
	agent: S.string(),
	name: S.string(),
	agent_status: S.string(),
	pane_id: S.string(),
	tab_id: S.string(),
	workspace_id: S.string(),
	cwd: S.string(),
	foreground_cwd: S.string(),
	terminal_title_stripped: S.string(),
	focused: S.boolean(),
	screen_detection_skipped: S.boolean(),
});

export const AgentListResultSchema = S.object({ agents: S.array(HerdrAgentSchema) }, ["agents"]);
export const AgentGetResultSchema = S.object({ agent: HerdrAgentSchema }, ["agent"]);

// `agent start` / `agent prompt --wait` success result: lifecycle echo.
export const AgentLifecycleResultSchema = S.object({ agent: S.object({ agent_status: S.string() }) });

// Pane rows from `pane split` (`.result.pane`), `workspace create` /
// `tab create` (`.result.root_pane`), and `pane list`.
export const HerdrPaneSchema = S.object({
	pane_id: S.string(),
	workspace_id: S.string(),
	tab_id: S.string(),
	focused: S.boolean(),
});

export const PaneSplitResultSchema = S.object({ pane: HerdrPaneSchema }, ["pane"]);
export const PaneListResultSchema = S.object({ panes: S.array(HerdrPaneSchema) });

// `workspace create` returns .result.workspace / .result.tab / .result.root_pane;
// `tab create` returns .result.tab and .result.root_pane.
export const WorkspaceCreateResultSchema = S.object({
	root_pane: HerdrPaneSchema,
	workspace: S.object({ id: S.string() }),
	tab: S.object({ id: S.string() }),
});
export const TabCreateResultSchema = S.object({
	root_pane: HerdrPaneSchema,
	tab: S.object({ id: S.string() }),
});

// `pane layout --current` (caller-pane geometry for direction auto).
export const PaneLayoutResultSchema = S.object({
	layout: S.object({
		panes: S.array(
			S.object({
				pane_id: S.string(),
				focused: S.boolean(),
				rect: S.object({ width: S.number(), height: S.number() }),
			}),
		),
	}),
});

// `herdr status --json`: client always present; server absent/stopped when
// the server is down. Fields stay optional so shape drift degrades to
// "version unknown" instead of a hard parse failure.
export const HerdrStatusSchema = S.object({
	client: S.object({ version: S.string(), protocol: S.integer() }),
	server: S.object({
		status: S.string(),
		running: S.boolean(),
		version: S.string(),
		protocol: S.integer(),
		compatible: S.boolean(),
		socket: S.string(),
	}),
});

// -- Validation ---------------------------------------------------------------

export type Validation =
	| { ok: true }
	| { ok: false; error: string };

function typeMatches(node: JsonSchemaNode, value: unknown): boolean {
	switch (node.type) {
		case undefined:
			return true; // S.any
		case "string":
			return typeof value === "string";
		case "boolean":
			return typeof value === "boolean";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "array":
			return Array.isArray(value);
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		default:
			return false;
	}
}

// Structural validator over the schema subset above. Additional properties
// are always allowed (herdr adds fields between releases; we pin the ones we
// consume). Unknown `type` values fail closed.
export function validateSchema(schema: JsonSchemaNode, value: unknown, path = "$"): Validation {
	if (!typeMatches(schema, value)) {
		return { ok: false, error: `${path}: expected ${schema.type ?? "any"}` };
	}
	if (schema.enum && typeof value === "string" && !schema.enum.includes(value)) {
		return { ok: false, error: `${path}: expected one of ${schema.enum.join("|")}` };
	}
	if (schema.type === "object") {
		for (const key of schema.required ?? []) {
			if (!(key in (value as Record<string, unknown>))) {
				return { ok: false, error: `${path}: missing required property "${key}"` };
			}
		}
		for (const [key, child] of Object.entries(schema.properties ?? {})) {
			const childValue = (value as Record<string, unknown>)[key];
			if (childValue === undefined) continue;
			const checked = validateSchema(child, childValue, `${path}.${key}`);
			if (!checked.ok) return checked;
		}
	}
	if (schema.type === "array") {
		let i = 0;
		for (const item of value as unknown[]) {
			const checked = validateSchema(schema.items ?? S.any, item, `${path}[${i}]`);
			if (!checked.ok) return checked;
			i += 1;
		}
	}
	return { ok: true };
}

export type SchemaParse<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

// Validate `value` against a result schema and hand back a typed view.
export function schemaParse<T>(schema: JsonSchemaNode, value: unknown): SchemaParse<T> {
	const checked = validateSchema(schema, value);
	if (!checked.ok) return { ok: false, error: `herdr response shape mismatch: ${checked.error}` };
	return { ok: true, value: value as T };
}
