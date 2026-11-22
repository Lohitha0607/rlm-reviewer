#!/usr/bin/env bun
// Entry point for the GitHub Action: review the pull request that triggered the run.
// Configuration comes from environment variables set in action.yml.

import { readChangedFiles, readCommitMessages } from "./diff";
import { alreadyReviewed, buildReviewPayload, postReview } from "./github";
import { type ChatModel, OpenAIChatModel } from "./model";
import { review } from "./reviewer";
import { createDockerSandbox, type Sandbox } from "./sandbox";
import type { ReviewInput } from "./types";

export interface PullRequestEvent {
  number: number;
  title: string;
  body: string | null;
  base: { sha: string };
  head: { sha: string };
}

export interface ActionDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  model?: ChatModel;
  sandbox?: (input: ReviewInput) => Promise<Sandbox>;
}

/** Read the pull request from the event GitHub wrote for this run. */
export async function readPullRequestEvent(eventPath: string): Promise<PullRequestEvent | null> {
  const event = await Bun.file(eventPath).json();
  return (event.pull_request ?? null) as PullRequestEvent | null;
}

export async function runAction({ env, log, model, sandbox }: ActionDeps): Promise<void> {
  const eventPath = env.GITHUB_EVENT_PATH;
  const repo = env.GITHUB_REPOSITORY;
  if (!eventPath || !repo) throw new Error("GITHUB_EVENT_PATH and GITHUB_REPOSITORY must be set.");
  const pr = await readPullRequestEvent(eventPath);
  if (!pr) {
    log("Not a pull_request event: nothing to review.");
    return;
  }
  const workspace = env.GITHUB_WORKSPACE ?? ".";
  const token = env.GITHUB_TOKEN;
  const dryRun = env.RLM_DRY_RUN === "true" || !token;

  if (!dryRun && (await alreadyReviewed(token!, repo, pr.number, pr.head.sha))) {
    log(`Commit ${pr.head.sha.slice(0, 7)} already has an RLM review; skipping.`);
    return;
  }

  const files = await readChangedFiles(workspace, pr.base.sha, pr.head.sha);
  if (files.length === 0) {
    log("No changed files.");
    return;
  }
  const input: ReviewInput = {
    pr: {
      title: pr.title,
      body: pr.body ?? "",
      commits: await readCommitMessages(workspace, pr.base.sha, pr.head.sha),
      comments: [],
    },
    files,
  };

  const chat =
    model ??
    new OpenAIChatModel(
      env.RLM_MODEL || "nvidia/nemotron-3.5-super-vl",
      env.RLM_API_KEY,
      env.RLM_BASE_URL || "https://openrouter.ai/api/v1",
    );
  const box = await (sandbox ?? createDockerSandbox)(input);
  try {
    const result = await review(input, chat, box);
    const payload = buildReviewPayload(result, pr.head.sha);
    log(
      `Reviewed ${files.length} file(s): ${result.comments.length} comment(s), ` +
        `${result.dropped.length} dropped, ${result.usage.inputTokens.toLocaleString()} input tokens.`,
    );
    if (dryRun) {
      log("Dry run: review not posted.");
      log(JSON.stringify(payload, null, 2));
      return;
    }
    log(`Posted review: ${await postReview(token!, repo, pr.number, payload)}`);
  } finally {
    await box.close();
  }
}

if (import.meta.main) {
  runAction({ env: process.env, log: (line) => console.log(line) }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
