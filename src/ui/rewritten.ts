import { detectPullRequestRewritten } from '../git/pullRequests';
import type { PullRequestReviews } from './pullRequestReviews';
import { comparisonKey } from '../core/comparisons';
import type { PullRequestComparison } from '../core/pullRequests';
import * as vscode from 'vscode';
import type { ReviewComment } from '../core/model';
import { groupBy } from '../core/collections';
import type { ReviewDocuments } from './documents';
import type { RepositoryAccess } from './repositories';
import { showError } from './common';
import { createUncommittedChanges } from '../git/uncommitted';
import { isUncommittedChanged, type UncommittedChanges } from '../core/uncommitted';
import type { GitClient } from '../git/client';
type CaptureUncommitted = (git: GitClient) => Promise<UncommittedChanges>;
export type RewrittenTarget = Pick<ReviewComment, 'repoRoot' | 'commit'> & {
  parent?: string;
  pullRequest?: PullRequestComparison;
  uncommitted?: ReviewComment['uncommitted'];
};
export async function rewrittenTargets(
  comments: readonly ReviewComment[],
  documents: ReviewDocuments,
): Promise<RewrittenTarget[]> {
  return [...comments, ...(await documents.openDiffTargets())];
}
export class RewrittenComments implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private generation = 0;
  private keys = new Set<string>();
  private pending: Promise<void> | undefined;
  constructor(
    private readonly targets: () => Promise<readonly RewrittenTarget[]>,
    private readonly access: RepositoryAccess,
    private readonly pullRequestReviews: Pick<PullRequestReviews, 'latestHead'>,
    // 削除前の判定を古くしないよう、CommitsTree の取得結果を再利用せず毎回取り直す。
    private readonly captureUncommitted: CaptureUncommitted = (git) =>
      createUncommittedChanges(git, new Date().toISOString()),
  ) {}
  has = (comment: RewrittenTarget): boolean => this.keys.has(comparisonKey(comment));
  async refresh(): Promise<void> {
    let pending = this.refreshTargets();
    this.pending = pending;
    for (;;) {
      await pending;
      if (this.pending === pending) {
        return;
      }
      pending = this.pending;
    }
  }
  private async refreshTargets(): Promise<void> {
    const generation = ++this.generation;
    const targets = await this.targets();
    const keys = new Set<string>();
    await this.refreshUncommittedTargets(targets, keys);
    for (const [key, comments] of groupBy(
      targets.filter((target) => !target.uncommitted),
      comparisonKey,
    )) {
      const comment = comments[0];
      if (!comment || !this.access.isKnown(comment.repoRoot)) {
        continue;
      }
      let rewritten = this.keys.has(key);
      try {
        const git = this.access.client(comment.repoRoot);
        if (comment.pullRequest) {
          const latest = this.pullRequestReviews.latestHead(comment.repoRoot, comment.pullRequest.number);
          rewritten = (await detectPullRequestRewritten(git, comment.pullRequest, latest)) ?? rewritten;
        } else {
          rewritten = !(await git.isReachable(comment.commit));
        }
      } catch (error) {
        // 通信・オブジェクト検査の失敗は書き換えの証拠にならないため、PR は前回の判定を保つ。
        if (!comment.pullRequest) {
          rewritten = false;
          showError(error);
        }
      }
      if (rewritten) {
        keys.add(key);
      }
    }
    if (generation === this.generation) {
      this.keys = keys;
      this.changed.fire();
    }
  }
  private async refreshUncommittedTargets(targets: readonly RewrittenTarget[], keys: Set<string>): Promise<void> {
    const uncommitted = targets.filter((target) => target.uncommitted && this.access.isKnown(target.repoRoot));
    for (const [repo, saved] of groupBy(uncommitted, (target) => target.repoRoot)) {
      try {
        const current = await this.captureUncommitted(this.access.client(repo));
        for (const target of saved) {
          if (
            target.uncommitted &&
            isUncommittedChanged({ commit: target.commit, uncommitted: target.uncommitted }, current)
          ) {
            keys.add(comparisonKey(target));
          }
        }
      } catch (error) {
        // 古い判定でコメントを削除しないよう、取得失敗時は変更済みのキーを加えない。
        showError(error);
      }
    }
  }
  dispose(): void {
    this.generation++;
    this.changed.dispose();
  }
}
