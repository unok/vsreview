import { isPullRequestComparisonFor, pullRequestComparison, type PullRequestComparison } from './pullRequests';
import { fileSide, type FileSide, isCommit, isChangedFile, type ChangedFile, type Commit } from './gitParsing';
import type { ReviewComment } from './model';
import { isUncommittedSnapshot, type UncommittedSnapshot } from './uncommitted';
import { uncommittedLabel } from './presentation';
import { isRecord, isRevision, isRepoPath } from './validation';
export interface CommitTarget {
  pullRequest?: PullRequestComparison;
  uncommitted?: UncommittedSnapshot;
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
    (value.uncommitted === undefined ||
      (value.pullRequest === undefined && isUncommittedSnapshot(value.uncommitted))) &&
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
    ...(target.uncommitted ? { uncommitted: snapshotMetadata(target.uncommitted) } : {}),
    parent: target.parent,
    // ツリーから開く場合と保存コメントから復元する場合で同じ URI を生成するため、表示に不要な本文・親一覧を正規化する。
    commit: canonicalCommit(target.commit, target.parent, target.pullRequest?.number, target.uncommitted),
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
    ...(comment.uncommitted ? { uncommitted: snapshotMetadata(comment.uncommitted) } : {}),
    parent: comment.parent,
    commit: canonicalCommit(
      { hash: comment.commit, subject: comment.subject, author: comment.author, date: comment.date },
      comment.parent,
      comment.pullRequest?.number,
      comment.uncommitted,
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
  uncommitted?: UncommittedSnapshot,
): Commit {
  const subject = uncommitted
    ? uncommittedLabel(uncommitted.kind)
    : pullRequestNumber
      ? `PR #${pullRequestNumber}`
      : commit.subject;
  return {
    hash: commit.hash,
    parents: [parent],
    subject,
    author: uncommitted || pullRequestNumber ? '' : commit.author,
    date: uncommitted ? uncommitted.createdAt : pullRequestNumber ? '' : commit.date,
    message: subject,
  };
}
function snapshotMetadata(snapshot: UncommittedSnapshot): UncommittedSnapshot {
  return {
    kind: snapshot.kind,
    ...(snapshot.head === undefined ? {} : { head: snapshot.head }),
    createdAt: snapshot.createdAt,
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
