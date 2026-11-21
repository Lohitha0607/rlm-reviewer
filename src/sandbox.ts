// Run model-written Python in an isolated box where the pull request is loaded as variables.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewInput } from "./types";

const IMAGE = "python:3.12-slim";
const TIMEOUT_MS = 60_000;
export const OUTPUT_LIMIT = 10_000;

// Loaded before every cell. Only these variables exist between calls.
const PRELUDE = `
import json as _json
with open("/data/review.json") as _f:
    _data = _json.load(_f)
pr = _data["pr"]                                        # title, body, commits, comments (untrusted)
files = {f["path"]: f["content"] for f in _data["files"]}  # full new content, None if deleted
patches = {f["path"]: f["patch"] for f in _data["files"]}  # unified diff per file
changed_lines = {f["path"]: f["changedLines"] for f in _data["files"]}
diff = "\\n".join(patches.values())
`;

export interface Sandbox {
  run(code: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * A Docker box: no network, read-only data, memory and time limits. Model code never
 * runs on the host.
 */
export async function createDockerSandbox(input: ReviewInput): Promise<Sandbox> {
  await ensureImage();
  const dir = await mkdtemp(join(tmpdir(), "rlm-review-"));
  await writeFile(join(dir, "review.json"), JSON.stringify(input));
  let cell = 0;

  return {
    async run(code: string): Promise<string> {
      cell += 1;
      const cellName = `cell_${cell}.py`;
      await writeFile(join(dir, cellName), PRELUDE + "\n" + code);
      const proc = Bun.spawn(
        [
          "docker", "run", "--rm", "-i", "--pull", "never",
          "--network", "none",
          "--memory", "512m",
          "--cpus", "1",
          "--read-only",
          "--tmpfs", "/tmp:size=64m",
          "-v", `${dir}:/data:ro`,
          IMAGE,
          "python3", `/data/${cellName}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
      const [stdout, stderr, code_] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      const output = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trim();
      const note = code_ !== 0 ? `\n[exit code ${code_}]` : "";
      return truncate(output || "(no output)", OUTPUT_LIMIT) + note;
    },
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Pull the image once up front, so download messages never reach the model. */
async function ensureImage(): Promise<void> {
  const inspect = Bun.spawn(["docker", "image", "inspect", IMAGE], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await inspect.exited) === 0) return;
  const pull = Bun.spawn(["docker", "pull", "--quiet", IMAGE], { stdout: "ignore", stderr: "pipe" });
  if ((await pull.exited) !== 0) {
    throw new Error(`Could not pull ${IMAGE}: ${await new Response(pull.stderr).text()}`);
  }
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n[output truncated at ${limit} characters: print less]`;
}
