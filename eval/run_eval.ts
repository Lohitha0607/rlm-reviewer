// Run the RLM reviewer and the baseline on every eval PR and score them.
//
//   bun eval/run_eval.ts [--prs /tmp/rlm-eval-prs] [--model qwen3-32k]
//                        [--base-url http://localhost:11434/v1] [--only small,medium]
//
// A comment finds a bug when it is on the bug's file within 3 lines of it.
// Every other comment is a false alarm (the rest of the code is correct).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { baselineReview } from "../src/baseline";
import { fixWorks } from "./check_fix";
import { readChangedFiles } from "../src/diff";
import { OpenAIChatModel } from "../src/model";
import { review } from "../src/reviewer";
import { createDockerSandbox } from "../src/sandbox";
import type { ReviewComment, ReviewInput } from "../src/types";

interface Bug {
  file: string;
  line: number;
  bug: string;
  what: string;
}

const LINE_TOLERANCE = 3;

/**
 * detected: a comment on the bug's file (each eval file has at most one bug).
 * located:  that comment is within 3 lines of the bug, so GitHub shows it in the right place.
 * falseAlarms: comments on files without a bug (the rest of the code is correct).
 */
export function score(comments: ReviewComment[], bugs: Bug[]) {
  const located = (c: ReviewComment, b: Bug) =>
    c.file === b.file && Math.abs(c.line - b.line) <= LINE_TOLERANCE;
  const detected = bugs.filter((b) => comments.some((c) => c.file === b.file));
  const found = bugs.filter((b) => comments.some((c) => located(c, b)));
  const falseAlarms = comments.filter((c) => !bugs.some((b) => b.file === c.file));
  return {
    detected: detected.map((b) => b.bug),
    found: found.map((b) => b.bug),
    falseAlarms: falseAlarms.length,
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      prs: { type: "string", default: "/tmp/rlm-eval-prs" },
      model: { type: "string", default: "qwen3-32k" },
      "base-url": { type: "string", default: "http://localhost:11434/v1" },
      "api-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
      only: { type: "string", default: "small,medium,huge" },
      modes: { type: "string", default: "baseline,rlm" },
    },
  });
  const isLocal = /localhost|127\.0\.0\.1/.test(values["base-url"]!);
  const apiKey = process.env[values["api-key-env"]!] ?? (isLocal ? "local" : undefined);
  const results = [];

  for (const name of values.only!.split(",")) {
    const meta = await Bun.file(join(values.prs!, `${name}.json`)).json();
    const files = await readChangedFiles(join(values.prs!, name), "main", "pr");
    const input: ReviewInput = {
      pr: { title: meta.title, body: meta.body, commits: [], comments: [] },
      files,
    };

    for (const mode of values.modes!.split(",")) {
      const model = new OpenAIChatModel(values.model!, apiKey, values["base-url"]!);
      const started = Date.now();
      let row: Record<string, unknown>;
      try {
        const sandbox = await createDockerSandbox(input);
        try {
          const result =
            mode === "baseline" ? await baselineReview(input, model) : await review(input, model, sandbox);
          const s = score(result.comments, meta.bugs);
          // A fix counts when a suggestion covers the bug's line and passes its test.
          let fixesWorking = 0;
          let fixesTried = 0;
          for (const bug of meta.bugs as Bug[]) {
            const content = files.find((f) => f.path === bug.file)?.content ?? "";
            const fix = result.comments.find(
              (c) => c.file === bug.file && c.suggestion !== undefined &&
                c.line <= bug.line && bug.line <= (c.endLine ?? c.line),
            );
            if (!fix) continue;
            fixesTried += 1;
            if (await fixWorks(content, fix, bug.bug)) fixesWorking += 1;
          }
          row = {
            pr: name,
            mode,
            bugs: meta.bugs.length,
            detected: s.detected.length,
            found: s.found.length,
            foundBugs: s.found,
            falseAlarms: s.falseAlarms,
            comments: result.comments.length,
            dropped: result.dropped.length,
            ...result.usage,
            withSuggestion: result.comments.filter((c) => c.suggestion).length,
            fixesTried,
            fixesWorking,
            review: result.comments,
          };
        } finally {
          await sandbox.close();
        }
      } catch (error) {
        row = { pr: name, mode, error: error instanceof Error ? error.message : String(error) };
      }
      row.seconds = Math.round((Date.now() - started) / 1000);
      results.push(row);
      console.log(
        `${name.padEnd(6)} ${mode.padEnd(8)} ` +
          (row.error
            ? `ERROR ${row.error}`
            : `detected ${row.detected}/${row.bugs} · located ${row.found}/${row.bugs} · ` +
              `fixes working ${row.fixesWorking}/${row.bugs} · false alarms ${row.falseAlarms} · ` +
              `input tokens ${Number(row.inputTokens).toLocaleString()} · calls ${row.modelCalls} · ${row.seconds}s`),
      );
    }
  }

  await mkdir("eval/results", { recursive: true });
  const out = `eval/results/${new Date().toISOString().replace(/[:.]/g, "-")}-${values.model!.replace(/[/:]/g, "_")}.json`;
  await writeFile(out, JSON.stringify({ model: values.model, results }, null, 2));
  console.log(`\nSaved ${out}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
