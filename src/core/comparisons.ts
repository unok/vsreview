import type { ReviewComment } from './model';

export function comparisonKey(
  target:
    | {
        repo: string;
        commit: { hash: string };
        parent: string;
        pullRequest?: { number: number; mergeBase: string };
      }
    | {
        repoRoot: string;
        commit: string;
        parent?: string;
        pullRequest?: { number: number; mergeBase: string };
      },
): string {
  return JSON.stringify([
    'repo' in target ? target.repo : target.repoRoot,
    typeof target.commit === 'string' ? target.commit : target.commit.hash,
    target.pullRequest?.mergeBase ?? target.parent,
    target.pullRequest?.number,
  ]);
}

export function commitKey(comment: { repoRoot: string; commit: string }): string {
  return JSON.stringify([comment.repoRoot, comment.commit]);
}

export function reviewGroupKey(
  comment: { repoRoot: string; commit: string } & { pullRequest?: { number: number } },
): string {
  return comment.pullRequest ? pullRequestKey(comment.repoRoot, comment.pullRequest.number) : commitKey(comment);
}

export function commentGroupKey(comment: ReviewComment): string {
  // エクスポートの reviewGroupKey は変えず、Review Comments の表示区分を識別する。
  return comment.uncommitted
    ? JSON.stringify([comment.repoRoot, 'uncommitted', comment.uncommitted.kind])
    : reviewGroupKey(comment);
}

export function pullRequestKey(repo: string, number: number): string {
  return JSON.stringify([repo, 'pr', number]);
}
