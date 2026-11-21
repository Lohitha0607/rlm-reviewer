# rlm-reviewer

A pull request reviewer that reads even huge PRs the way Recursive Language Models do: the diff and changed files are loaded as variables in a sandboxed Python box, the model explores them with code, sends one helper per file it wants read closely, and hands in review comments anchored to changed lines, with suggested fixes for small, certain issues.

Status: core reviewer, baseline and planted-bug eval done. Next: a GitHub Action.

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

## Results (Nemotron 3.5 Super via OpenRouter)
`eval/make_prs.py` builds three PRs whose bugs contradict the PR description (pagination returns one extra item, a discount excludes exactly 100, negative ages are accepted). Everything else is correct code. `eval/run_eval.ts` runs the RLM reviewer and the baseline (the whole diff in one prompt) and checks each suggested fix by applying it and running a test for the bug in Docker.

Totals over 3 runs (after the suggestion fixes):

| PR | Reviewer | Bugs detected | On the right line | Fixes that pass the test | Mean input tokens |
|---|---|---|---|---|---|
| small (2 files) | baseline | 6/6 | 6/6 | 4/6 | 1,090 |
| | RLM | 6/6 | 6/6 | 6/6 | 8,541 |
| medium (15 files) | baseline | 9/9 | 3/9 | 3/9 | 19,024 |
| | RLM | 9/9 | 9/9 | 8/9 | 55,499 |
| huge (60 files) | baseline | 9/9 | 6/9 | 6/9 | 75,885 |
| | RLM | 9/9 | 9/9 | 8/9 | 29,908 |

- Both reviewers notice every bug. The baseline often points 7–9 lines too early (it has to count lines in the raw diff); the RLM reviewer's helpers read numbered files and land on the right line every time, so its suggested fixes apply cleanly.
- Cost depends on size: the RLM reviewer costs more on small and medium PRs and about 2.5× less on the 60-file PR.
- 0 false alarms in all 18 reviews.
- Limits: synthetic PRs, one bug per file, one model, 3 runs per cell.
