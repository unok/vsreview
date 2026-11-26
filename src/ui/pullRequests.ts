import { PULL_REQUEST_REOPEN, type PullRequest } from '../core/pullRequests';
import { PromiseCache } from '../core/collections';
import type { ReviewComment } from '../core/model';
import { pullRequestKey } from '../core/comparisons';
import { replaceDisplayControls } from '../core/presentation';
import { pullRequestLimitSetting } from './pullRequestSettings';
import * as vscode from 'vscode';
import type { PullRequestSource } from '../git/gh';
import type { PullRequestReviews } from './pullRequestReviews';
import { preparePullRequest } from '../git/pullRequests';
import type { GitClient } from '../git/client';
import type { CommitTarget } from '../core/documents';
import { displayedFileTree } from './fileView';
import { ChangedFileNodes, type ChangedFileNode, type ExplainedFile } from './changedFileNodes';
import type { ChangedFiles } from './repositories';
import { errorMessage, showError } from './common';

export type PullRequestNode = { kind: 'pullRequest'; repo: string; pullRequest: PullRequest } | ChangedFileNode;
export class PullRequestsTree implements vscode.TreeDataProvider<PullRequestNode>, vscode.Disposable {
  private readonly treeDataChanged = new vscode.EventEmitter<PullRequestNode | undefined>();
  readonly onDidChangeTreeData = this.treeDataChanged.event;
  private pullRequests: PullRequest[] = [];
  private parents = new WeakMap<PullRequestNode, PullRequestNode>();
  private targets = new PromiseCache<CommitTarget>();
  private readonly failures = new Map<number, string>();
  private collapse: vscode.Disposable | undefined;
  private generation = 0;
  private git: GitClient | undefined;
  private attachedView: vscode.TreeView<PullRequestNode> | undefined;
  private constructor(
    private readonly selection: { readonly git: GitClient | undefined },
    private readonly changedFiles: ChangedFiles,
    private readonly source: PullRequestSource,
    private readonly reviews: PullRequestReviews,
    comments: () => readonly ReviewComment[],
    explained?: ExplainedFile,
  ) {
    this.files = new ChangedFileNodes(comments, explained);
  }
  private readonly files: ChangedFileNodes;
  static register(
    selection: { readonly git: GitClient | undefined },
    changedFiles: ChangedFiles,
    options: {
      comments: () => readonly ReviewComment[];
      source: PullRequestSource;
      reviews: PullRequestReviews;
      explained?: ExplainedFile;
    },
  ): PullRequestsTree {
    const tree = new PullRequestsTree(
      selection,
      changedFiles,
      options.source,
      options.reviews,
      options.comments,
      options.explained,
    );
    tree.attachedView = vscode.window.createTreeView('vsreview.pullRequests', { treeDataProvider: tree });
    tree.collapse = tree.attachedView.onDidCollapseElement(({ element }) => {
      if (element.kind === 'pullRequest') {
        tree.failures.delete(element.pullRequest.number);
        tree.targets.delete(String(element.pullRequest.number));
      }
    });
    return tree;
  }
  get view(): vscode.TreeView<PullRequestNode> {
    if (!this.attachedView) {
      throw new Error('Pull Requests ビューが未登録です');
    }
    return this.attachedView;
  }
  rerender(): void {
    this.treeDataChanged.fire(undefined);
  }
  async reload(): Promise<void> {
    const generation = ++this.generation;
    const git = this.selection.git;
    this.git = git;
    await this.reviews.reset(git?.root);
    if (generation !== this.generation) {
      return;
    }
    this.failures.clear();
    this.targets.clear();
    this.parents = new WeakMap();
    this.pullRequests = [];
    this.view.message = git ? 'Pull Request を取得中…' : 'リポジトリを選択してください';
    this.rerender();
    if (!git) {
      return;
    }
    try {
      const pullRequests = await this.source.gh(git.root).list(pullRequestLimitSetting(git.root));
      if (generation !== this.generation) {
        return;
      }
      // 取得中の番号指定は一覧応答より新しいため、同じ番号も一覧外の PR も保持する。
      const included = new Set(this.pullRequests.map((pullRequest) => pullRequest.number));
      this.pullRequests = [
        ...this.pullRequests,
        ...pullRequests.filter((pullRequest) => !included.has(pullRequest.number)),
      ];
      const openPullRequests = this.pullRequests.filter((pullRequest) => pullRequest.state === 'OPEN');
      this.view.message = openPullRequests.length ? '' : '開いている Pull Request はありません';
      // 一覧はすぐ描画する。保存比較の head 収集は上限付き並列処理で後から通知する。
      void this.reviews.refreshHeads(git, openPullRequests).catch(showError);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.view.message = errorMessage(error);
    }
    this.rerender();
  }
  getTreeItem(node: PullRequestNode): vscode.TreeItem {
    if (node.kind !== 'pullRequest') {
      return this.files.getTreeItem(node);
    }
    const pullRequest = node.pullRequest;
    const item = new vscode.TreeItem(
      `#${pullRequest.number} ${replaceDisplayControls(pullRequest.title)}`,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = pullRequestKey(node.repo, pullRequest.number);
    item.description = `${replaceDisplayControls(pullRequest.baseRefName)} ← ${replaceDisplayControls(pullRequest.headRefName)} · ${replaceDisplayControls(pullRequest.author.login)}`;
    item.tooltip = `${pullRequest.url}\n更新: ${pullRequest.updatedAt}`;
    item.iconPath = new vscode.ThemeIcon('git-pull-request');
    item.contextValue = 'pullRequest';
    item.command = { command: 'vsreview.openPullRequest', title: 'PR の差分を開く', arguments: [node] };
    return item;
  }
  target(node: Extract<PullRequestNode, { kind: 'pullRequest' }>): Promise<CommitTarget> {
    const git = this.git;
    const current = this.pullRequests.find((pullRequest) => pullRequest.number === node.pullRequest.number);
    if (
      !git ||
      node.repo !== git.root ||
      !current ||
      current.headRefOid !== node.pullRequest.headRefOid ||
      current.baseRefOid !== node.pullRequest.baseRefOid
    ) {
      return Promise.reject(new Error(PULL_REQUEST_REOPEN));
    }
    const generation = this.generation;
    return this.targets.get(String(node.pullRequest.number), async () => {
      const target = await preparePullRequest(git, current, this.source.remote());
      if (generation !== this.generation || git !== this.selection.git) {
        throw new Error(PULL_REQUEST_REOPEN);
      }
      this.reviews.rememberReview(target, current);
      return target;
    });
  }

  getParent(node: PullRequestNode): PullRequestNode | undefined {
    return this.parents.get(node);
  }
  private children(nodes: PullRequestNode[], parent: PullRequestNode): PullRequestNode[] {
    for (const node of nodes) {
      this.parents.set(node, parent);
    }
    return nodes;
  }
  async getChildren(node?: PullRequestNode): Promise<PullRequestNode[]> {
    if (!node) {
      const git = this.git;
      return git
        ? this.pullRequests
            .filter((pullRequest) => pullRequest.state === 'OPEN')
            .map((pullRequest) => ({ kind: 'pullRequest', repo: git.root, pullRequest }))
        : [];
    }
    const generation = this.generation;
    if (node.repo !== this.git?.root) {
      return [];
    }
    if (node.kind === 'folder') {
      if (!this.parents.has(node)) {
        return [];
      }
      return this.children(this.files.fileNodes(node.folder.children, node), node);
    }
    if (node.kind !== 'pullRequest') {
      return [];
    }
    if (this.failures.has(node.pullRequest.number)) {
      return [];
    }
    try {
      const target = await this.target(node);
      const files = await this.changedFiles.get(target.repo, target.commit);
      if (generation !== this.generation) {
        return [];
      }
      this.view.message = '';
      return this.children(this.files.fileNodes(displayedFileTree(files, target.repo), target), node);
    } catch (error) {
      if (generation !== this.generation) {
        return [];
      }
      this.view.message = errorMessage(error);
      if (!this.failures.has(node.pullRequest.number)) {
        this.failures.set(node.pullRequest.number, errorMessage(error));
        showError(error);
      }
      return [];
    }
  }
  get repository(): GitClient | undefined {
    return this.git;
  }
  get revision(): number {
    return this.generation;
  }
  include(pullRequest: PullRequest): void {
    this.pullRequests = [pullRequest, ...this.pullRequests.filter((item) => item.number !== pullRequest.number)];
    this.targets.delete(String(pullRequest.number));
    this.failures.delete(pullRequest.number);
    this.view.message = '';
    this.rerender();
  }
  opened(number: number): void {
    this.failures.delete(number);
    this.view.message = '';
    this.rerender();
  }
  dispose(): void {
    this.generation++;
    this.treeDataChanged.dispose();
    this.collapse?.dispose();
    this.view.dispose();
  }
}
