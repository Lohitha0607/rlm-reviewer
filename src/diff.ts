// Read a pull request's changes from git and parse the unified diff.

import type { ChangedFile } from "./types";

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Split a unified diff into one patch per file and find the changed new-file lines. */
export function parseUnifiedDiff(diff: string): Omit<ChangedFile, "content">[] {
  const files: Omit<ChangedFile, "content">[] = [];
  const sections = diff.split(/^diff --git /m).filter((s) => s.trim());

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0] ?? "";
    const newPath = lines.find((l) => l.startsWith("+++ "))?.slice(4);
    const oldPath = lines.find((l) => l.startsWith("--- "))?.slice(4);

    let status: ChangedFile["status"] = "modified";
    if (lines.some((l) => l.startsWith("new file mode"))) status = "added";
    else if (lines.some((l) => l.startsWith("deleted file mode"))) status = "deleted";
    else if (lines.some((l) => l.startsWith("rename to "))) status = "renamed";

    // "a/x b/x" in the header is the fallback for files without ---/+++ (binary, pure renames).
    const headerPath = header.split(" b/").pop() ?? header;
    const path =
      status === "deleted"
        ? stripPrefix(oldPath ?? headerPath)
        : stripPrefix(newPath ?? headerPath);

    const changedLines: number[] = [];
    let newLine = 0;
    let inHunk = false;
    for (const line of lines) {
      const hunk = HUNK_HEADER.exec(line);
      if (hunk) {
        newLine = Number(hunk[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk || line.startsWith("\\")) continue; // "\ No newline at end of file"
      if (line.startsWith("+")) {
        changedLines.push(newLine);
        newLine += 1;
      } else if (line.startsWith(" ") || line === "") {
        // A blank context line is " ", but tools that strip trailing spaces leave "".
        newLine += 1;
      }
      // "-" lines exist only in the old file: they do not move the new-file counter.
    }

    files.push({ path, status, patch: "diff --git " + section, changedLines });
  }
  return files;
}

function stripPrefix(path: string): string {
  return path.replace(/^[ab]\//, "").trim();
}

async function git(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/** The pull request's changed files: diff of `head` against its merge base with `base`. */
export async function readChangedFiles(
  repo: string,
  base: string,
  head = "HEAD",
): Promise<ChangedFile[]> {
  const diff = await git(repo, ["diff", "--unified=3", "--no-color", `${base}...${head}`]);
  const parsed = parseUnifiedDiff(diff);
  return Promise.all(
    parsed.map(async (file) => ({
      ...file,
      content:
        file.status === "deleted"
          ? null
          : await git(repo, ["show", `${head}:${file.path}`]).catch(() => null),
    })),
  );
}

/** Commit messages on the branch, oldest first. */
export async function readCommitMessages(
  repo: string,
  base: string,
  head = "HEAD",
): Promise<string[]> {
  const log = await git(repo, ["log", "--reverse", "--format=%s%n%b%x00", `${base}..${head}`]);
  return log
    .split("\0")
    .map((m) => m.trim())
    .filter(Boolean);
}
