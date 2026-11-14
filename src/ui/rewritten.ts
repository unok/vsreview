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
import { captureUncommittedChanges, type CaptureUncommitted } from '../git/uncommitted';
import { isUncommittedChanged } from '../core/uncommitted';
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
  private pending:
    { promise: Promise<void>; captureUncommitted: CaptureUncommitted; onlyIfChanged: boolean } | undefined;
  private notificationRequired = false;
  constructor(
    private readonly targets: () => Promise<readonly RewrittenTarget[]>,
    private readonly access: RepositoryAccess,
    private readonly pullRequestReviews: Pick<PullRequestReviews, 'latestHead'>,
    // 削除前の判定は取り直し、自動更新で注入された取得だけを共有する。
    private readonly captureUncommitted: CaptureUncommitted = captureUncommittedChanges,
  ) {}
  has = (comment: RewrittenTarget): boolean => this.keys.has(comparisonKey(comment));
  async refresh(
    options: { captureUncommitted?: CaptureUncommitted; onlyIfChanged?: boolean; roots?: ReadonlySet<string> } = {},
  ): Promise<void> {
    this.notificationRequired ||= !options.onlyIfChanged;
    const captureUncommitted = options.captureUncommitted ?? this.captureUncommitted;
    const onlyIfChanged = options.onlyIfChanged === true;
    let pending = {
      promise: this.refreshTargets(captureUncommitted, onlyIfChanged, options.roots),
      captureUncommitted,
      onlyIfChanged,
    };
    this.pending = pending;
    for (;;) {
      await pending.promise;
      if (this.pending === pending) {
        return;
      }
      pending = this.pending;
      if (
        (!options.captureUncommitted && pending.captureUncommitted !== this.captureUncommitted) ||
        (!onlyIfChanged && pending.onlyIfChanged)
      ) {
        pending = {
          promise: this.refreshTargets(captureUncommitted, onlyIfChanged, options.roots),
          captureUncommitted,
          onlyIfChanged,
        };
        this.pending = pending;
      }
    }
  }
  private async refreshTargets(
    captureUncommitted: CaptureUncommitted,
    onlyIfChanged: boolean,
    roots: ReadonlySet<string> | undefined,
  ): Promise<void> {
    const generation = ++this.generation;
    const targets = await this.targets();
    const keys = new Set<string>();
    await this.refreshUncommittedTargets(targets, keys, captureUncommitted, roots);
    for (const [key, comments] of groupBy(
      targets.filter((target) => !target.uncommitted),
      comparisonKey,
    )) {
      const comment = comments[0];
      if (!comment || !this.access.isKnown(comment.repoRoot)) {
        continue;
      }
      if (onlyIfChanged) {
        if (this.keys.has(key)) {
          keys.add(key);
        }
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
      const changed =
        this.notificationRequired || keys.size !== this.keys.size || [...keys].some((key) => !this.keys.has(key));
      this.keys = keys;
      if (changed) {
        this.notificationRequired = false;
        this.changed.fire();
      }
    }
  }
  private async refreshUncommittedTargets(
    targets: readonly RewrittenTarget[],
    keys: Set<string>,
    captureUncommitted: CaptureUncommitted,
    roots: ReadonlySet<string> | undefined,
  ): Promise<void> {
    const uncommitted = targets.filter((target) => target.uncommitted && this.access.isKnown(target.repoRoot));
    for (const [repo, saved] of groupBy(uncommitted, (target) => target.repoRoot)) {
      if (roots && !roots.has(repo)) {
        for (const target of saved) {
          const key = comparisonKey(target);
          if (this.keys.has(key)) {
            keys.add(key);
          }
        }
        continue;
      }
      try {
        const current = await captureUncommitted(this.access.client(repo));
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
