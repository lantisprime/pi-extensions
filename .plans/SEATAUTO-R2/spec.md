# SEATAUTO-R2 — permission-policy seatAuto review round 2

- Source of truth: `.brief/SEATAUTO-R2.md` (git-ignored scratch; its content is
  mirrored in the AC table below so this file stands alone).
- Base: `2684ddf` on `feat/seat-auto` (round 1 fixes landed). Round 2 panel:
  GLM-5.3, seats A and B, both REVISE.
- Deliverable: ONE new commit; every security fix carries an adversarial test
  that fails on `2684ddf`, proven by a stash cycle on
  `permission-policy/index.ts`.
- Deferred (do not implement): extending protected roots (~/.gitconfig,
  ~/.npmrc, ~/Library/LaunchAgents) needs a spec amendment; B9 guard-arm race
  is near-impossible on a single thread.

## Hard rules

- Local only: no push, no gh, no network, no npm install. Tests run with the
  cached tsx only (`npx --yes tsx <file>`).
- Never write outside this worktree except `/tmp` logs and the herdr-driver
  manifest.
- Commit with `git commit -F .brief/COMMIT_MSG`, never a long `-m`; message
  ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Acceptance criteria

| AC | Finding | Fix | Adversarial test (fails on 2684ddf) |
|----|---------|-----|--------------------------------------|
| AC-1 | A1/B4 HIGH — protected-path reads reach stored grants | carry the resolved read target on the request; `isProtectedPath` gate in `ensurePermission` BEFORE yolo auto-allow and BEFORE session/project grants, in every mode | stored `readOutsideProject=allow` + `read ~/.ssh/x` (absolute equivalent; pi expands ~ before the tool runs) → dialog; same via in-project symlink `ssh-link/id_rsa` → dialog; yolo mode → dialog |
| AC-2 | B2 HIGH — outside-mention scan is lexical | resolve every path-like token (`path.resolve(cwd, token)`) then `isOutsideProject`; same for `--opt=value` and glued `-X<value>` values; fail-closed false positives fine | `cat x/../../.zsh_history`, `cat ./../.netrc`, `git diff --no-index x/../../etc/passwd /dev/null` → dialog; plain in-project relative path stays allowed |
| AC-3 | B1 BLOCKER — output/exec options on "read-only" heads | (a) strict shape for `sort`: deny `-o*`, `--output*`, short cluster containing `o` (audit additions: `--compress-program`, `--random-source`, `--files0-from`, `-T`); (b) audit every SIMPLE_READONLY_COMMANDS member (decisions in commit body) | `sort -o FILE`, `sort --output=FILE`, `sort --output==x`, cluster `-no`, `uniq IN OUT`, `wc --files0-from`, `file -C`, `rg --pre=CMD`, `sort --compress-program=…` → dialog; benign forms stay allowed |
| AC-4 | B3 MED — quote modelling | fail closed: any token whose quotes are not one simple pair around the whole token → dialog (covers internal quotes, mixed quotes, adjacent fragments, `a"b"c`); whole-token pairs stay fine | `cat "x'$PWD/..'y"` and `cat a"b"c` → dialog; `git commit -m "x # y"` stays allowed |
| AC-5 | B5a — git global options | parseGitSegment allowlist: `-C <in-project>` and `--no-pager` only; anything else denied | `git --pager=sh log` → dialog |
| AC-6 | B5b — test-runner argfiles | reject any test-runner argument starting with `@` | `./node_modules/.bin/tsc --noEmit @args` → dialog |
| AC-7 | A4 LOW — N3 manifest exception scope | pre-grant-gate manifest exception applies only while `isSeatAutoActive(policy)`, and with the same lstat/nlink checks | ask mode + seat block + stored writeFiles grant + manifest write → dialog; expired-seat variant → dialog; seatAuto variant stays allowed |
| AC-8 | A3 LOW — test stub | suites refuse to overwrite an existing `node_modules/@earendil-works/pi-ai` (clear failure, all three suites) | verified directly: pre-create the stub, run a suite, expect exit 1 + message (test-infra fix; no in-suite assertion possible) |
| AC-9 | A2 nit — wrong comment | test-seat-auto.ts:548 comment corrected: `#` comments to end of line, so only `echo ok` would run; the dialog is the fail-closed outcome | comment-only; covered by the existing A5 rows |

## Verification protocol

1. All three suites with `HOME="$(mktemp -d)"`, logs in `/tmp/seatauto-r2-*.log`,
   exit codes checked directly.
2. Stash proof: `git stash push -- permission-policy/index.ts` (implementation
   back at 2684ddf, new tests still present) → new adversarial tests FAIL;
   `git stash pop` → all suites pass again.
3. Single commit with `-F .brief/COMMIT_MSG`; worktree kept.
