# rlm-reviewer

A pull request reviewer that reads even huge PRs the way Recursive Language Models do: the diff and changed files are loaded as variables in a sandboxed Python box, the model explores them with code, sends one helper per file it wants read closely, and hands in review comments anchored to changed lines, with suggested fixes for small, certain issues.

Status: Phase 1 (core CLI). Next: a baseline reviewer, a planted-bug eval, a GitHub Action.

## How it works
1. Load the PR into a Docker box (no network, read-only, memory and time limits): `pr`, `files`, `patches`, `changed_lines`, `diff`.
2. The root model sees only the PR title, description and file list (author text fenced as untrusted), then explores with the `python` tool.
3. `sub_review(path, focus)` sends one file (diff + numbered content) to a helper, which returns JSON findings.
4. `finish(comments)` hands in the review. Comments not on a changed line are dropped; suggestions longer than 10 lines are removed.

## Run
```bash
bun install
export OPENROUTER_API_KEY=...
bun src/cli.ts --repo /path/to/repo --base main --title "PR title" --body "PR description"
bun test
```
