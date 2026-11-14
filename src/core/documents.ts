import { isPullRequestComparisonFor, pullRequestComparison, type PullRequestComparison } from './pullRequests';
import { fileSide, type FileSide, isCommit, isChangedFile, type ChangedFile, type Commit } from './gitParsing';
import type { ReviewComment } from './model';
import { isRecord, isRevision, isRepoPath } from './validation';
export interface CommitTarget {
  pullRequest?: PullRequestComparison;
  repo: string;
  commit: Commit;
  parent: string;
}
export interface FileTarget extends CommitTarget {
  file: ChangedFile;
}
export interface DocumentRef extends FileTarget {
  rev: string;
  path: string;
  side: FileSide;
  empty: boolean;
}
export function isFileTarget(value: unknown): value is FileTarget {
  return (
    isRecord(value) &&
    isCommit(value.commit) &&
    isPullRequestComparisonFor(value.pullRequest, value.commit.hash, value.parent) &&
    typeof value.repo === 'string' &&
    isRevision(value.parent) &&
    isChangedFile(value.file)
  );
}
export function isDocumentRef(value: unknown): value is DocumentRef {
  if (!isFileTarget(value) || !isRecord(value)) {
    return false;
  }
  return (
    isRevision(value.rev) &&
    isRepoPath(value.path) &&
    typeof value.empty === 'boolean' &&
    (value.side === 'old' || value.side === 'new') &&
    value.rev === sideRevision(value, value.side) &&
    value.path === fileSide(value.file, value.side).path &&
    value.empty === fileSide(value.file, value.side).empty
  );
}
export function sideRevision(target: CommitTarget, side: FileSide): string {
  return side === 'old' ? target.parent : target.commit.hash;
}
export function revisionRef(target: FileTarget, side: FileSide): DocumentRef {
  return {
    repo: target.repo,
    ...(target.pullRequest ? { pullRequest: pullRequestComparison(target.pullRequest) } : {}),
    parent: target.parent,
    // ツリーから開く場合と保存コメントから復元する場合で同じ URI を生成するため、表示に不要な本文・親一覧を正規化する。
    commit: canonicalCommit(target.commit, target.parent, target.pullRequest?.number),
    file: {
      status: target.file.status,
      path: target.file.path,
      ...(target.file.oldPath === undefined ? {} : { oldPath: target.file.oldPath }),
    },
    side,
    rev: sideRevision(target, side),
    ...fileSide(target.file, side),
  };
}

export function targetFromComment(comment: ReviewComment): FileTarget {
  return {
    repo: comment.repoRoot,
    ...(comment.pullRequest ? { pullRequest: pullRequestComparison(comment.pullRequest) } : {}),
    parent: comment.parent,
    commit: canonicalCommit(
      { hash: comment.commit, subject: comment.subject, author: comment.author, date: comment.date },
      comment.parent,
      comment.pullRequest?.number,
    ),
    file: {
      status: comment.status,
      path: comment.path,
      ...(comment.oldPath === undefined ? {} : { oldPath: comment.oldPath }),
    },
  };
}

// ツリーと保存コメントで同じ URI を作り、既存の差分表示・Files・ナビゲーションを共有する。
export function canonicalCommit(
  commit: Pick<Commit, 'hash' | 'subject' | 'author' | 'date'>,
  parent: string,
  pullRequestNumber?: number,
): Commit {
  return {
    hash: commit.hash,
    parents: [parent],
    subject: pullRequestNumber ? `PR #${pullRequestNumber}` : commit.subject,
    author: pullRequestNumber ? '' : commit.author,
    date: pullRequestNumber ? '' : commit.date,
    message: pullRequestNumber ? `PR #${pullRequestNumber}` : commit.subject,
  };
}

export type ChangeMaps = Record<FileSide, Map<string, ChangedFile>>;
export function changeMaps(files: readonly ChangedFile[]): ChangeMaps {
  const changes = { old: new Map<string, ChangedFile>(), new: new Map<string, ChangedFile>() };
  for (const file of files) {
    for (const side of ['old', 'new'] as const) {
      const { path, empty } = fileSide(file, side);
      // コピー元自身の変更がある場合は、その差分を優先する。
      if (!empty && (file.status !== 'C' || !changes[side].has(path))) {
        changes[side].set(path, file);
      }
    }
  }
  return changes;
}
