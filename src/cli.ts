#!/usr/bin/env bun
// rlm-review: review the current branch against a base branch.
//
//   bun src/cli.ts --repo <path> --base main [--head HEAD] [--title "..."] [--body "..."]
//                  [--model id] [--base-url url] [--api-key-env NAME] [--mode rlm|baseline] [--json]
//
// Any OpenAI-compatible server works, e.g. local Ollama:
//   --base-url http://localhost:11434/v1 --model qwen3:8b

import { parseArgs } from "node:util";
import { readChangedFiles, readCommitMessages } from "./diff";
import { baselineReview } from "./baseline";
import { OpenAIChatModel } from "./model";
import { review } from "./reviewer";
import { createDockerSandbox } from "./sandbox";
import type { ReviewInput, ReviewResult } from "./types";

const DEFAULT_MODEL = "nvidia/nemotron-3.5-super-vl:free";

function format(result: ReviewResult): string {
  const lines: string[] = [];
  if (result.comments.length === 0) lines.push("No issues found.");
  for (const c of result.comments) {
    const range = c.endLine && c.endLine !== c.line ? `${c.line}-${c.endLine}` : `${c.line}`;
    lines.push(`\n[${c.severity}] ${c.file}:${range}\n  ${c.message}`);
    if (c.suggestion) {
      lines.push("  suggested change:");
      lines.push(...c.suggestion.split("\n").map((l) => `    ${l}`));
    }
  }
  if (result.dropped.length) {
    lines.push(`\n(${result.dropped.length} comment(s) dropped: not on a changed line or invalid)`);
  }
  const u = result.usage;
  lines.push(
    `\nModel calls: ${u.modelCalls} · input tokens: ${u.inputTokens.toLocaleString()} · ` +
      `output tokens: ${u.outputTokens.toLocaleString()}`,
  );
  return lines.join("\n");
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: "." },
      base: { type: "string", default: "main" },
      head: { type: "string", default: "HEAD" },
      title: { type: "string", default: "" },
      body: { type: "string", default: "" },
      model: { type: "string", default: DEFAULT_MODEL },
      "base-url": { type: "string", default: "https://openrouter.ai/api/v1" },
      "api-key-env": { type: "string", default: "OPENROUTER_API_KEY" },
      mode: { type: "string", default: "rlm" },
      json: { type: "boolean", default: false },
    },
  });

  const files = await readChangedFiles(values.repo!, values.base!, values.head!);
  if (files.length === 0) {
    console.log("No changes between the base and head.");
    return;
  }
  const commits = await readCommitMessages(values.repo!, values.base!, values.head!);
  const input: ReviewInput = {
    pr: {
      title: values.title || commits[0]?.split("\n")[0] || "(untitled)",
      body: values.body!,
      commits,
      comments: [],
    },
    files,
  };

  if (values.mode !== "rlm" && values.mode !== "baseline") {
    throw new Error("--mode must be rlm or baseline");
  }
  const sandbox = await createDockerSandbox(input);
  try {
    const baseURL = values["base-url"]!;
    const isLocal = /localhost|127\.0\.0\.1/.test(baseURL);
    // Local servers such as Ollama accept any key.
    const apiKey = process.env[values["api-key-env"]!] ?? (isLocal ? "local" : undefined);
    const model = new OpenAIChatModel(values.model!, apiKey, baseURL);
    const result =
      values.mode === "baseline"
        ? await baselineReview(input, model)
        : await review(input, model, sandbox);
    console.log(values.json ? JSON.stringify(result, null, 2) : format(result));
  } finally {
    await sandbox.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
