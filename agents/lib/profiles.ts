/**
 * P3f-1: Model profiles — pure helpers for reusable (model, thinking) presets.
 *
 * This file is new (zero changes to existing agent-scaffold files).
 * It defines the ModelProfile type, validation, resolution (profile-as-authority
 * with spec fallback), and three built-in capability-hint profiles.
 *
 * P3f-2 wires this into runChildAgent. P3f-3 adds file discovery + hash-registration.
 */

import {
  type AgentValidationIssue,
  type AgentValidationResult,
  type ThinkingLevel,
  THINKING_LEVELS,
  extractThinkingFromModel,
  isThinkingLevel,
  isValidAgentName,
  validateModelAndThinking,
} from "./specs.ts";

// ── Local redefinitions (not exported from specs.ts) ──────────────────────

/** Mirrors specs.ts L101. P3f-2 consolidates via export/import. */
const SAFE_ARG_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,127}$/;

/** Mirrors specs.ts L529-535. 7-line deep-freeze helper. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

// ── Types ─────────────────────────────────────────────────────────────────

/** A named reusable (model, thinking) combination. Never carries tools/safety/limits/forbiddenTools. */
export type ModelProfile = {
  /** Profile name: same regex as agent names (^[a-z][a-z0-9_-]{0,63}$). */
  name: string;
  /** Model pattern (safe argv token). Absent = use spec fallback or Pi default. */
  model?: string;
  /** Thinking level. Absent = use spec fallback or Pi default. */
  thinking?: ThinkingLevel;
  /** Human-readable description surfaced in /agents profiles (P3f-2). */
  purpose?: string;
};

/** A collection of profiles. Order determines lookup precedence (built-in > user > project). */
export type ModelProfileLibrary = {
  profiles: ModelProfile[];
};

/** Output of successful profile resolution. */
export type ResolvedProfile = {
  effectiveModel: string | undefined;
  effectiveThinking: ThinkingLevel | undefined;
  /** Which profile resolved (undefined = passthrough, no profile referenced). */
  profileName: string | undefined;
  /** Did the profile (not spec fallback) set model? */
  profileProvidedModel: boolean;
  /** Did the profile (not spec fallback) set thinking? */
  profileProvidedThinking: boolean;
};

/** Discriminated union: resolution succeeds (resolved: true) or fails (resolved: false). */
export type ProfileResolutionResult =
  | (ResolvedProfile & { resolved: true })
  | { resolved: false; error: AgentValidationIssue };

// ── Helpers ───────────────────────────────────────────────────────────────

