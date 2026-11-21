"""Build pull-request repos with planted bugs at known lines.

Each repo has a `main` branch and a `pr` branch. Every changed file is new and
correct except a few with one planted bug that contradicts the PR description.
Writes <out>/<name>/ (the repo) and <out>/<name>.json (title, body, bugs).

Usage: python3 eval/make_prs.py [out_dir]
"""

from __future__ import annotations

import json
import random
import subprocess
import sys
from pathlib import Path

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/rlm-eval-prs")

DESCRIPTION = """This PR adds service modules for the new storefront.

Rules every module must follow:
- paginate(items, page, size) returns AT MOST `size` items for the given page.
- apply_discount(total) gives 10% off only for totals of AT LEAST 100.
- parse_age(text) must raise ValueError for negative ages.
"""

# (function name, correct body, buggy body, line offset of the bug inside the function)
BUGS = {
    "paginate": (
        [
            "def paginate(items, page, size):",
            "    start = page * size",
            "    return items[start:start + size]",
        ],
        [
            "def paginate(items, page, size):",
            "    start = page * size",
            "    return items[start:start + size + 1]",
        ],
        2,
        "returns size + 1 items",
    ),
    "apply_discount": (
        [
            "def apply_discount(total):",
            "    if total >= 100:",
            "        return round(total * 0.9, 2)",
            "    return total",
        ],
        [
            "def apply_discount(total):",
            "    if total > 100:",
            "        return round(total * 0.9, 2)",
            "    return total",
        ],
        1,
        "excludes a total of exactly 100",
    ),
    "parse_age": (
        [
            "def parse_age(text):",
            "    age = int(text)",
            "    if age < 0:",
            "        raise ValueError('age must not be negative')",
            "    return age",
        ],
        [
            "def parse_age(text):",
            "    age = int(text)",
            "    return age",
        ],
        2,
        "accepts negative ages",
    ),
}

NOUNS = ["order", "invoice", "customer", "product", "shipment", "coupon", "review", "cart"]
VERBS = ["format", "normalize", "summarize", "validate", "describe", "count", "label", "score"]


def filler_function(rng: random.Random, index: int) -> list[str]:
    """A small, correct helper so files look like real code."""
    noun, verb = rng.choice(NOUNS), rng.choice(VERBS)
    name = f"{verb}_{noun}_{index}"
    kind = rng.randrange(4)
    if kind == 0:
        return [
            f"def {name}(values):",
            f'    """Return the non-empty {noun} values, stripped."""',
            "    cleaned = []",
            "    for value in values:",
            "        value = value.strip()",
            "        if value:",
            "            cleaned.append(value)",
            "    return cleaned",
        ]
    if kind == 1:
        return [
            f"def {name}(amount, rate):",
            f'    """Scale a {noun} amount by a rate, rounded to cents."""',
            "    if rate < 0:",
            "        raise ValueError('rate must not be negative')",
            "    return round(amount * rate, 2)",
        ]
    if kind == 2:
        return [
            f"def {name}(record):",
            f'    """Build a display label for a {noun} record."""',
            "    title = record.get('title', '').strip() or 'untitled'",
            "    return f\"{title} (#{record.get('id', 0)})\"",
        ]
    return [
        f"def {name}(counts):",
        f'    """Total the {noun} counts, ignoring missing ones."""',
        "    return sum(count for count in counts if count is not None)",
    ]


def module(rng: random.Random, file_index: int, functions: int, bug: str | None) -> tuple[str, int | None]:
    """Return (source, line number of the planted bug or None)."""
    lines = [f'"""Storefront service module {file_index}."""', ""]
    bug_line = None
    bug_slot = functions // 2 if bug else -1
    for slot in range(functions):
        if slot == bug_slot and bug:
            _, buggy, offset, _ = BUGS[bug]
            bug_line = len(lines) + 1 + offset
            lines += buggy
        else:
            lines += filler_function(rng, file_index * 100 + slot)
        lines += ["", ""]
    return "\n".join(lines).rstrip() + "\n", bug_line


def git(repo: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True)


def build(name: str, file_count: int, functions: int, buggy_files: dict[int, str], seed: int) -> None:
    rng = random.Random(seed)
    repo = OUT / name
    subprocess.run(["rm", "-rf", str(repo)], check=True)
    (repo / "services").mkdir(parents=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "eval@example.com")
    git(repo, "config", "user.name", "eval")
    (repo / "README.md").write_text("# Storefront\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "Initial commit")
    git(repo, "checkout", "-q", "-b", "pr")

    bugs = []
    for i in range(1, file_count + 1):
        source, bug_line = module(rng, i, functions, buggy_files.get(i))
        path = f"services/module_{i:02d}.py"
        (repo / path).write_text(source)
        if bug_line is not None:
            bug = buggy_files[i]
            bugs.append({"file": path, "line": bug_line, "bug": bug, "what": BUGS[bug][3]})
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "Add storefront service modules")

    meta = {"title": "Add storefront service modules", "body": DESCRIPTION, "bugs": bugs}
    (OUT / f"{name}.json").write_text(json.dumps(meta, indent=2))
    chars = sum(len((repo / f"services/module_{i:02d}.py").read_text()) for i in range(1, file_count + 1))
    print(f"{name}: {file_count} files, ~{chars // 4:,} tokens of code, {len(bugs)} bugs")


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    build("small", 2, 4, {1: "apply_discount", 2: "paginate"}, seed=1)
    build("medium", 15, 14, {2: "paginate", 8: "apply_discount", 14: "parse_age"}, seed=2)
    build("huge", 60, 14, {7: "paginate", 31: "apply_discount", 55: "parse_age"}, seed=3)
