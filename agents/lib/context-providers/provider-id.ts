/** P9: the review-context provider id vocabulary. Kept in a leaf module (no node imports) so
 *  specs.ts can reference ProviderId without pulling in the fs/git-bearing assembler. */

export type ProviderId = "git-diff" | "changed-files" | "branch-commits" | "plan-docs";

export const ALL_PROVIDER_IDS: readonly ProviderId[] = ["git-diff", "changed-files", "branch-commits", "plan-docs"];

export function isProviderId(value: unknown): value is ProviderId {
	return typeof value === "string" && (ALL_PROVIDER_IDS as readonly string[]).includes(value);
}
