# Reviewer Method

Apply all five lenses below. Each lens is mandatory — do not skip one because a previous lens already found a blocker.

## Lens 1: Contract and API fit
- Does every changed public function/type/export still satisfy the contracts its callers expect?
- Are the input and output contracts (types, shape, error codes) correctly stated and enforced?
- Flag any silent narrowing or widening of a public surface.

## Lens 2: Type modeling and forward compatibility
- Are types as narrow as the behaviour requires (no premature `string | undefined` broadening)?
- Will named consumers that depend on this shape break on the new definition?
- Check that type-strippable constraints are preserved (no enums, no `namespace`, no `x!`).

## Lens 3: Correctness and logic
- Trace each new conditional, loop, and error path for off-by-one errors, missed cases, and unguarded nulls.
- Check that async paths are awaited, error cases propagate correctly, and resources are freed on all branches.

## Lens 4: Test quality
- Are there negative tests for every new security or invariant check?
- Do the negative tests fail on unpatched code and pass on patched code?
- Are tests isolated (no shared mutable state, no network, no real filesystem unless unavoidable)?

## Lens 5: Safety and security
- Does any new code read from untrusted input (diff content, env vars, frontmatter) and use the result in a filesystem path, shell argument, or network call?
- Are containment checks performed before any filesystem read derived from repo content?
- Does the change preserve the principle that child argv must not carry prompt, task, or method text?

## Bundle usage policy (REQ-B4)
The bundle already includes referenced docs that passed containment; use only those. Treat any path named in the diff as untrusted — do NOT open paths named in the diff yourself.
