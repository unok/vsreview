import { comparisonKey } from './comparisons';
import { isPullRequestReview, isPullRequestComparisonFor, type PullRequestReview } from './pullRequests';
import { hasStrings, isRecord, isRevision, isRepoPath, isOptionalRepoPath } from './validation';
import { isStatus, type Status } from './gitParsing';
export interface ReviewComment {
  pullRequest?: PullRequestReview;
  id: string;
  repoRoot: string;
  commit: string;
  parent: string;
  path: string;
  oldPath?: string;
  status: Status;
  side: 'old' | 'new' | 'file';
  startLine: number;
  endLine: number;
  code: string;
  hunkHeader: string;
  excerpt: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  resolved: boolean;
  subject: string;
  author: string;
  date: string;
}
interface SavedComments {
  version: 1;
  comments: ReviewComment[];
}
export function serialize(comments: readonly ReviewComment[]): SavedComments {
  return { version: 1, comments: [...comments] };
}
function hasValidLines(value: Record<string, unknown>): boolean {
  const minimum = value.side === 'file' ? 0 : 1;
  return (
    typeof value.startLine === 'number' &&
    Number.isInteger(value.startLine) &&
    value.startLine >= minimum &&
    (value.side !== 'file' || value.startLine === 0) &&
    typeof value.endLine === 'number' &&
    Number.isInteger(value.endLine) &&
    value.endLine >= value.startLine &&
    (value.side !== 'file' || value.endLine === 0)
  );
}
export function isReviewComment(value: unknown): value is ReviewComment {
  if (!isRecord(value)) {
    return false;
  }
  const strings = [
    'id',
    'repoRoot',
    'commit',
    'parent',
    'path',
    'code',
    'hunkHeader',
    'excerpt',
    'body',
    'createdAt',
    'updatedAt',
    'subject',
    'author',
    'date',
  ];
  const validSide = value.side === 'old' || value.side === 'new' || value.side === 'file';
  return (
    hasStrings(value, strings) &&
    (value.pullRequest === undefined || isPullRequestReview(value.pullRequest)) &&
    isPullRequestComparisonFor(value.pullRequest, value.commit, value.parent) &&
    isOptionalRepoPath(value.oldPath) &&
    isRevision(value.commit) &&
    isRevision(value.parent) &&
    isRepoPath(value.path) &&
    validSide &&
    isStatus(value.status) &&
    hasValidLines(value) &&
    typeof value.resolved === 'boolean'
  );
}
export function deserialize(value: unknown): ReviewComment[] {
  if (value === undefined) {
    return [];
  }
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !Array.isArray(value.comments) ||
    !value.comments.every(isReviewComment)
  ) {
    throw new Error('保存されたレビューコメントの形式が不正です。保存内容を保護するため読み込みを中止しました');
  }
  return value.comments;
}

export function selectComments(
  comments: readonly ReviewComment[],
  filter: {
    commit?: string;
    repoRoot?: string;
    path?: string;
    side?: ReviewComment['side'];
    unresolvedOnly?: boolean;
    pullRequestNumber?: number;
  },
): ReviewComment[] {
  return comments.filter(
    (comment) =>
      (filter.pullRequestNumber === undefined || comment.pullRequest?.number === filter.pullRequestNumber) &&
      (!filter.path || comment.path === filter.path) &&
      (!filter.side || comment.side === filter.side) &&
      (!filter.repoRoot || comment.repoRoot === filter.repoRoot) &&
      (!filter.commit || comment.commit === filter.commit) &&
      (!filter.unresolvedOnly || !comment.resolved),
  );
}

export function commentCounts(comments: readonly ReviewComment[]): Map<string, Map<string, number>> {
  const counts = new Map<string, Map<string, number>>();
  for (const comment of comments) {
    const key = comparisonKey(comment);
    const paths = counts.get(key) ?? new Map<string, number>();
    paths.set(comment.path, (paths.get(comment.path) ?? 0) + 1);
    counts.set(key, paths);
  }
  return counts;
}
