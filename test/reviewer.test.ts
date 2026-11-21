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

describe("baseline reviewer", () => {
  test("sends the whole diff in one prompt and validates the reply the same way", async () => {
    const { baselineReview } = await import("../src/baseline");
    const model = new FakeModel([
      text('[{"file": "src/billing.py", "line": 6, "severity": "high", "message": "Use > 500."}, {"file": "src/billing.py", "line": 1, "severity": "low", "message": "Unchanged."}]'),
    ]);
    const result = await baselineReview(INPUT, model);
    const request = JSON.stringify(model.sent[0]);
    expect(request).toContain("return total / len(prices)"); // the diff IS in the prompt
    expect(result.comments).toHaveLength(1);
    expect(result.dropped).toHaveLength(1);
    expect(result.usage.modelCalls).toBe(1);
  });
});

describe("eval scoring", () => {
  test("a comment within 3 lines of a bug finds it; others are false alarms", async () => {
    const { score } = await import("../eval/run_eval");
    const bugs = [
      { file: "a.py", line: 10, bug: "paginate", what: "" },
      { file: "b.py", line: 40, bug: "parse_age", what: "" },
    ];
    const result = score(
      [
        { file: "a.py", line: 12, severity: "high", message: "off by one" },
        { file: "b.py", line: 50, severity: "low", message: "far away" },
        { file: "c.py", line: 1, severity: "low", message: "noise" },
      ],
      bugs,
    );
    // b.py's comment is on the right file but 10 lines away: detected, not located.
    expect(result).toEqual({ detected: ["paginate", "parse_age"], found: ["paginate"], falseAlarms: 1 });
  });
});

describe("suggestion ranges", () => {
  test("a suggestion that rewrites the next line too is widened to cover it", async () => {
    const { coverRewrittenLines } = await import("../src/reviewer");
    const file: ChangedFile = {
      path: "shop/cart.py",
      status: "modified",
      patch: "",
      content: "def total(items):\n    return 0\n\n\ndef average(items):\n    return total(items) / len(items)\n",
      changedLines: [5, 6],
    };
    const widened = coverRewrittenLines(
      {
        file: "shop/cart.py", line: 5, severity: "medium", message: "empty cart",
        suggestion: "def average(items):\n    if not items:\n        return 0\n    return total(items) / len(items)",
      },
      file,
    );
    expect(widened.endLine).toBe(6);

    const untouched = coverRewrittenLines(
      { file: "shop/cart.py", line: 6, severity: "medium", message: "x", suggestion: "    return 0" },
      file,
    );
    expect(untouched.endLine).toBeUndefined();
  });
});

describe("fix checking", () => {
  test("applySuggestion replaces exactly lines line..endLine", async () => {
    const { applySuggestion } = await import("../eval/check_fix");
    const content = "a\nb\nc\nd";
    expect(applySuggestion(content, { file: "f", line: 2, endLine: 3, severity: "low", message: "", suggestion: "X\nY\nZ" }))
      .toBe("a\nX\nY\nZ\nd");
  });

  test("a correct fix passes the bug's test and a wrong one fails (needs Docker)", async () => {
    const { fixWorks } = await import("../eval/check_fix");
    const buggy = "def apply_discount(total):\n    if total > 100:\n        return round(total * 0.9, 2)\n    return total\n";
    const comment = { file: "f", line: 2, severity: "high" as const, message: "" };
    expect(await fixWorks(buggy, { ...comment, suggestion: "    if total >= 100:" }, "apply_discount")).toBe(true);
    expect(await fixWorks(buggy, { ...comment, suggestion: "    if total > 1000:" }, "apply_discount")).toBe(false);
  }, 60_000);
});

describe("suggestion indentation", () => {
  test("a suggestion that lost its indentation is re-indented to the original line", async () => {
    const { matchIndentation } = await import("../src/reviewer");
    const file: ChangedFile = {
      path: "m.py", status: "added", patch: "",
      content: "def apply_discount(total):\n    if total > 100:\n        return round(total * 0.9, 2)\n",
      changedLines: [1, 2, 3],
    };
    const fixed = matchIndentation(
      { file: "m.py", line: 2, severity: "high", message: "", suggestion: "if total >= 100:\n    return 1" },
      file,
    );
    expect(fixed.suggestion).toBe("    if total >= 100:\n        return 1");
    const already = matchIndentation(
      { file: "m.py", line: 2, severity: "high", message: "", suggestion: "    if total >= 100:" },
      file,
    );
    expect(already.suggestion).toBe("    if total >= 100:");
  });
});

describe("suggestion range, backwards", () => {
  test("a suggestion that also rewrites the line before is widened back, then indented from that line", async () => {
    const { validateComments } = await import("../src/reviewer");
    const file: ChangedFile = {
      path: "shop/cart.py", status: "modified", patch: "",
      content: "def total(items):\n    return 0\n\n\ndef average(items):\n    return total(items) / len(items)\n",
      changedLines: [5, 6],
    };
    const { comments } = validateComments(
      [{
        file: "shop/cart.py", line: 6, severity: "medium", message: "empty cart",
        suggestion: "def average(items):\n    if not items:\n        return 0\n    return total(items) / len(items)",
      }],
      [file],
      10,
    );
    expect(comments[0]).toMatchObject({ line: 5, endLine: 6 });
    expect(comments[0]!.suggestion!.startsWith("def average(items):")).toBe(true);
  });
});
