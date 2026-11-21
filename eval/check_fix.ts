// Apply a suggested fix to a file and run a test for the planted bug in a Docker box.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewComment } from "../src/types";

// One test per planted bug. Each prints PASS only when the bug is gone and the
// function still works.
const BUG_TESTS: Record<string, string> = {
  paginate: `
items = list(range(10))
assert len(m.paginate(items, 0, 3)) == 3
assert m.paginate(items, 1, 3) == [3, 4, 5]
print("PASS")`,
  apply_discount: `
assert m.apply_discount(100) == 90.0
assert m.apply_discount(99) == 99
assert m.apply_discount(200) == 180.0
print("PASS")`,
  parse_age: `
try:
    m.parse_age("-1")
    raise SystemExit("negative age accepted")
except ValueError:
    pass
assert m.parse_age("30") == 30
print("PASS")`,
};

/** The file with lines line..endLine replaced by the suggestion. */
export function applySuggestion(content: string, comment: ReviewComment): string {
  const lines = content.split("\n");
  const start = comment.line - 1;
  const end = (comment.endLine ?? comment.line) - 1;
  const replacement = (comment.suggestion ?? "").replace(/\n+$/, "").split("\n");
  return [...lines.slice(0, start), ...replacement, ...lines.slice(end + 1)].join("\n");
}

/** True when the patched module passes the planted bug's test. */
export async function fixWorks(content: string, comment: ReviewComment, bug: string): Promise<boolean> {
  const test = BUG_TESTS[bug];
  if (!test || comment.suggestion === undefined) return false;
  const dir = await mkdtemp(join(tmpdir(), "rlm-fix-"));
  try {
    await writeFile(join(dir, "module_under_test.py"), applySuggestion(content, comment));
    await writeFile(join(dir, "check.py"), `import importlib.util, sys
spec = importlib.util.spec_from_file_location("m", "/data/module_under_test.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
${test}
`);
    const proc = Bun.spawn(
      ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--memory", "256m",
       "--read-only", "-v", `${dir}:/data:ro`, "python:3.12-slim", "python3", "/data/check.py"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 30_000);
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    return output.trim().endsWith("PASS");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
