import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import { runAction } from "../src/action";
import { buildReviewPayload, commentBody, reviewMarker } from "../src/github";
import type { ChatModel, Message } from "../src/model";
import type { Sandbox } from "../src/sandbox";
import type { ReviewResult } from "../src/types";

describe("GitHub review payload", () => {
  const result: ReviewResult = {
    comments: [
      { file: "shop/refunds.py", line: 7, severity: "high", message: "Use > for 'over $500'.", suggestion: "    return order.amount > REFUND_THRESHOLD\n" },
      { file: "shop/cart.py", line: 5, endLine: 6, severity: "medium", message: "Empty cart divides by zero." },
    ],
    dropped: [],
    usage: { inputTokens: 0, outputTokens: 0, modelCalls: 0 },
  };

  test("one comment per finding, on the right lines, with suggestion blocks", () => {
    const payload = buildReviewPayload(result, "abc123");
    expect(payload.commit_id).toBe("abc123");
    expect(payload.event).toBe("COMMENT");
    expect(payload.comments[0]).toEqual({
      path: "shop/refunds.py",
      line: 7,
      side: "RIGHT",
      body: "**high**: Use > for 'over $500'.\n\n```suggestion\n    return order.amount > REFUND_THRESHOLD\n```",
    });
    // A range uses start_line + line (the last line).
    expect(payload.comments[1]).toMatchObject({ path: "shop/cart.py", start_line: 5, line: 6, start_side: "RIGHT" });
    expect(payload.body).toContain("2 comment(s), 1 high severity");
    expect(payload.body).toContain(reviewMarker("abc123"));
  });

  test("a comment without a fix has no suggestion block", () => {
    expect(commentBody(result.comments[1]!)).not.toContain("```suggestion");
  });
});

class ScriptedModel implements ChatModel {
  usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  constructor(private replies: ChatCompletionMessage[]) {}
  async complete(_messages: Message[]) {
    this.usage.modelCalls += 1;
    return this.replies.shift()!;
  }
}

const noBox: Sandbox = { run: async () => "", close: async () => {} };

async function git(repo: string, ...args: string[]) {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out.trim();
}

describe("action dry run", () => {
  test("reads the pull_request event, reviews the diff, and prints the review instead of posting", async () => {
    // A tiny repo with a PR that adds a file.
    const repo = await mkdtemp(join(tmpdir(), "rlm-action-"));
    await git(repo, "init", "-q", "-b", "main");
    await git(repo, "config", "user.email", "t@example.com");
    await git(repo, "config", "user.name", "t");
    await writeFile(join(repo, "a.py"), "x = 1\n");
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "base");
    const base = await git(repo, "rev-parse", "HEAD");
    await writeFile(join(repo, "a.py"), "x = 1\ny = 1 / 0\n");
    await git(repo, "commit", "-q", "-am", "add y");
    const head = await git(repo, "rev-parse", "HEAD");

    const eventPath = join(repo, "event.json");
    await writeFile(eventPath, JSON.stringify({
      pull_request: { number: 7, title: "Add y", body: null, base: { sha: base }, head: { sha: head } },
    }));

    const finish: ChatCompletionMessage = {
      role: "assistant", content: null, refusal: null,
      tool_calls: [{ id: "1", type: "function", function: { name: "finish", arguments: JSON.stringify({
        comments: [{ file: "a.py", line: 2, severity: "high", message: "Division by zero.", suggestion: "y = 0" }],
      }) } }],
    };
    const logs: string[] = [];
    await runAction({
      env: { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "me/repo", GITHUB_WORKSPACE: repo },
      log: (line) => logs.push(line),
      model: new ScriptedModel([finish]),
      sandbox: async () => noBox,
    });

    const output = logs.join("\n");
    expect(output).toContain("Reviewed 1 file(s): 1 comment(s)");
    expect(output).toContain("Dry run: review not posted.");
    expect(output).toContain(`"commit_id": "${head}"`);
    expect(output).toContain("```suggestion\\ny = 0\\n```");
  });

  test("skips events that are not pull requests, without failing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rlm-action-"));
    const eventPath = join(dir, "event.json");
    await writeFile(eventPath, JSON.stringify({ push: {} }));
    const logs: string[] = [];
    await runAction({ env: { GITHUB_EVENT_PATH: eventPath, GITHUB_REPOSITORY: "me/repo" }, log: (l) => logs.push(l) });
    expect(logs).toEqual(["Not a pull_request event: nothing to review."]);
  });
});
