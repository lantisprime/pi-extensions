export interface BgArgsParseResult {
	readonly backendName?: string;
	readonly backendFlagMissingValue: boolean;
	readonly profileName?: string;
	readonly profileFlagMissingValue: boolean;
	readonly restArgs: string;
}

export function parseBgArgs(rawArgs: string): BgArgsParseResult {
	const trimmed = (rawArgs ?? "").trim();
	const tokens = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
	if (tokens[0] !== "--backend" && tokens[0] !== "--profile") {
		// State A: return the ORIGINAL untrimmed rawArgs so handleBgCommand's
		// `parse.restArgs.split(/\s+/)` is byte-identical to today's
		// `args.split(/\s+/)` (including the leading-whitespace → empty
		// agentName → usage-error path). The command dispatcher trims
		// `parsed.rest` before calling handleBgCommand, so this only matters for direct calls.
		return { backendFlagMissingValue: false, profileFlagMissingValue: false, restArgs: rawArgs ?? "" };
	}
	if (tokens[0] === "--backend") {
		// State C: `--backend` is the only token (no value follows).
		if (tokens.length < 2) {
			return { backendFlagMissingValue: true, backendName: "", profileFlagMissingValue: false, restArgs: "" };
		}
		// State B: `--backend <name>` is the first two tokens; rest becomes agent+task.
		const name = tokens[1];
		const rest = tokens.slice(2).join(" ");
		return { backendName: name, backendFlagMissingValue: false, profileFlagMissingValue: false, restArgs: rest };
	}
	// tokens[0] === "--profile" — mirrors the --backend pattern.
	// State C: `--profile` is the only token (no value follows).
	if (tokens.length < 2) {
		return { backendFlagMissingValue: false, profileName: "", profileFlagMissingValue: true, restArgs: "" };
	}
	// State B: `--profile <name>` is the first two tokens; rest becomes agent+task.
	const name = tokens[1];
	const rest = tokens.slice(2).join(" ");
	return { backendFlagMissingValue: false, profileName: name, profileFlagMissingValue: false, restArgs: rest };
}
