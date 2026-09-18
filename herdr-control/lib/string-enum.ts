// herdr-control: Google-compatible string enum schema helper.
//
// extensions.md requires StringEnum from @earendil-works/pi-ai for string
// enums ("Type.Union/Type.Literal doesn't work with Google's API"). pi-ai is
// available at runtime under pi's jiti loader, but not under the repo's
// `node --experimental-strip-types` test runner (no node_modules), so we
// replicate pi-ai's emitted schema shape here: { type: "string", enum: [...] }.
// This mirrors cmux-control's dynamic typebox import pattern.

type TypeBoxType = {
	Object(properties: Record<string, unknown>, options?: Record<string, unknown>): unknown;
	String(options?: Record<string, unknown>): unknown;
	Integer(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Optional(schema: unknown): unknown;
	Unsafe<T>(options: Record<string, unknown>): T;
};

const { Type } = await import("typebox").catch(() => ({
	Type: {
		Object: (properties: Record<string, unknown>, options: Record<string, unknown> = {}) => ({ type: "object", properties, ...options }),
		String: (options: Record<string, unknown> = {}) => ({ type: "string", ...options }),
		Integer: (options: Record<string, unknown> = {}) => ({ type: "integer", ...options }),
		Boolean: (options: Record<string, unknown> = {}) => ({ type: "boolean", ...options }),
		Optional: (schema: unknown) => schema,
		Unsafe: <T,>(options: Record<string, unknown>) => options as T,
	} satisfies TypeBoxType,
}));

export function stringEnum<T extends readonly [string, ...string[]]>(values: T): unknown {
	return Type.Unsafe<unknown>({ type: "string", enum: [...values] });
}

export { Type };
