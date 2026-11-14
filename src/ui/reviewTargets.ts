import { repoFile } from '../core/paths';
import * as vscode from 'vscode';
import type { DocumentRef } from '../core/documents';
import type { ReviewComment } from '../core/model';
import { comparisonKey } from '../core/comparisons';
import { revisionUri } from './revisions';
export interface OpenDiff {
  ref: DocumentRef;
  right: vscode.Uri;
  active: boolean;
}
export interface ResolveOptions {
  commit?: string | undefined;
  comparison?: Pick<ReviewComment, 'repoRoot' | 'commit' | 'parent' | 'pullRequest'> | undefined;
  diffs?: readonly OpenDiff[];
  lastActiveDiff?: string | undefined;
}
export function selectReviewTarget<T extends { ref: DocumentRef; active: boolean; previous?: boolean }>(
  targets: readonly T[],
  options: ResolveOptions,
): T | undefined {
  const hasPullRequest = targets.some(({ ref }) => ref.pullRequest);
  let target: T | undefined;
  // 同じ head の PR は merge-base が異なりうるため、比較の指定を commit より優先する。
  if (options.commit !== undefined && !(options.comparison && hasPullRequest)) {
    target = targets.find(({ ref }) => ref.commit.hash === options.commit);
  } else {
    target = targets.find(({ active }) => active);
    if (!target) {
      target = targets.find(
        (value) => value.previous ?? revisionUri(value.ref, 'old').toString() === options.lastActiveDiff,
      );
    }
    if (!target) {
      const unique = new Map(targets.map((value) => [revisionUri(value.ref, value.ref.side).toString(), value]));
      if (unique.size === 1) {
        target = unique.values().next().value;
      }
    }
  }
  return target && (!options.comparison || comparisonKey(target.ref) === comparisonKey(options.comparison))
    ? target
    : undefined;
}
export function isWorkingTreeUri(repo: string, path: string, uri: vscode.Uri): boolean {
  return uri.scheme === 'file' && !uri.query && vscode.Uri.file(repoFile(repo, path)).toString() === uri.toString();
}