function result(issues: AgentValidationIssue[]): AgentValidationResult {
  return { ok: issues.length === 0, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── Validation ────────────────────────────────────────────────────────────

const FORBIDDEN_PROFILE_FIELDS = ["tools", "safety", "limits", "forbiddenTools"] as const;

/**
 * Validate a single ModelProfile. Accepts any value; returns AgentValidationResult.
 *
 * 11 checks in deterministic order, collects all issues (not fail-fast):
 *   1. Must be a non-null, non-array object
 *   2. name must be a non-empty string
 *   3. name must pass isValidAgentName()
 *   4-7. Reject forbidden fields: tools, safety, limits, forbiddenTools
 *   8. model if present: must be a non-empty string
 *   9. model if present: must pass SAFE_ARG_TOKEN_RE
 *  10. thinking if present: must pass isThinkingLevel()
 *  11. purpose if present: must be a string (empty allowed)
 *
 * Absent optional fields (model, thinking, purpose) are NOT errors.
 * Unknown keys are silently ignored.
 */
export function validateProfile(profile: unknown): AgentValidationResult {
  const issues: AgentValidationIssue[] = [];

  // 1. Must be a non-null, non-array object
  if (!isRecord(profile)) {
    issues.push({ field: "profile", code: "profile-invalid", message: "profile must be a non-null object" });
    return result(issues);
  }

  // 2. name must be a non-empty string
  const rawName = profile.name;
  if (typeof rawName !== "string" || rawName.length === 0) {
    issues.push({ field: "name", code: "name-required", message: "profile name must be a non-empty string" });
  } else {
    // 3. name must pass isValidAgentName()
    if (!isValidAgentName(rawName)) {
      issues.push({ field: "name", code: "name-invalid", message: "profile name must match ^[a-z][a-z0-9_-]{0,63}$" });
    }
  }

  // 4-7. Reject forbidden fields
  for (const field of FORBIDDEN_PROFILE_FIELDS) {
    if (field in profile) {
      issues.push({
        field,
        code: "profile-forbidden-field",
        message: `profile must not contain field '${field}'`,
      });
    }
  }

  // 8-9. model validation (if present)
  if ("model" in profile && profile.model !== undefined) {
    const model = profile.model;
    if (typeof model !== "string" || model.length === 0) {
      issues.push({ field: "model", code: "model-invalid", message: "profile model must be a non-empty string when provided" });
    } else if (!SAFE_ARG_TOKEN_RE.test(model)) {
      issues.push({ field: "model", code: "model-invalid", message: "profile model must be a safe argv token" });
    }
    // model absent (undefined or key not present) is NOT an error
  }

  // 10. thinking validation (if present)
  if ("thinking" in profile && profile.thinking !== undefined) {
    const thinking = profile.thinking;
    if (typeof thinking !== "string" || !isThinkingLevel(thinking)) {
      issues.push({
        field: "thinking",
        code: "thinking-invalid",
        message: `thinking must be one of: ${THINKING_LEVELS.join(", ")}`,
      });
    }
  }

  // 11. purpose validation (if present)
  if ("purpose" in profile && profile.purpose !== undefined) {
    if (typeof profile.purpose !== "string") {
      issues.push({ field: "purpose", code: "purpose-invalid", message: "purpose must be a string when provided" });
    }
    // empty string is allowed
  }

  return result(issues);
}

/**
 * Validate a ModelProfileLibrary.
 *
 * Checks:
 *   1. library.profiles must be an array
 *   2. Each profile passes validateProfile (issues field-prefixed profiles[N].<field>)
 *   3. No duplicate names (runs AFTER individual validation)
 *
 * Empty profiles array is valid.
 */
export function validateProfileLibrary(library: ModelProfileLibrary): AgentValidationResult {
  const issues: AgentValidationIssue[] = [];
  const profiles = library.profiles;

  // 1. Must be an array
  if (!Array.isArray(profiles)) {
    issues.push({ field: "library", code: "library-invalid", message: "profile library must have a profiles array" });
    return result(issues);
  }

  // 2. Validate each profile
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();

  for (let i = 0; i < profiles.length; i++) {
    const profileResult = validateProfile(profiles[i]);
    for (const issue of profileResult.issues) {
      issues.push({
        field: `profiles[${i}].${issue.field}`,
        code: issue.code,
        message: issue.message,
      });
    }

    // Track names for duplicate check (even if profile has other validation errors)
    const rawProfile = profiles[i];
    if (isRecord(rawProfile) && typeof rawProfile.name === "string") {
      if (seenNames.has(rawProfile.name)) {
        duplicateNames.add(rawProfile.name);
      } else {
        seenNames.add(rawProfile.name);
      }
    }
  }

  // 3. Duplicate name check (runs after individual validation)
  for (const name of duplicateNames) {
    issues.push({
      field: "profiles",
      code: "profile-duplicate-name",
      message: `duplicate profile name '${name}'`,
    });
  }

  return result(issues);
}

// ── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve a spec's profile reference into effective model/thinking values.
 *
 * Profile-as-authority: when a spec references a profile, profile values win
 * over spec values. Spec values are fallbacks used only when the profile
 * omits a field (field-level merge, not object-level ??).
 *
 * Five resolution states (exhaustive):
 *   A. Passthrough  — spec.profile is undefined/null/""
 *   B. No library   — spec.profile is set but no library available
 *   C. Not found    — spec.profile is set, library present, name not found
 *   D. Resolved     — profile found, no conflict
 *   E. Conflict     — profile found, but merge produces model:high + different thinking
 *
 * Never mutates the input spec object.
 */
export function resolveSpecProfile(
  spec: { model?: string; thinking?: ThinkingLevel; profile?: string },
  library?: ModelProfileLibrary,
): ProfileResolutionResult {
  // State A: Passthrough — no profile reference
  const profileName = spec.profile;
  if (profileName === undefined || profileName === null || profileName === "") {
    return {
      resolved: true,
      effectiveModel: spec.model,
      effectiveThinking: spec.thinking,
      profileName: undefined,
      profileProvidedModel: false,
      profileProvidedThinking: false,
    };
  }

  // State B: No library — profile is set but no library available
  if (!library || !Array.isArray(library.profiles) || library.profiles.length === 0) {
    return {
      resolved: false,
      error: {
        field: "profile",
        code: "profile-unresolved",
        message: "no profile library available",
      },
    };
  }

  // Find the profile by name
  const profile = library.profiles.find((p) => p.name === profileName);

  // State C: Not found
  if (!profile) {
    return {
      resolved: false,
      error: {
        field: "profile",
        code: "profile-unresolved",
        message: `profile '${profileName}' not found in library`,
      },
    };
  }

  // Field-level merge: profile is authoritative; spec fills gaps
  const profileHasModel = "model" in profile && profile.model !== undefined;
  const profileHasThinking = "thinking" in profile && profile.thinking !== undefined;

  const effectiveModel = profileHasModel ? profile.model : spec.model;
  const effectiveThinking = profileHasThinking ? profile.thinking : spec.thinking;

  // State E check: conflict detection
  // Only run validateModelAndThinking when BOTH effective values are set
  if (effectiveModel !== undefined && effectiveThinking !== undefined) {
    const conflictResult = validateModelAndThinking(effectiveModel, effectiveThinking);
    if (!conflictResult.ok) {
      return {
        resolved: false,
        error: conflictResult.issues[0], // propagate first conflict issue
      };
    }
  }

  // State D: Resolved
  return {
    resolved: true,
    effectiveModel,
    effectiveThinking,
    profileName: profile.name,
    profileProvidedModel: profileHasModel,
    profileProvidedThinking: profileHasThinking,
  };
}

// ── Built-in profiles ─────────────────────────────────────────────────────

/**
 * Built-in capability-hint profiles. No hardcoded model values.
 *
 * fast-local:        Pi defaults, fast scans
 * reasoning-deep:    thinking: high for planning/analysis
 * adversarial-review: thinking: high, different-provider preference
 */
const BUILT_IN_PROFILE_DEFS: ModelProfile[] = [
  {
    name: "fast-local",
    purpose: "Quick local scans where latency matters more than depth",
  },
  {
    name: "reasoning-deep",
    thinking: "high" as ThinkingLevel,
    purpose: "Deep reasoning for planning and analysis",
  },
  {
    name: "adversarial-review",
    thinking: "high" as ThinkingLevel,
    purpose: "Skeptical review requiring a different provider for model-diversity",
  },
];

export const BUILT_IN_PROFILES: Readonly<Record<string, ModelProfile>> = deepFreeze(
  Object.fromEntries(BUILT_IN_PROFILE_DEFS.map((p) => [p.name, p])),
);

/** Safe lookup: returns undefined for unknown names. */
export function getBuiltInProfile(name: string): ModelProfile | undefined {
  return BUILT_IN_PROFILES[name];
}

/** Return built-in profiles in definition order. */
export function listBuiltInProfiles(): ModelProfile[] {
  return BUILT_IN_PROFILE_DEFS.map((p) => ({ ...p }));
}

/** Format a one-line-per-profile listing for display. */
export function formatBuiltInProfilesList(profiles?: readonly ModelProfile[]): string {
  const list = profiles ?? BUILT_IN_PROFILE_DEFS;
  if (list.length === 0) return "(none)";
  return list
    .map((p) => {
      const parts = [p.name];
      if (p.model) parts.push(`model=${p.model}`);
      if (p.thinking) parts.push(`thinking=${p.thinking}`);
      if (p.purpose) parts.push(`(${p.purpose})`);
      return parts.join(" ");
    })
    .join("\n");
}

/** Wrap built-in profiles in a ModelProfileLibrary for resolution. */
export function toProfileLibrary(): ModelProfileLibrary {
  return deepFreeze({ profiles: listBuiltInProfiles() });
}
