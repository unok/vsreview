import { repoFile } from '../core/paths';
import * as vscode from 'vscode';
import type { DocumentRef } from '../core/documents';
import type { ReviewComment } from '../core/model';
import { comparisonKey } from '../core/comparisons';
import { revisionUri } from './revisions';
import type { ReviewDocuments } from './documents';
export const NO_DIFF = '差分を開くと表示します';
export interface OpenDiff {
  ref: DocumentRef;
  right: vscode.Uri;
  active: boolean;
}
type ReviewDocumentResolver = Pick<ReviewDocuments, 'resolve' | 'isExpanded'>;

function activeDiffRef(diffs: readonly OpenDiff[]): DocumentRef | undefined {
  return diffs.find(({ active }) => active)?.ref;
}

function resolveReviewRef(
  documents: ReviewDocumentResolver,
  diffs: readonly OpenDiff[],
  uri: vscode.Uri | undefined,
): Promise<DocumentRef | undefined> | undefined {
  return uri && documents.resolve(uri, { diffs });
}

export async function resolveFilesRef(
  documents: ReviewDocumentResolver,
  diffs: readonly OpenDiff[],
): Promise<DocumentRef | undefined> {
  const uri = vscode.window.activeTextEditor?.document.uri;
  const resolution = resolveReviewRef(documents, diffs, uri);
  const active = resolution && (await resolution);
  const activeDiff = activeDiffRef(diffs);
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (
    active &&
    (diffs.some(({ ref }) => comparisonKey(ref) === comparisonKey(active)) ||
      (uri && (await documents.isExpanded(uri)))) &&
    (!activeDiff ||
      comparisonKey(activeDiff) === comparisonKey(active) ||
      (activeTab instanceof vscode.TabInputText && activeTab.uri.toString() === uri?.toString()))
  ) {
    return active;
  }
  return activeDiff;
}

export async function resolveExplanationRef(
  documents: ReviewDocumentResolver,
  diffs: readonly OpenDiff[],
): Promise<DocumentRef | undefined> {
  const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (tab && !(tab instanceof vscode.TabInputText)) {
    return tab instanceof vscode.TabInputTextDiff ? activeDiffRef(diffs) : undefined;
  }
  const uri = tab instanceof vscode.TabInputText ? tab.uri : vscode.window.activeTextEditor?.document.uri;
  const ref = await resolveReviewRef(documents, diffs, uri);
  // 作業ツリーの通常タブは、同じ URI が別の差分で開かれていても解説の対象にしない。
  return ref && uri && (uri.scheme === 'vsreview' || (await documents.isExpanded(uri))) ? ref : undefined;
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
