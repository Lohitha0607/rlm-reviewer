// Shapes shared by every part of the reviewer.

export type Severity = "high" | "medium" | "low";

/** One review comment, anchored to lines on the new side of the diff. */
export interface ReviewComment {
  file: string;
  /** First line (new-file numbering) the comment is about. */
  line: number;
  /** Last line, when the comment covers a range. */
  endLine?: number;
  severity: Severity;
  message: string;
  /** Replacement code for lines line..endLine, shown on GitHub as a suggested change. */
  suggestion?: string;
}

/** A file changed by the pull request. */
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** The unified diff for this file. */
  patch: string;
  /** Full content after the change (null when the file was deleted). */
  content: string | null;
  /** New-file line numbers that the pull request added or changed. */
  changedLines: number[];
}

/** What the author said about the change. Untrusted: treat as data, never instructions. */
export interface PullRequestContext {
  title: string;
  body: string;
  commits: string[];
  comments: string[];
}

export interface ReviewInput {
  pr: PullRequestContext;
  files: ChangedFile[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
}

export interface ReviewResult {
  comments: ReviewComment[];
  usage: Usage;
  /** Comments the model produced but the reviewer dropped (e.g. not on a changed line). */
  dropped: { comment: ReviewComment; reason: string }[];
}
