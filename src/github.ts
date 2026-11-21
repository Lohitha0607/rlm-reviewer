// Post a review to a GitHub pull request: one review, comments on exact lines,
// fixes as suggested changes.

import type { ReviewComment, ReviewResult } from "./types";

const API = "https://api.github.com";

/** Marks our reviews so the same commit is never reviewed twice. */
export function reviewMarker(commitSha: string): string {
  return `<!-- rlm-reviewer:${commitSha} -->`;
}

export interface GitHubReviewComment {
  path: string;
  line: number;
  side: "RIGHT";
  start_line?: number;
  start_side?: "RIGHT";
  body: string;
}

export interface GitHubReviewPayload {
  commit_id: string;
  event: "COMMENT";
  body: string;
  comments: GitHubReviewComment[];
}

export function commentBody(comment: ReviewComment): string {
  const parts = [`**${comment.severity}**: ${comment.message}`];
  if (comment.suggestion !== undefined) {
    parts.push("```suggestion\n" + comment.suggestion.replace(/\n+$/, "") + "\n```");
  }
  return parts.join("\n\n");
}

export function buildReviewPayload(result: ReviewResult, commitSha: string): GitHubReviewPayload {
  const comments = result.comments.map((c): GitHubReviewComment => {
    const end = c.endLine ?? c.line;
    return {
      path: c.file,
      line: end,
      side: "RIGHT",
      ...(end !== c.line ? { start_line: c.line, start_side: "RIGHT" as const } : {}),
      body: commentBody(c),
    };
  });
  const high = result.comments.filter((c) => c.severity === "high").length;
  const summary =
    result.comments.length === 0
      ? "RLM review: no issues found."
      : `RLM review: ${result.comments.length} comment(s), ${high} high severity.`;
  return {
    commit_id: commitSha,
    event: "COMMENT",
    body: `${summary}\n\n${reviewMarker(commitSha)}`,
    comments,
  };
}

async function github<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

/** True when this commit already has a review from us. */
export async function alreadyReviewed(
  token: string,
  repo: string,
  pullNumber: number,
  commitSha: string,
): Promise<boolean> {
  const reviews = await github<{ body: string | null }[]>(
    token,
    `/repos/${repo}/pulls/${pullNumber}/reviews?per_page=100`,
  );
  return reviews.some((r) => r.body?.includes(reviewMarker(commitSha)));
}

export async function postReview(
  token: string,
  repo: string,
  pullNumber: number,
  payload: GitHubReviewPayload,
): Promise<string> {
  const review = await github<{ html_url: string }>(token, `/repos/${repo}/pulls/${pullNumber}/reviews`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return review.html_url;
}
