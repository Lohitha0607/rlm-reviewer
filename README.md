# RLM reviewer

An AI pull request reviewer that reads even huge PRs the way **Recursive Language Models** do. Instead of pasting the whole diff into one prompt, it loads the PR into a sandboxed Python box, lets the model explore it with code, sends one helper per file it wants read closely, and posts a review with comments on the exact lines and **"Commit suggestion"** fixes.

**Live demo:** [a PR with two planted bugs, reviewed by this Action](https://github.com/Lohitha0607/rlm-review-demo/pull/1)

## Use it as a GitHub Action

**1. Add your model API key as a repository secret.**
Settings → Secrets and variables → Actions → New repository secret, named `OPENROUTER_API_KEY` (any OpenAI-compatible endpoint works; see the inputs below).

**2. Add `.github/workflows/rlm-review.yml`:**

```yaml
name: RLM review
on:
  pull_request:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: Lohitha0607/rlm-reviewer@v1
        with:
          api-key: ${{ secrets.OPENROUTER_API_KEY }}
```

Every new commit on a pull request then gets one review. A commit that already has an RLM review is skipped.

### Inputs

| Input | Default | Description |
|---|---|---|
| `api-key` | (required) | API key for the model endpoint. Store it as a secret. |
| `model` | `nvidia/nemotron-3.5-super-vl` | Model id on the endpoint. |
| `base-url` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `github-token` | `${{ github.token }}` | Token used to post the review. |
| `dry-run` | `false` | `true` prints the review in the job log instead of posting it. |

Notes: the review runs on GitHub's runner with your key, so your code is only sent to the model endpoint you choose. Secrets are not available to pull requests from forks, so those are not reviewed.

## How it works

1. The PR is loaded into a Docker box (no network, read-only, memory and time limits) as Python variables: `pr`, `files`, `patches`, `changed_lines`, `diff`.
2. The root model sees only the PR title, description and file list (author text is treated as untrusted data) and explores the code with a `python` tool.
3. `sub_review(path, focus)` sends one file, with numbered lines, to a helper that returns findings.
4. `finish(comments)` hands in the review. Comments must be on changed lines; suggested fixes are re-indented and widened to cover every line they rewrite, and dropped if longer than 10 lines.

## Results

`eval/make_prs.py` builds three PRs whose bugs contradict the PR description (pagination returns one extra item, a discount excludes exactly 100, negative ages are accepted). Everything else is correct code. `eval/run_eval.ts` runs this reviewer and a baseline (the whole diff in one prompt, same model and rules) and checks each suggested fix by applying it and running a test for the bug in Docker.

Totals over 3 runs with Nemotron 3.5 Super:

| PR | Reviewer | Bugs detected | On the right line | Fixes that pass the test | Mean input tokens |
|---|---|---|---|---|---|
| small (2 files) | baseline | 6/6 | 6/6 | 4/6 | 1,090 |
| | RLM | 6/6 | 6/6 | 6/6 | 8,541 |
| medium (15 files) | baseline | 9/9 | 3/9 | 3/9 | 19,024 |
| | RLM | 9/9 | 9/9 | 8/9 | 55,499 |
| huge (60 files) | baseline | 9/9 | 6/9 | 6/9 | 75,885 |
| | RLM | 9/9 | 9/9 | 8/9 | 29,908 |

- Both reviewers notice every bug. The baseline often points 7–9 lines too early (it has to count lines in the raw diff); the RLM reviewer's helpers read numbered files and land on the right line every time, so its fixes apply cleanly.
- Cost depends on size: the RLM reviewer costs more on small and medium PRs and about 2.5× less on the 60-file PR.
- 0 false alarms in all 18 reviews.
- Limits: synthetic PRs, one bug per file, one model, 3 runs per cell.

## Run it locally

```bash
bun install
export OPENROUTER_API_KEY=...
bun src/cli.ts --repo /path/to/repo --base main --title "PR title" --body "PR description"

# fully local and free, with Ollama:
bun src/cli.ts --repo /path/to/repo --base main --base-url http://localhost:11434/v1 --model qwen3:8b

bun test
```

Needs Bun and Docker. `--mode baseline` runs the one-prompt baseline; `--json` prints the raw result.

## License

Apache-2.0
