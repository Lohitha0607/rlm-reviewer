import { describe, expect, test } from "bun:test";
import type { ChatCompletionMessage } from "openai/resources/chat/completions";
import { parseUnifiedDiff } from "../src/diff";
import type { ChatModel, Message } from "../src/model";
import { parseJsonArray, review, validateComments } from "../src/reviewer";
import { createDockerSandbox, type Sandbox } from "../src/sandbox";
import type { ChangedFile, ReviewInput } from "../src/types";

const DIFF = `diff --git a/src/billing.py b/src/billing.py
index 1111111..2222222 100644
--- a/src/billing.py
+++ b/src/billing.py
@@ -1,4 +1,6 @@
 def average(prices):
-    return sum(prices) / 2
+    total = sum(prices)
+    return total / len(prices)

 def refund(order):
+    if order.amount >= 500:
+        return True
diff --git a/README.md b/README.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/README.md
@@ -0,0 +1,2 @@
+# Shop
+Refunds for orders over $500.
`;

const FILES: ChangedFile[] = parseUnifiedDiff(DIFF).map((f) => ({
  ...f,
  content:
    f.path === "src/billing.py"
      ? "def average(prices):\n    total = sum(prices)\n    return total / len(prices)\n\ndef refund(order):\n    if order.amount >= 500:\n        return True\n"
      : "# Shop\nRefunds for orders over $500.\n",
}));

const INPUT: ReviewInput = {
  pr: {
    title: "Add refunds for orders over $500",
    body: "Refunds only for orders strictly over $500.",
    commits: ["Add refunds"],
    comments: [],
  },
  files: FILES,
};

describe("parseUnifiedDiff", () => {
  test("finds files, status and the changed new-file lines", () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/billing.py", "modified"],
      ["README.md", "added"],
    ]);
    // Removed lines do not count; added lines use new-file numbering.
    expect(files[0]!.changedLines).toEqual([2, 3, 6, 7]);
    expect(files[1]!.changedLines).toEqual([1, 2]);
  });

  test("a deleted file keeps its old path", () => {
    const files = parseUnifiedDiff(
      "diff --git a/old.py b/old.py\ndeleted file mode 100644\n--- a/old.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-x = 1\n",
    );
    expect(files[0]).toMatchObject({ path: "old.py", status: "deleted", changedLines: [] });
  });
});

describe("parseJsonArray", () => {
  test("tolerates code fences and prose", () => {
    expect(parseJsonArray('Here:\n```json\n[{"line": 3}]\n```')).toEqual([{ line: 3 }]);
    expect(parseJsonArray("nothing found")).toEqual([]);
    expect(parseJsonArray("[not json")).toEqual([]);
  });
});

describe("validateComments", () => {
  test("keeps valid comments and drops ones GitHub cannot place", () => {
    const { comments, dropped } = validateComments(
      [
        { file: "src/billing.py", line: 6, severity: "high", message: "Use > 500, not >= 500.", suggestion: "    if order.amount > 500:" },
        { file: "src/billing.py", line: 1, severity: "low", message: "Unchanged line." },
        { file: "nope.py", line: 1, severity: "low", message: "Unknown file." },
        { file: "src/billing.py", line: 6, severity: "high", message: "use > 500, NOT >= 500." },
      ],
      FILES,
      10,
    );
    expect(comments).toEqual([
      { file: "src/billing.py", line: 6, severity: "high", message: "Use > 500, not >= 500.", suggestion: "    if order.amount > 500:" },
    ]);
    expect(dropped.map((d) => d.reason)).toEqual([
      "line is not a changed line",
      "file is not part of the pull request",
    ]);
  });

  test("drops an oversized suggestion but keeps the comment", () => {
    const { comments } = validateComments(
      [{ file: "src/billing.py", line: 2, endLine: 7, severity: "medium", message: "Rewrite.", suggestion: "x" }],
      FILES,
      3,
    );
    expect(comments[0]).not.toHaveProperty("suggestion");
  });

  test("unknown severity becomes medium", () => {
    const { comments } = validateComments(
      [{ file: "README.md", line: 2, severity: "critical", message: "Check wording." }],
      FILES,
      10,
    );
    expect(comments[0]!.severity).toBe("medium");
  });
});

