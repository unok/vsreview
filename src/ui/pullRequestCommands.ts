import * as vscode from 'vscode';
import { isPositiveInteger, isRecord } from '../core/validation';
import { isPullRequest, type PullRequest } from '../core/pullRequests';
import type { PullRequestSource } from '../git/gh';
import type { PullRequestsTree, PullRequestNode } from './pullRequests';
import type { PullRequestReviews } from './pullRequestReviews';
import type { ChangedFiles } from './repositories';
import type { ReviewDiff } from './diff';
import { orderedFiles } from './fileView';
import { errorMessage, showError, showInfo } from './common';

export class PullRequestCommands {
  constructor(
    private readonly tree: PullRequestsTree,
    private readonly changedFiles: ChangedFiles,
    private readonly source: PullRequestSource,
    private readonly reviews: PullRequestReviews,
  ) {}
  async open(node: unknown, diff: ReviewDiff): Promise<void> {
    if (!isPullRequestNode(node)) {
      return;
    }
    const generation = this.tree.revision;
    const target = await this.tree.target(node);
    const file = orderedFiles(await this.changedFiles.get(target.repo, target.commit), target.repo)[0];
    if (generation !== this.tree.revision) {
      return;
    }
    if (file) {
      await diff.openDiff({ ...target, file });
    } else {
      showInfo('この PR に変更ファイルはありません');
    }
    this.tree.opened(node.pullRequest.number);
  }
  async openNumber(diff: ReviewDiff): Promise<void> {
    const git = this.tree.repository;
    if (!git) {
      showInfo('リポジトリを選択してください');
      return;
    }
    const generation = this.tree.revision;
    const value = await vscode.window.showInputBox({
      title: 'PR 番号を入力して開く',
      prompt: 'PR 番号',
      validateInput: (value) => (isValidNumber(value) ? undefined : 'PR 番号は正の整数で入力してください'),
    });
    if (value === undefined || !isValidNumber(value) || generation !== this.tree.revision) {
      return;
    }
    let pullRequest: PullRequest;
    try {
      pullRequest = await this.source.gh(git.root).view(Number(value.trim()));
    } catch (error) {
      if (generation === this.tree.revision) {
        this.tree.view.message = errorMessage(error);
        showError(error);
      }
      return;
    }
    if (git !== this.tree.repository || generation !== this.tree.revision) {
      return;
    }
    this.tree.include(pullRequest);
    await this.open({ kind: 'pullRequest', repo: git.root, pullRequest }, diff);
    if (generation === this.tree.revision && git === this.tree.repository) {
      if (pullRequest.state !== 'OPEN') {
        showInfo('この PR は閉じられています');
      }
      this.reviews.rememberHead(git.root, pullRequest);
    }
  }
}
function isValidNumber(value: string): boolean {
  return /^\d+$/.test(value.trim()) && isPositiveInteger(Number(value));
}
export function isPullRequestNode(value: unknown): value is Extract<PullRequestNode, { kind: 'pullRequest' }> {
  return (
    isRecord(value) &&
    value.kind === 'pullRequest' &&
    typeof value.repo === 'string' &&
    isPullRequest(value.pullRequest)
  );
}
