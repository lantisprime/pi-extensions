// Module augmentation: state this extension attaches to the contexts pi hands it.
//
// WHY THIS EXISTS
// Pi passes a plain `ExtensionContext` object to every event/command handler. This
// extension stores its own state on that same object (a profile library, the
// resolved project trust + registry, the child-runner seam, a result-delivery
// callback) so later handlers in the same session can see it. That is a real,
// load-bearing pattern here — see the session_start wiring in index.ts and the
// "the input event hands us a fresh ctx" re-attach in handleGateInput — but pi's
// own types do not model "extensions may stash state on the context".
//
// Before this file, every one of those assignments was a type error (~20 of them)
// in index.ts. The previous alternative was 20 scattered `as unknown as` casts,
// which would have hidden the fact that the field has to exist on the host object
// at runtime. Declaring them here makes the requirement explicit and keeps the
// assignments type-checked.
//
// `ExtensionCommandContext extends ExtensionContext`, so augmenting the base
// covers command handlers too.
//
// Verified this actually MERGES (rather than being silently ignored): reading a
// field that exists only in this declaration type-checks, which it would not if
// the re-exported interface from the package root failed to merge.

import type { ChildAgentRunner } from "./child-runner.ts";
import type { AgentSpec } from "./specs.ts";
import type { ProjectAgentRegistry } from "./registry.ts";
import type { ModelProfileLibrary, ProfileLibraryBuildWarning } from "./profiles.ts";

declare module "@earendil-works/pi-coding-agent" {
	interface ExtensionContext {
		/** Where the agents library resolves profiles from; see buildProfileLibrary. */
		profileLibrary?: ModelProfileLibrary;
		/** Non-fatal problems hit while building the library above. */
		profileLibraryWarnings?: ProfileLibraryBuildWarning[];
		/** Resolved agents home (~/.pi/agents), for diagnostics and profile discovery. */
		agentsHomeDir?: string;
		/** The `pi` executable to spawn children with; defaults to "pi" on PATH. */
		agentsPiCommand?: string;
		/** Test/DI seam for the child runner (wiring tests inject a fake). */
		agentsChildRunner?: ChildAgentRunner;
		/** Last /agents run-temp spec + task, so the follow-up turn can reuse it. */
		agentsLastEphemeralSpec?: { spec: AgentSpec; task: string };
		/** Resolved project trust, threaded to the run path for the profile trust check. */
		projectTrusted?: boolean;
		/** Project agent registry that pairs with projectTrusted. */
		projectRegistry?: ProjectAgentRegistry;
		/** SEC-5: gate-routed children set this so they spawn with --no-context-files. */
		disableContextFiles?: boolean;
		/** Injects a completed subagent's result into pi's conversation. Wired to
		 *  pi.sendUserMessage at session_start; absent in non-TUI sessions. */
		deliverResult?: (content: string) => void;
	}
}