/** Replays scripted replies; records what it was sent. */
class FakeModel implements ChatModel {
  usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  sent: Message[][] = [];
  constructor(private replies: ChatCompletionMessage[]) {}
  async complete(messages: Message[]) {
    this.sent.push(structuredClone(messages));
    this.usage.modelCalls += 1;
    const reply = this.replies.shift();
    if (!reply) throw new Error("FakeModel ran out of replies");
    return reply;
  }
}

function toolCall(id: string, name: string, args: unknown): ChatCompletionMessage {
  return {
    role: "assistant",
    content: null,
    refusal: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

function text(content: string): ChatCompletionMessage {
  return { role: "assistant", content, refusal: null };
}

class FakeSandbox implements Sandbox {
  ran: string[] = [];
  async run(code: string) {
    this.ran.push(code);
    return "['src/billing.py', 'README.md']";
  }
  async close() {}
}

describe("review loop", () => {
  test("explores with python, delegates a file, and hands in validated comments", async () => {
    const model = new FakeModel([
      toolCall("1", "python", { code: "print(list(files))" }),
      toolCall("2", "sub_review", { path: "src/billing.py", focus: "refund threshold" }),
      // The helper's reply (a plain completion, no tools).
      text('[{"file": "src/billing.py", "line": 6, "severity": "high", "message": "Description says over $500 but code uses >= 500.", "suggestion": "    if order.amount > 500:"}]'),
      toolCall("3", "finish", {
        comments: [
          { file: "src/billing.py", line: 6, severity: "high", message: "Description says over $500 but code uses >= 500.", suggestion: "    if order.amount > 500:" },
          { file: "src/billing.py", line: 99, severity: "low", message: "Hallucinated line." },
        ],
      }),
    ]);
    const sandbox = new FakeSandbox();

    const result = await review(INPUT, model, sandbox);

    expect(sandbox.ran).toEqual(["print(list(files))"]);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({ file: "src/billing.py", line: 6, severity: "high" });
    expect(result.dropped).toHaveLength(1);
    expect(result.usage.modelCalls).toBe(4);
  });

  test("the root never receives the diff text itself, and author text is fenced as untrusted", async () => {
    const model = new FakeModel([toolCall("1", "finish", { comments: [] })]);
    await review(INPUT, model, new FakeSandbox());
    const firstRequest = JSON.stringify(model.sent[0]);
    expect(firstRequest).not.toContain("return total / len(prices)");
    expect(firstRequest).toContain("<untrusted_pull_request_text>");
  });

  test("the helper sees the file with line numbers", async () => {
    const model = new FakeModel([
      toolCall("1", "sub_review", { path: "src/billing.py", focus: "bugs" }),
      text("[]"),
      toolCall("2", "finish", { comments: [] }),
    ]);
    await review(INPUT, model, new FakeSandbox());
    const helperPrompt = JSON.stringify(model.sent[1]);
    expect(helperPrompt).toContain("Changed lines: 2, 3, 6, 7");
    expect(helperPrompt).toContain("6      if order.amount >= 500:");
  });

  test("stops at the turn limit with no comments", async () => {
    const model = new FakeModel(Array.from({ length: 3 }, () => text("thinking...")));
    const result = await review(INPUT, model, new FakeSandbox(), { maxTurns: 3 });
    expect(result.comments).toEqual([]);
  });
});

describe("docker sandbox (needs Docker)", () => {
  test("loads the pull request as variables, with no network", async () => {
    const sandbox = await createDockerSandbox(INPUT);
    try {
      expect(await sandbox.run("print(sorted(files))")).toBe("['README.md', 'src/billing.py']");
      expect(await sandbox.run("print(changed_lines['src/billing.py'])")).toBe("[2, 3, 6, 7]");
      const network = await sandbox.run(
        "import socket\ntry:\n    socket.create_connection(('1.1.1.1', 53), timeout=3)\n    print('online')\nexcept OSError:\n    print('offline')",
      );
      expect(network).toBe("offline");
    } finally {
      await sandbox.close();
    }
  }, 120_000);
});
