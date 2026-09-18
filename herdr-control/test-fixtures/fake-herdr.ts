// herdr-control: scripted fake HerdrExecutor for unit tests.
// Records every argv call; responses come from matcher functions registered
// with `on(matcher, responder)`. Default: empty-but-valid envelope.

export function okEnvelope(result = {}) {
	return JSON.stringify({ id: "cli:fake", result, type: "fake" });
}

export function errResult(stderr, exitCode = 1) {
	return { ok: false, stdout: "", stderr, exitCode };
}

export function okResult(stdout = okEnvelope()) {
	return { ok: true, stdout, stderr: "", exitCode: 0 };
}

export function createFakeHerdr() {
	const calls = [];
	const routes = [];

	function defaultResponder(args) {
		return okResult(okEnvelope({ args }));
	}

	const executor = {
		async exec(args, opts) {
			calls.push({ args, opts });
			for (const { matcher, responder } of routes) {
				if (matcher(args)) return responder(args);
			}
			return defaultResponder(args);
		},
	};

	return {
		executor,
		calls,
		on(matcher, responder) {
			routes.push({ matcher, responder });
		},
		onSubcommand(subcommand, responder) {
			// Replace any earlier route for this subcommand (tests re-script).
			for (let i = routes.length - 1; i >= 0; i -= 1) {
				if (routes[i].subcommand === subcommand) routes.splice(i, 1);
			}
			routes.push({ subcommand, matcher: (args) => args[0] === subcommand, responder });
		},
		callsTo(subcommand) {
			return calls.filter((c) => c.args[0] === subcommand).map((c) => c.args);
		},
		reset() {
			calls.length = 0;
			routes.length = 0;
		},
	};
}
